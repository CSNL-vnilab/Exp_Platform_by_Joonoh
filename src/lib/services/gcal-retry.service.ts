// GCal outbox retry service — D6 sprint.
//
// Uses the generic `claim_next_outbox_retry(['gcal'])` RPC (migration
// 00037) + `finalize_outbox_retry` for atomic state transitions under
// FOR UPDATE SKIP LOCKED, matching the notion-retry pattern.
//
// Dedup guard: if `bookings.google_event_id` is already set when we
// claim, a prior attempt (or the runtime pipeline) already wrote the
// event; flip to completed without double-creating.

import { createAdminClient } from "@/lib/supabase/admin";
import { createEvent } from "@/lib/google/calendar";
import { invalidateCalendarCache } from "@/lib/google/freebusy-cache";
import { fromInternalEmail } from "@/lib/auth/username";
import { escapeHtml } from "@/lib/utils/validation";

type Supabase = ReturnType<typeof createAdminClient>;

export interface GCalClaimedRow {
  id: string;
  booking_id: string;
  integration_type: "gcal";
  attempts: number;
}

export interface GCalRetryOutcome {
  booking_id: string;
  attempts: number;
  ok: boolean;
  external_id?: string | null;
  error?: string | null;
  skipped_reason?: string;
}

// NOTE: claim is owned by /api/cron/outbox-retry, which calls the generic
// RPC with the full allowlist in one pass. We expose GCalClaimedRow +
// runGCalRetry here; callers that need to claim a gcal row in isolation
// should go through that route, not re-invent a per-type claim helper.

function creatorInitial(creator: {
  email: string;
  display_name: string | null;
} | null): string {
  if (!creator) return "???";
  const local = fromInternalEmail(creator.email);
  if (local) return local.toUpperCase().slice(0, 4);
  const [beforeAt] = creator.email.split("@");
  if (beforeAt) return beforeAt.toUpperCase().slice(0, 4);
  return (creator.display_name ?? "???").toUpperCase().slice(0, 4);
}

function formatKrPhone(raw: string): string {
  const d = raw.replace(/\D/g, "");
  if (d.length === 11) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  return raw;
}

export async function runGCalRetry(
  supabase: Supabase,
  claim: GCalClaimedRow,
): Promise<GCalRetryOutcome> {
  const base = { booking_id: claim.booking_id, attempts: claim.attempts };

  const { data: booking } = await supabase
    .from("bookings")
    .select(
      "id, slot_start, slot_end, session_number, subject_number, google_event_id, participants(name, phone, email), experiments(title, project_name, google_calendar_id, created_by)",
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
    google_event_id: string | null;
    participants: { name: string; phone: string; email: string } | null;
    experiments: {
      title: string;
      project_name: string | null;
      google_calendar_id: string | null;
      created_by: string | null;
    } | null;
  };

  // Dedup — if an event was already created (by another cron or runtime
  // pipeline), record and exit. Avoids double-creating a calendar event.
  //
  // A second layer of dedup comes from the idempotencyKey=row.id passed
  // to createEvent below: if the runtime pipeline wrote google_event_id
  // AFTER our SELECT, Google returns 409 on insert and we recover the
  // deterministic id, so no duplicate event ends up on the calendar
  // even in the race window.
  if (row.google_event_id) {
    await finalize(supabase, claim.id, "completed", row.google_event_id, null);
    return { ...base, ok: true, external_id: row.google_event_id };
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

  const calendarId = (
    experiment.google_calendar_id || process.env.GOOGLE_CALENDAR_ID || ""
  ).trim();
  if (!calendarId) {
    await finalize(supabase, claim.id, "skipped", null, "no calendar_id configured");
    return { ...base, ok: false, skipped_reason: "no_calendar_id" };
  }

  // Creator lookup for the [INIT] prefix on the event title.
  let creator: { email: string; display_name: string | null } | null = null;
  if (experiment.created_by) {
    const { data: prof } = await supabase
      .from("profiles")
      .select("email, display_name")
      .eq("id", experiment.created_by)
      .maybeSingle();
    creator = (prof as { email: string; display_name: string | null } | null) ?? null;
  }

  const initial = creatorInitial(creator);
  const projectName = experiment.project_name?.trim() || experiment.title;
  const sbj = row.subject_number ?? 0;
  const day = row.session_number ?? 1;

  try {
    const eventId = await createEvent(calendarId, {
      summary: `[${initial}] ${projectName}/Sbj ${sbj}/Day ${day}`,
      description: [
        `예약자: ${escapeHtml(participant.name)}`,
        `이메일: ${participant.email}`,
        `전화번호: ${formatKrPhone(participant.phone)}`,
        `회차: ${day}회차`,
      ].join("\n"),
      start: new Date(row.slot_start),
      end: new Date(row.slot_end),
      // Same idempotency key the runtime pipeline uses, so a retry after a
      // lost response collapses onto the existing event (409 → return id)
      // rather than creating a duplicate. Closes the race previously
      // called out as an "accepted tradeoff" in the comment above.
      idempotencyKey: row.id,
    });

    // Race guard — only write if still null, so a concurrent runtime
    // first-attempt win doesn't get clobbered by our retry outcome.
    await supabase
      .from("bookings")
      .update({ google_event_id: eventId })
      .eq("id", claim.booking_id)
      .is("google_event_id", null);

    await finalize(supabase, claim.id, "completed", eventId, null);
    await invalidateCalendarCache(calendarId).catch(() => {});
    return { ...base, ok: true, external_id: eventId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await finalize(supabase, claim.id, "failed", null, scrubPii(msg).slice(0, 500));
    return { ...base, ok: false, error: msg };
  }
}

async function finalize(
  supabase: Supabase,
  integrationId: string,
  status: "completed" | "failed" | "skipped",
  externalId: string | null,
  lastError: string | null,
): Promise<void> {
  const { error } = await supabase.rpc("finalize_outbox_retry", {
    p_integration_id: integrationId,
    p_status: status,
    p_external_id: externalId,
    p_last_error: lastError,
  });
  if (error) {
    console.error("[GCalRetry] finalize rpc failed:", error.message);
  }
}

// Google Calendar API error messages sometimes embed the participant's
// email/phone that we pasted into the event body; scrub before persisting.
function scrubPii(msg: string): string {
  return msg
    .replace(/\b[\w._%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, "<email>")
    .replace(/\b\d{2,3}-?\d{3,4}-?\d{4}\b/g, "<phone>");
}
