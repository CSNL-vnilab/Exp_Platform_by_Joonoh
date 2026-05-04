// Fire participant notification when a booking transitions to
// 'cancelled' or 'no_show'. Called fire-and-forget from
// PUT /api/bookings/[id] right after the status flip succeeds.
//
// Fail-soft: every error is caught + logged. We never let an SMTP / SMS
// failure flip the API response; the status change is the source of
// truth and the researcher already saw it in the UI.

import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/google/gmail";
import { sendSMS } from "@/lib/solapi/client";
import {
  buildCancellationEmail,
  buildCancellationSMS,
  buildNoShowEmail,
  buildNoShowSMS,
  type BookingStatusEmailInput,
} from "@/lib/services/booking-status-email";

type Supabase = ReturnType<typeof createAdminClient>;

// Injectable mailer/sms for tests (same pattern as payment-info-notify).
type Mailer = (opts: { to: string; subject: string; html: string }) =>
  Promise<{ success: boolean; messageId?: string; error?: string }>;
type Texter = (
  to: string,
  text: string,
) => Promise<{ success: boolean; error?: string }>;

export interface NotifyStatusResult {
  outcome:
    | "sent"
    | "no_recipient"
    | "send_failed"
    | "skipped_invalid_status"
    | "booking_not_found";
  bookingId: string;
  channel?: "email" | "email+sms";
  detail?: string;
}

const APP_ORIGIN = (() =>
  process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}`.replace(/\/$/, "") : "") ||
  null)();

export async function notifyBookingStatusChange(
  supabase: Supabase,
  bookingId: string,
  newStatus: "cancelled" | "no_show",
  mailer: Mailer = sendEmail,
  texter: Texter = sendSMS,
): Promise<NotifyStatusResult> {
  if (newStatus !== "cancelled" && newStatus !== "no_show") {
    return { outcome: "skipped_invalid_status", bookingId };
  }

  // Pull everything the templates need in one shot.
  const { data: row } = await supabase
    .from("bookings")
    .select(
      "id, slot_start, slot_end, session_number, booking_group_id, participant_id, experiment_id, participants(name, email, phone), experiments(id, title, experiment_mode, created_by)",
    )
    .eq("id", bookingId)
    .maybeSingle();

  const booking = row as unknown as
    | {
        id: string;
        slot_start: string;
        slot_end: string;
        session_number: number;
        booking_group_id: string | null;
        participant_id: string;
        experiment_id: string;
        participants: { name: string; email: string; phone: string } | null;
        experiments: {
          id: string;
          title: string;
          experiment_mode: "offline" | "online" | "hybrid";
          created_by: string | null;
        } | null;
      }
    | null;
  if (!booking) return { outcome: "booking_not_found", bookingId };

  const participant = booking.participants;
  const experiment = booking.experiments;
  if (!participant?.email || !experiment) {
    return { outcome: "no_recipient", bookingId };
  }

  // Researcher contact (best-effort — falls back through helper chain).
  let researcher: BookingStatusEmailInput["researcher"] = null;
  if (experiment.created_by) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("display_name, contact_email, email, phone")
      .eq("id", experiment.created_by)
      .maybeSingle();
    if (profile) {
      const p = profile as {
        display_name: string | null;
        contact_email: string | null;
        email: string | null;
        phone: string | null;
      };
      researcher = {
        display_name: p.display_name,
        contact_email: p.contact_email,
        email: p.email,
        phone: p.phone,
      };
    }
  }

  // Other still-confirmed sessions in the same group (multi-session
  // experiments). Empty for single-session bookings.
  let otherActiveSessions: BookingStatusEmailInput["otherActiveSessions"] = [];
  if (booking.booking_group_id) {
    const { data: siblings } = await supabase
      .from("bookings")
      .select("id, slot_start, session_number, status")
      .eq("booking_group_id", booking.booking_group_id)
      .neq("id", booking.id);
    otherActiveSessions = (siblings ?? [])
      .filter((s) => (s as { status: string }).status === "confirmed")
      .map((s) => {
        const r = s as { slot_start: string; session_number: number };
        return { slot_start: r.slot_start, session_number: r.session_number };
      })
      .sort((a, b) => new Date(a.slot_start).getTime() - new Date(b.slot_start).getTime());
  }

  const input: BookingStatusEmailInput = {
    participant: { name: participant.name, email: participant.email },
    booking: {
      id: booking.id,
      slot_start: booking.slot_start,
      slot_end: booking.slot_end,
      session_number: booking.session_number,
    },
    experiment: {
      id: experiment.id,
      title: experiment.title,
      experiment_mode: experiment.experiment_mode,
    },
    researcher,
    otherActiveSessions,
    appOrigin: APP_ORIGIN,
  };

  const built =
    newStatus === "cancelled"
      ? buildCancellationEmail(input)
      : buildNoShowEmail(input);

  const emailResult = await mailer({
    to: built.to,
    subject: built.subject,
    html: built.html,
  });

  // P0-Η: persist email outcome to booking_integrations as 'status_email'
  // so failures aren't silent. Migration 00053 added this enum value.
  // Use upsert with onConflict on (booking_id, integration_type) so a
  // re-trigger of the same status flip overwrites rather than duplicates.
  await writeStatusAudit(supabase, bookingId, "status_email", {
    success: emailResult.success,
    externalId: emailResult.messageId,
    error: emailResult.error,
  });

  if (!emailResult.success) {
    return {
      outcome: "send_failed",
      bookingId,
      channel: "email",
      detail: emailResult.error ?? "unknown",
    };
  }

  // SMS — only when SOLAPI is configured. Failure here doesn't fail the
  // overall notify (email already delivered).
  let channel: "email" | "email+sms" = "email";
  if (process.env.SOLAPI_API_KEY && process.env.SOLAPI_API_SECRET && participant.phone) {
    const text =
      newStatus === "cancelled"
        ? buildCancellationSMS(input)
        : buildNoShowSMS(input);
    try {
      const smsRes = await texter(participant.phone, text);
      if (smsRes.success) channel = "email+sms";
      else {
        console.warn(
          `[StatusNotify] SMS send failed for ${bookingId}: ${smsRes.error ?? "unknown"}`,
        );
      }
      // P0-Η: same audit as email side.
      await writeStatusAudit(supabase, bookingId, "status_sms", {
        success: smsRes.success,
        error: smsRes.error,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[StatusNotify] SMS threw for ${bookingId}: ${msg}`);
      await writeStatusAudit(supabase, bookingId, "status_sms", {
        success: false,
        error: msg,
      });
    }
  }

  return {
    outcome: "sent",
    bookingId,
    channel,
    detail: emailResult.messageId,
  };
}

