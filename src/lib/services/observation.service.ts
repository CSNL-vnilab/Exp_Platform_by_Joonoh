// Observation → Notion sync. Called from the PUT
// /api/bookings/[bookingId]/observation route after a successful
// submit_booking_observation RPC, and reusable by a future retry worker.
//
// Contract:
//   * Resolves the booking + observation + participant's lab-scoped public
//     code via the admin client (bypassing RLS — the caller already gated
//     access at the HTTP layer).
//   * PATCHes the existing booking Notion page when one exists. Otherwise
//     creates a fresh page. Both paths persist the returned Notion page id
//     onto booking_observations.notion_page_id.
//   * Marks booking_integrations.notion_survey = completed/failed/skipped
//     so retries/observability can key off the same outbox pattern the rest
//     of the post-booking pipeline uses.
//   * Never throws to the caller — all failures are captured in the return
//     value and mirrored to booking_integrations.last_error.
//
// PII note: we only ever ship the lab-scoped public_code (e.g. "CSNL-A4F2B1")
// to Notion through the observation columns. The booking page row still
// carries the participant's name in the 참여자 column (existing behaviour,
// preserved for researcher ergonomics), but the new 공개 ID column is the
// one teams should use for any external sharing.

import { createAdminClient } from "@/lib/supabase/admin";
import { upsertObservationPage } from "@/lib/notion/client";

type Supabase = ReturnType<typeof createAdminClient>;

interface SyncResult {
  ok: boolean;
  notionPageId?: string;
  error?: string;
  skipped?: boolean;
}

