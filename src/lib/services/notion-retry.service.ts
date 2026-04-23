// Notion outbox retry service — race-safe version.
//
// Review fixes D1/C1 + D1/H1-H3 + D1/O2:
//   * `claim_next_notion_retry()` (migration 00032) is the ONLY writer of
//     `attempts` in this path — it atomically bumps once per claim under
//     FOR UPDATE SKIP LOCKED, so overlapping cron invocations can't
//     double-POST to Notion or double-count attempts.
//   * The pipelines below treat a claimed row as "owned"; they never
//     bump attempts again. Finalize writes only status / external_id /
//     last_error via `finalize_notion_retry()`.
//   * The observation retry path calls `syncObservationToNotion` with
//     `skipOutboxMark=true` so that service's internal markNotionSurvey
//     doesn't fight our finalize write.

import { createAdminClient } from "@/lib/supabase/admin";
import { createBookingPage } from "@/lib/notion/client";
import { syncObservationToNotion } from "@/lib/services/observation.service";

type Supabase = ReturnType<typeof createAdminClient>;

export interface ClaimedRow {
  id: string;
  booking_id: string;
  integration_type: "notion" | "notion_survey";
  attempts: number;
}

export interface RetryOutcome {
  booking_id: string;
  integration_type: string;
  attempts: number;
  ok: boolean;
  external_id?: string | null;
  error?: string | null;
}

// Grab the oldest eligible row atomically. Returns null when there's
// nothing to do right now (either empty queue or all remaining rows are
// still inside their backoff window).
export async function claimNextRetry(
  supabase: Supabase,
): Promise<ClaimedRow | null> {
  const { data, error } = await supabase.rpc("claim_next_notion_retry");
  if (error) {
    console.error("[NotionRetry] claim rpc failed:", error.message);
    return null;
  }
  const rows = (data ?? []) as ClaimedRow[];
  return rows[0] ?? null;
}

// Retry the per-booking Notion page creation. Only called when a row has
// already been claimed (so we can trust the caller's attempts count).
export async function runBookingNotionRetry(
  supabase: Supabase,
  claim: ClaimedRow,
): Promise<RetryOutcome> {
  const base = {
    booking_id: claim.booking_id,
    integration_type: claim.integration_type,
    attempts: claim.attempts,
  };

  if (!process.env.NOTION_API_KEY || !process.env.NOTION_DATABASE_ID) {
    await finalize(supabase, claim.id, "skipped", null, "NOTION_API_KEY absent");
    return { ...base, ok: false, error: "notion_not_configured" };
  }

  const { data: booking } = await supabase
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
        "experiment_id",
        "participants(name, phone, email)",
        "experiments(title, project_name, participation_fee, lab_id)",
      ].join(", "),
    )
    .eq("id", claim.booking_id)
    .maybeSingle();

  if (!booking) {
    await finalize(supabase, claim.id, "failed", null, "booking not found");
    return { ...base, ok: false, error: "booking_not_found" };
  }

  const row = booking as unknown as {
    id: string;
    slot_start: string;
    slot_end: string;
    session_number: number;
    subject_number: number | null;
    notion_page_id: string | null;
    participant_id: string;
    experiment_id: string;
    participants: { name: string; phone: string; email: string } | null;
    experiments: {
      title: string;
      project_name: string | null;
      participation_fee: number;
      lab_id: string;
    } | null;
  };

  // O2 fix — a concurrent pipeline may have written notion_page_id since
  // the claim. Bail out and flip to completed without creating a duplicate.
  if (row.notion_page_id) {
    await finalize(supabase, claim.id, "completed", row.notion_page_id, null);
    return { ...base, ok: true, external_id: row.notion_page_id };
  }

  const participant = row.participants;
  const experiment = row.experiments;
  if (!participant || !experiment) {
    await finalize(
      supabase,
      claim.id,
      "failed",
      null,
      "participant or experiment missing",
    );
    return { ...base, ok: false, error: "join_missing" };
  }

  // Public code (may be absent if identity backfill never ran).
  let publicCode: string | null = null;
  if (experiment.lab_id) {
    const { data: identity } = await supabase
      .from("participant_lab_identity")
      .select("public_code")
      .eq("participant_id", row.participant_id)
      .eq("lab_id", experiment.lab_id)
      .maybeSingle();
    publicCode = identity?.public_code ?? null;
  }

  try {
    const pageId = await createBookingPage({
      experimentTitle: experiment.title,
      projectName: experiment.project_name ?? null,
      subjectNumber: row.subject_number ?? null,
      sessionNumber: row.session_number ?? 1,
      sessionDateIso: row.slot_start,
      slotStartIso: row.slot_start,
      slotEndIso: row.slot_end,
      participantName: participant.name,
      phone: participant.phone,
      email: participant.email,
      status: "확정",
      fee: experiment.participation_fee,
      researcherName: null,
      publicCode,
    });

    // O2 — guard the update with `notion_page_id IS NULL` so a concurrent
    // first-attempt write doesn't get overwritten by our retry result.
    await supabase
      .from("bookings")
      .update({ notion_page_id: pageId })
      .eq("id", claim.booking_id)
      .is("notion_page_id", null);

    await finalize(supabase, claim.id, "completed", pageId, null);
    return { ...base, ok: true, external_id: pageId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const scrubbed = scrubPii(msg);
    await finalize(supabase, claim.id, "failed", null, scrubbed.slice(0, 500));
    return { ...base, ok: false, error: msg };
  }
}

// Retry the observation PATCH. Delegates to the existing service but
// passes `skipOutboxMark:true` so THIS function owns the outbox write.
export async function runObservationNotionRetry(
  supabase: Supabase,
  claim: ClaimedRow,
): Promise<RetryOutcome> {
  const base = {
    booking_id: claim.booking_id,
    integration_type: claim.integration_type,
    attempts: claim.attempts,
  };

  const result = await syncObservationToNotion(claim.booking_id, {
    skipOutboxMark: true,
  });

  if (result.ok) {
    await finalize(
      supabase,
      claim.id,
      result.skipped ? "skipped" : "completed",
      result.notionPageId ?? null,
      null,
    );
    return { ...base, ok: true, external_id: result.notionPageId ?? null };
  }

  const scrubbed = scrubPii(result.error ?? "unknown error");
  await finalize(supabase, claim.id, "failed", null, scrubbed.slice(0, 500));
  return { ...base, ok: false, error: result.error };
}

async function finalize(
  supabase: Supabase,
  integrationId: string,
  status: "completed" | "failed" | "skipped",
  externalId: string | null,
  lastError: string | null,
): Promise<void> {
  const { error } = await supabase.rpc("finalize_notion_retry", {
    p_integration_id: integrationId,
    p_status: status,
    p_external_id: externalId,
    p_last_error: lastError,
  });
  if (error) {
    console.error("[NotionRetry] finalize rpc failed:", error.message);
  }
}

// Notion sometimes echoes the offending property value in 400 responses
// (e.g. "property 전화번호 has value 010-1234-5678 that does not match…").
// Scrub patterns that could be PII before writing to booking_integrations.
function scrubPii(msg: string): string {
  return msg
    .replace(/\b[\w._%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, "<email>")
    .replace(/\b\d{2,3}-?\d{3,4}-?\d{4}\b/g, "<phone>");
}