// ── audit helper ────────────────────────────────────────────────────────
//
// Writes a booking_integrations row for status_email / status_sms. Upsert
// keyed on (booking_id, integration_type) — migration 00013 declared
// that pair UNIQUE — so a re-trigger of the same transition overwrites
// the previous attempt's outcome instead of leaving stale rows around.
//
// All errors swallowed: this is an audit row, not the source of truth
// for participant notification. The status flip already happened.
async function writeStatusAudit(
  supabase: Supabase,
  bookingId: string,
  type: "status_email" | "status_sms",
  result: { success: boolean; externalId?: string; error?: string },
): Promise<void> {
  try {
    // Bump attempts — read first since we don't have an UPDATE … = X+1
    // helper for Supabase JS at this layer.
    const { data: existing } = await supabase
      .from("booking_integrations")
      .select("attempts")
      .eq("booking_id", bookingId)
      .eq("integration_type", type)
      .maybeSingle();

    await supabase
      .from("booking_integrations")
      .upsert(
        {
          booking_id: bookingId,
          integration_type: type,
          status: result.success ? "completed" : "failed",
          attempts: ((existing as { attempts?: number } | null)?.attempts ?? 0) + 1,
          external_id: result.externalId ?? null,
          last_error: result.error?.slice(0, 500) ?? null,
          processed_at: new Date().toISOString(),
        },
        { onConflict: "booking_id,integration_type" },
      );
  } catch (err) {
    // Audit row failure is non-fatal — the status transition already
    // succeeded and the participant either got the email or didn't.
    console.warn(
      `[StatusNotify] audit row write failed for ${bookingId}/${type}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
