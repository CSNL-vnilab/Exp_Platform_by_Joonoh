// SMS outbox retry service — D6 sprint.
//
// Replays the booking-confirmation SMS for rows that failed their first
// attempt. Keeps the same claim → finalize pattern as the notion-retry
// service and 00037 RPC semantics.
//
// Dedup guard: every `booking_integrations` row has its own claim; SMS
// has no cross-row primary-key beyond (booking_id, integration_type),
// and Solapi is idempotent enough on the human side that duplicate
// sends are a nuisance but not catastrophic. We still finalize on
// success so repeated crons won't re-send.

import { createAdminClient } from "@/lib/supabase/admin";
import { sendSMS } from "@/lib/solapi/client";
import { formatDateKR, formatTimeKR } from "@/lib/utils/date";
import { BRAND_NAME, brandContactEmailOrNull } from "@/lib/branding";

type Supabase = ReturnType<typeof createAdminClient>;

export interface SMSClaimedRow {
  id: string;
  booking_id: string;
  integration_type: "sms";
  attempts: number;
}

export interface SMSRetryOutcome {
  booking_id: string;
  attempts: number;
  ok: boolean;
  error?: string | null;
  skipped_reason?: string;
}

// Claim is owned by /api/cron/outbox-retry (unified dispatch). This module
// exposes the run function + the row shape, never a per-type claimNext.

export async function runSMSRetry(
  supabase: Supabase,
  claim: SMSClaimedRow,
): Promise<SMSRetryOutcome> {
  const base = { booking_id: claim.booking_id, attempts: claim.attempts };

  if (!process.env.SOLAPI_API_KEY || !process.env.SOLAPI_API_SECRET) {
    await finalize(supabase, claim.id, "skipped", "sms_not_configured");
    return { ...base, ok: false, skipped_reason: "sms_not_configured" };
  }

  const { data: booking } = await supabase
    .from("bookings")
    .select(
      "id, slot_start, participants(name, phone), experiments(title)",
    )
    .eq("id", claim.booking_id)
    .maybeSingle();

  if (!booking) {
    await finalize(supabase, claim.id, "failed", "booking_not_found");
    return { ...base, ok: false, error: "booking_not_found" };
  }

  const row = booking as unknown as {
    id: string;
    slot_start: string;
    participants: { name: string; phone: string } | null;
    experiments: { title: string } | null;
  };

  if (!row.participants || !row.experiments) {
    await finalize(supabase, claim.id, "failed", "join_missing");
    return { ...base, ok: false, error: "join_missing" };
  }

  const labContact = brandContactEmailOrNull();
  const inquirySuffix = labContact ? `\n문의: ${labContact}` : "";
  const text = `[${BRAND_NAME}] 예약확정\n${row.participants.name}님, "${row.experiments.title}" 실험이 예약되었습니다.\n일시: ${formatDateKR(row.slot_start)} ${formatTimeKR(row.slot_start)}${inquirySuffix}`;

  try {
    // B2 fix — sendSMS returns {success: false, error} on 4xx instead of
    // throwing. Earlier versions of this retry finalized "completed"
    // unconditionally, which silently masked Solapi quota/auth failures.
    const res = await sendSMS(row.participants.phone, text);
    if (!res.success) {
      const msg = res.error ?? "sms_failed";
      await finalize(supabase, claim.id, "failed", scrubPii(msg).slice(0, 500));
      return { ...base, ok: false, error: msg };
    }
    await finalize(supabase, claim.id, "completed", null);
    return { ...base, ok: true };
  } catch (err) {
    // Network-level reject — sendSMS only throws on fetch failure.
    const msg = err instanceof Error ? err.message : String(err);
    await finalize(supabase, claim.id, "failed", scrubPii(msg).slice(0, 500));
    return { ...base, ok: false, error: msg };
  }
}

async function finalize(
  supabase: Supabase,
  integrationId: string,
  status: "completed" | "failed" | "skipped",
  lastError: string | null,
): Promise<void> {
  const { error } = await supabase.rpc("finalize_outbox_retry", {
    p_integration_id: integrationId,
    p_status: status,
    p_external_id: null,
    p_last_error: lastError,
  });
  if (error) {
    console.error("[SMSRetry] finalize rpc failed:", error.message);
  }
}

function scrubPii(msg: string): string {
  return msg
    .replace(/\b[\w._%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, "<email>")
    .replace(/\b\d{2,3}-?\d{3,4}-?\d{4}\b/g, "<phone>");
}
