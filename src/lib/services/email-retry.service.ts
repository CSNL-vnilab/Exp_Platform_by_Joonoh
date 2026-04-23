// Email outbox retry service — D6 sprint.
//
// Re-sends the booking confirmation email when the first-attempt send
// failed (Gmail 429 / greylisting / transient network). Uses the
// extracted `buildConfirmationEmail` template so the retry email mirrors
// what the runtime pipeline would have sent, minus runLinks and
// paymentLink.
//
// Why omit runLinks / paymentLink: those carry one-time HMAC tokens. The
// runtime path issues them fresh and stores a token hash; re-issuing on
// retry would replace the DB hash and invalidate whatever (if anything)
// the participant already received. For the retry case — where by
// definition the first-attempt email failed to deliver — the simpler
// contract is: ship the essentials (date/time/location/precautions) and
// let the researcher follow up separately if the experiment needs the
// run/payment link. A `preface` note in the email makes the context
// explicit.

import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/google/gmail";
import { buildConfirmationEmail } from "@/lib/services/booking-email-template";

type Supabase = ReturnType<typeof createAdminClient>;

export interface EmailClaimedRow {
  id: string;
  booking_id: string;
  integration_type: "email";
  attempts: number;
}

export interface EmailRetryOutcome {
  booking_id: string;
  attempts: number;
  ok: boolean;
  external_id?: string | null;
  error?: string | null;
  skipped_reason?: string;
}

export async function runEmailRetry(
  supabase: Supabase,
  claim: EmailClaimedRow,
): Promise<EmailRetryOutcome> {
  const base = { booking_id: claim.booking_id, attempts: claim.attempts };

  // Fetch the full booking context. Use the same shape runEmail needs
  // minus run/payment tokens.
  const { data: booking } = await supabase
    .from("bookings")
    .select(
      "id, slot_start, slot_end, session_number, booking_group_id, participants(name, email), experiments(title, participation_fee, experiment_mode, precautions, location_id, created_by)",
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
    booking_group_id: string | null;
    participants: { name: string; email: string } | null;
    experiments: {
      title: string;
      participation_fee: number;
      experiment_mode: "offline" | "online" | "hybrid";
      precautions: Array<{ question: string; required_answer: boolean }> | null;
      location_id: string | null;
      created_by: string | null;
    } | null;
  };

  if (!row.participants || !row.experiments) {
    await finalize(supabase, claim.id, "failed", null, "join_missing");
    return { ...base, ok: false, error: "join_missing" };
  }

  // If this booking is part of a multi-session group, fetch the siblings
  // so the email shows the full schedule. Multi-session participants
  // expect to see all their sessions in one confirmation email.
  let siblingRows: Array<{
    id: string;
    slot_start: string;
    slot_end: string;
    session_number: number;
  }> = [
    {
      id: row.id,
      slot_start: row.slot_start,
      slot_end: row.slot_end,
      session_number: row.session_number,
    },
  ];
  if (row.booking_group_id) {
    const { data: siblings } = await supabase
      .from("bookings")
      .select("id, slot_start, slot_end, session_number")
      .eq("booking_group_id", row.booking_group_id)
      .order("session_number", { ascending: true });
    if (siblings && siblings.length > 0) {
      siblingRows = siblings as unknown as typeof siblingRows;
    }
  }

  // Creator lookup for CC + footer.
  let creator: {
    email: string;
    display_name: string | null;
    phone: string | null;
    contact_email: string | null;
  } | null = null;
  if (row.experiments.created_by) {
    const { data: prof } = await supabase
      .from("profiles")
      .select("email, display_name, phone, contact_email")
      .eq("id", row.experiments.created_by)
      .maybeSingle();
    creator =
      (prof as {
        email: string;
        display_name: string | null;
        phone: string | null;
        contact_email: string | null;
      } | null) ?? null;
  }

  // Location (experiment_locations).
  let location: { name: string; address_lines: string[]; naver_url: string | null } | null = null;
  if (row.experiments.location_id) {
    const { data: loc } = await supabase
      .from("experiment_locations")
      .select("name, address_lines, naver_url")
      .eq("id", row.experiments.location_id)
      .maybeSingle();
    location =
      (loc as unknown as { name: string; address_lines: string[]; naver_url: string | null } | null) ?? null;
  }

  const built = buildConfirmationEmail({
    participant: row.participants,
    experiment: {
      title: row.experiments.title,
      participation_fee: row.experiments.participation_fee,
      experiment_mode: row.experiments.experiment_mode,
      precautions: row.experiments.precautions,
    },
    rows: siblingRows,
    creator,
    location,
    // runLinks / paymentLink intentionally omitted — see file header.
    preface: "이전에 발송한 예약 확인 메일이 전달되지 않아 다시 보내드립니다. 실험 참여 링크나 정산 정보 입력 링크가 필요하시면 담당 연구원에게 문의해 주세요.",
  });

  try {
    const result = await sendEmail({
      to: built.to,
      cc: built.cc,
      subject: built.subject,
      html: built.html,
    });
    if (result.success) {
      await finalize(supabase, claim.id, "completed", result.messageId ?? null, null);
      return { ...base, ok: true, external_id: result.messageId ?? null };
    }
    const msg = result.error ?? "email_failed";
    await finalize(supabase, claim.id, "failed", null, scrubPii(msg).slice(0, 500));
    return { ...base, ok: false, error: msg };
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
    console.error("[EmailRetry] finalize rpc failed:", error.message);
  }
}

// Gmail error responses sometimes echo the envelope address or parts of
// the message. Strip email and Korean phone patterns before persisting.
function scrubPii(msg: string): string {
  return msg
    .replace(/\b[\w._%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, "<email>")
    .replace(/\b\d{2,3}-?\d{3,4}-?\d{4}\b/g, "<phone>");
}