export async function syncObservationToNotion(
  bookingId: string,
  options: { skipOutboxMark?: boolean } = {},
): Promise<SyncResult> {
  const supabase = createAdminClient();
  // `skipOutboxMark` is set by the retry worker. The worker atomically
  // claimed the row (bumping `attempts` once) via `claim_next_notion_retry`
  // and will call `finalize_notion_retry` with the final status itself —
  // so the internal markNotionSurvey calls here would double-count
  // attempts and fight the worker's writes. See D1 review H1+H3.
  const mark = async (patch: Parameters<typeof markNotionSurvey>[2]) => {
    if (options.skipOutboxMark) return;
    await markNotionSurvey(supabase, bookingId, patch);
  };

  // Short-circuit when Notion isn't configured. Mark the outbox row as
  // skipped so retry workers don't churn on it.
  if (!process.env.NOTION_API_KEY || !process.env.NOTION_DATABASE_ID) {
    await mark({ status: "skipped" });
    return { ok: true, skipped: true };
  }

  // Pull everything we need in a single join. We deliberately DON'T select
  // participant.email/phone — those aren't needed for the observation sync
  // and keeping them out of the service surface area reduces PII exposure.
  const { data, error } = await supabase
    .from("bookings")
    .select(
      [
        "id",
        "slot_start",
        "slot_end",
        "session_number",
        "subject_number",
        "notion_page_id",
        "participant_id",
        "participants(name)",
        "experiments(title, project_name, lab_id, created_by)",
        "booking_observations(pre_survey_done, pre_survey_info, post_survey_done, post_survey_info, notable_observations, notion_page_id)",
      ].join(", "),
    )
    .eq("id", bookingId)
    .maybeSingle();

  if (error || !data) {
    const msg = error?.message ?? "booking not found";
    await mark({ status: "failed", last_error: msg.slice(0, 500) });
    return { ok: false, error: msg };
  }

  const row = data as unknown as {
    id: string;
    slot_start: string;
    slot_end: string;
    session_number: number;
    subject_number: number | null;
    notion_page_id: string | null;
    participant_id: string;
    participants: { name: string } | null;
    experiments: {
      title: string;
      project_name: string | null;
      lab_id: string;
      created_by: string | null;
    } | null;
    booking_observations:
      | {
          pre_survey_done: boolean;
          pre_survey_info: string | null;
          post_survey_done: boolean;
          post_survey_info: string | null;
          notable_observations: string | null;
          notion_page_id: string | null;
        }
      | null;
  };

  const observation = row.booking_observations;
  if (!observation) {
    const msg = "observation row missing";
    await mark({ status: "failed", last_error: msg });
    return { ok: false, error: msg };
  }

  const experiment = row.experiments;
  if (!experiment) {
    const msg = "experiment missing";
    await mark({ status: "failed", last_error: msg });
    return { ok: false, error: msg };
  }

  // Lab-scoped public code (Stream B). Absent if ensureParticipantLabIdentity
  // hasn't run for this (participant, lab) pair yet — we treat that as a
  // soft state and push a blank string into the 공개 ID column.
  let publicCode: string | null = null;
  const { data: identity } = await supabase
    .from("participant_lab_identity")
    .select("public_code")
    .eq("participant_id", row.participant_id)
    .eq("lab_id", experiment.lab_id)
    .maybeSingle();
  if (identity?.public_code) publicCode = identity.public_code;

  // Researcher display name (best-effort). Notion never receives the
  // researcher's login email — only their display name ends up on the page.
  let researcherName: string | null = null;
  if (experiment.created_by) {
    const { data: prof } = await supabase
      .from("profiles")
      .select("display_name")
      .eq("id", experiment.created_by)
      .maybeSingle();
    researcherName = prof?.display_name ?? null;
  }

  // Prefer the Notion page id we've already stored on the observation row
  // (for retries); otherwise fall back to the one booking.notion_page_id
  // (set by createBookingPage during post-booking pipeline).
  const existingPageId =
    observation.notion_page_id ?? row.notion_page_id ?? null;

  try {
    const pageId = await upsertObservationPage({
      experimentTitle: experiment.title,
      projectName: experiment.project_name,
      publicCode,
      subjectNumber: row.subject_number,
      sessionNumber: row.session_number,
      sessionDateIso: row.slot_start,
      slotStartIso: row.slot_start,
      slotEndIso: row.slot_end,
      preSurveyDone: observation.pre_survey_done,
      preSurveyInfo: observation.pre_survey_info,
      postSurveyDone: observation.post_survey_done,
      postSurveyInfo: observation.post_survey_info,
      notableObservations: observation.notable_observations,
      researcherName,
      bookingNotionPageId: existingPageId,
    });

    await supabase
      .from("booking_observations")
      .update({
        notion_page_id: pageId,
        notion_synced_at: new Date().toISOString(),
      })
      .eq("booking_id", bookingId);

    await mark({ status: "completed", external_id: pageId });

    return { ok: true, notionPageId: pageId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Scrub common PII patterns from Notion errors before they land in
    // booking_integrations.last_error. Notion sometimes echoes the
    // offending property value in 400 responses (reviewer finding O4).
    const scrubbed = msg
      .replace(/\b[\w._%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, "<email>")
      .replace(/\b\d{2,3}-?\d{3,4}-?\d{4}\b/g, "<phone>");
    await mark({ status: "failed", last_error: scrubbed.slice(0, 500) });
    return { ok: false, error: msg };
  }
}

// booking_integrations upsert helper scoped to notion_survey. Mirrors the
// markIntegration() pattern from booking.service.ts; kept private here so
// the rest of the codebase goes through syncObservationToNotion.
async function markNotionSurvey(
  supabase: Supabase,
  bookingId: string,
  patch: {
    status: "completed" | "failed" | "skipped";
    external_id?: string;
    last_error?: string;
  },
): Promise<void> {
  // Upsert the row (it may not exist yet — observations run long after the
  // post-booking pipeline, and we don't want a missing outbox row to
  // swallow an otherwise-successful sync).
  const { data: existing } = await supabase
    .from("booking_integrations")
    .select("id, attempts")
    .eq("booking_id", bookingId)
    .eq("integration_type", "notion_survey")
    .maybeSingle();

  if (existing) {
    await supabase
      .from("booking_integrations")
      .update({
        status: patch.status,
        attempts: (existing.attempts ?? 0) + 1,
        external_id: patch.external_id ?? null,
        last_error: patch.last_error ?? null,
        processed_at: new Date().toISOString(),
      })
      .eq("id", existing.id);
  } else {
    await supabase.from("booking_integrations").insert({
      booking_id: bookingId,
      integration_type: "notion_survey",
      status: patch.status,
      attempts: 1,
      external_id: patch.external_id ?? null,
      last_error: patch.last_error ?? null,
      processed_at: new Date().toISOString(),
    });
  }
}
