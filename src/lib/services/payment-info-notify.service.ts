// 실험 종료 시 참여자에게 정산 정보 입력 링크 메일을 자동 발송한다.
//
// 호출 진입점 (모두 동일한 함수 — notifyPaymentInfoIfReady — 를 사용):
//
//   1. PUT /api/bookings/[id] — 연구원이 booking 상태를 'completed' 로
//      직접 변경할 때.
//   2. submit_booking_observation RPC 의 auto-complete 분기 (사후설문
//      체크 시 자동 완료) — observation 라우트 핸들러에서 호출.
//   3. /run verify 엔드포인트의 auto-complete 분기.
//   4. cron auto-complete-bookings — RPC 가 한 번에 N 행을 completed 로
//      flip 한 후 sweep.
//
// 멱등성: payment_link_sent_at 이 NULL 인 행만 발송한다. 같은 booking_group
// 의 booking 이 차례로 'completed' 로 전이되어도 마지막 한 번만 메일이
// 나간다.
//
// 발송 자격:
//   - participant_payment_info 행이 존재해야 한다 (즉 fee > 0 인 실험).
//   - 같은 booking_group 의 모든 booking 의 status 가 'completed' 여야
//     한다 ('cancelled' / 'no_show' 는 제외).
//   - 토큰이 만료되지 않았어야 한다. 만료된 경우 새 토큰을 발급해
//     hash 를 갱신하고 메일을 보낸다.
//
// 실패 처리: SMTP 실패는 catch 하여 last_error / attempts 만 기록하고
// 호출자에게 throw 하지 않는다. 호출 사이트는 booking 상태 전이를
// 메일 실패로 롤백할 의사가 없으므로.

import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail as defaultSendEmail } from "@/lib/google/gmail";
import { issuePaymentToken } from "@/lib/payments/token";
import { buildPaymentInfoEmail } from "@/lib/services/payment-info-email-template";

type Supabase = ReturnType<typeof createAdminClient>;

// Injectable mailer so unit tests can stub SMTP without monkey-patching
// ESM module exports (which fails on Node 20+ because exports are
// read-only getters). Default = the real Gmail sender.
type Mailer = (opts: {
  to: string;
  subject: string;
  html: string;
}) => Promise<{ success: boolean; messageId?: string; error?: string }>;

interface PaymentInfoRow {
  id: string;
  booking_group_id: string;
  experiment_id: string;
  participant_id: string;
  amount_krw: number;
  status: string;
  token_hash: string;
  token_issued_at: string;
  token_expires_at: string;
  payment_link_sent_at: string | null;
  payment_link_attempts: number;
  period_start: string | null;
  period_end: string | null;
  name_override: string | null;
  email_override: string | null;
}

export interface NotifyResult {
  /** Why the call did/didn't end up sending. Useful for cron logs. */
  outcome:
    | "sent"
    | "already_sent"
    | "no_payment_row"
    | "amount_zero"
    | "not_all_completed"
    | "no_recipient"
    | "send_failed";
  bookingGroupId: string;
  detail?: string;
}

export async function notifyPaymentInfoIfReady(
  supabase: Supabase,
  bookingGroupId: string,
  mailer: Mailer = defaultSendEmail,
): Promise<NotifyResult> {
  // 1) Load the payment_info row.
  const { data: rowRaw } = await supabase
    .from("participant_payment_info")
    .select(
      "id, booking_group_id, experiment_id, participant_id, amount_krw, status, token_hash, token_issued_at, token_expires_at, payment_link_sent_at, payment_link_attempts, period_start, period_end, name_override, email_override",
    )
    .eq("booking_group_id", bookingGroupId)
    .maybeSingle();

  const row = rowRaw as unknown as PaymentInfoRow | null;
  if (!row) {
    return { outcome: "no_payment_row", bookingGroupId };
  }

  if (row.payment_link_sent_at) {
    return { outcome: "already_sent", bookingGroupId };
  }
  if (row.amount_krw <= 0) {
    return { outcome: "amount_zero", bookingGroupId };
  }
  // If the row was already submitted (참여자가 이미 정산 정보를 제출한 경우)
  // — 이미 메일이 굳이 필요 없다. 멱등성 차원에서 sent_at 을 stamp 해둔다.
  if (row.status !== "pending_participant") {
    await supabase
      .from("participant_payment_info")
      .update({ payment_link_sent_at: new Date().toISOString() })
      .eq("id", row.id);
    return { outcome: "already_sent", bookingGroupId, detail: "row not pending" };
  }

  // 2) All bookings in the group must be 'completed'.
  const { data: bookings } = await supabase
    .from("bookings")
    .select("status")
    .eq("booking_group_id", bookingGroupId);
  const groupBookings = bookings ?? [];
  if (groupBookings.length === 0) {
    return { outcome: "not_all_completed", bookingGroupId, detail: "no bookings" };
  }
  const allCompleted = groupBookings.every((b) => b.status === "completed");
  if (!allCompleted) {
    return { outcome: "not_all_completed", bookingGroupId };
  }

  // 3) Resolve recipient + experiment context. participants(name, email) is
  // joined here rather than at step 1 because we may also need the override
  // values from name_override/email_override and we want the join to fail
  // loudly if the row was orphaned.
  const [{ data: participant }, { data: experimentRaw }] = await Promise.all([
    supabase
      .from("participants")
      .select("name, email")
      .eq("id", row.participant_id)
      .maybeSingle(),
    supabase
      .from("experiments")
      .select("id, title, created_by")
      .eq("id", row.experiment_id)
      .maybeSingle(),
  ]);

  const recipientEmail =
    (row.email_override?.trim() || participant?.email || "").trim();
  const recipientName =
    (row.name_override?.trim() || participant?.name || "").trim();
  if (!recipientEmail) {
    await stampFailure(supabase, row.id, "no recipient email");
    return { outcome: "no_recipient", bookingGroupId };
  }
  const experiment = experimentRaw as unknown as
    | { id: string; title: string; created_by: string | null }
    | null;
  if (!experiment) {
    await stampFailure(supabase, row.id, "experiment not found");
    return { outcome: "send_failed", bookingGroupId, detail: "experiment missing" };
  }

  // 4) Always issue a fresh token. seedPaymentInfo at booking-confirm
  // time stores only the SHA-256 hash, not the plaintext, so we cannot
  // reuse the original token from the confirmation email — we have to
  // mint a new one and rotate the hash. The rotation also means any
  // captured/leaked confirmation-email link is now dead, which is the
  // safer default. Side-effect: a participant who began filling the form
  // on the original link will have to restart with the new email's link.
  // Acceptable because the row is still 'pending_participant' (they
  // haven't submitted yet by definition).
  const issued = issuePaymentToken(bookingGroupId);
  const tokenString = issued.token;
  await supabase
    .from("participant_payment_info")
    .update({
      token_hash: issued.hash,
      token_issued_at: new Date(issued.issuedAt).toISOString(),
      token_expires_at: new Date(issued.expiresAt).toISOString(),
      token_revoked_at: null,
    })
    .eq("id", row.id);

  // 5) Researcher contact (best-effort).
  let researcher: {
    displayName: string | null;
    contactEmail: string | null;
    phone: string | null;
  } | null = null;
  if (experiment.created_by) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("display_name, contact_email, phone")
      .eq("id", experiment.created_by)
      .maybeSingle();
    if (profile) {
      researcher = {
        displayName: (profile as { display_name: string | null }).display_name,
        contactEmail: (profile as { contact_email: string | null }).contact_email,
        phone: (profile as { phone: string | null }).phone,
      };
    }
  }

  // 6) Build URL.
  const origin =
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}`.replace(/\/$/, "") : "");
  const path = `/payment-info/${encodeURIComponent(tokenString)}`;
  const paymentUrl = origin ? `${origin}${path}` : path;

  // 7) Render + send.
  const built = buildPaymentInfoEmail({
    participantName: recipientName,
    participantEmail: recipientEmail,
    experimentTitle: experiment.title,
    amountKrw: row.amount_krw,
    paymentUrl,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    researcher,
    tokenExpiresAt: new Date(issued.expiresAt).toISOString(),
  });

  const sendResult = await mailer({
    to: built.to,
    subject: built.subject,
    html: built.html,
  });

  const nowIso = new Date().toISOString();
  if (!sendResult.success) {
    await supabase
      .from("participant_payment_info")
      .update({
        payment_link_attempts: (row.payment_link_attempts ?? 0) + 1,
        payment_link_last_error: (sendResult.error ?? "unknown").slice(0, 500),
        payment_link_last_attempt_at: nowIso,
      })
      .eq("id", row.id);
    return {
      outcome: "send_failed",
      bookingGroupId,
      detail: sendResult.error ?? "unknown",
    };
  }

  // Success — stamp sent_at. Use a CAS-style guard so two concurrent
  // dispatches (cron + manual) don't both consume the slot.
  const { count } = await supabase
    .from("participant_payment_info")
    .update(
      {
        payment_link_sent_at: nowIso,
        payment_link_attempts: (row.payment_link_attempts ?? 0) + 1,
        payment_link_last_error: null,
        payment_link_last_attempt_at: nowIso,
      },
      { count: "exact" },
    )
    .eq("id", row.id)
    .is("payment_link_sent_at", null);

  if ((count ?? 0) === 0) {
    // Another writer beat us to it. Their attempt counts; we already sent
    // the email but the row says "already_sent". This is rare and benign —
    // the participant gets at most one extra email if both dispatches
    // raced through SMTP. Log and move on.
    console.warn(
      `[PaymentInfoNotify] CAS lost for ${bookingGroupId}; message ${sendResult.messageId} already sent by other writer`,
    );
  }

  return { outcome: "sent", bookingGroupId, detail: sendResult.messageId };
}

async function stampFailure(supabase: Supabase, rowId: string, reason: string) {
  const nowIso = new Date().toISOString();
  await supabase
    .from("participant_payment_info")
    .update({
      payment_link_last_error: reason.slice(0, 500),
      payment_link_last_attempt_at: nowIso,
    })
    .eq("id", rowId);
}

// ── Sweep helper: iterate over all groups whose bookings are completed
//    but whose payment_link_sent_at is NULL. Used by the auto-complete
//    cron after it flips a batch of rows to 'completed'. Bounded so a
//    single cron tick can't fan out to thousands of SMTP calls.
const SWEEP_LIMIT = 50;

export async function sweepPaymentInfoNotifications(
  supabase: Supabase,
  mailer: Mailer = defaultSendEmail,
): Promise<{ examined: number; sent: number; errors: number; results: NotifyResult[] }> {
  const { data: rows } = await supabase
    .from("participant_payment_info")
    .select("booking_group_id")
    .is("payment_link_sent_at", null)
    .eq("status", "pending_participant")
    .gt("amount_krw", 0)
    .limit(SWEEP_LIMIT);

  const results: NotifyResult[] = [];
  let sent = 0;
  let errors = 0;
  for (const r of rows ?? []) {
    const bgId = (r as { booking_group_id: string }).booking_group_id;
    try {
      const result = await notifyPaymentInfoIfReady(supabase, bgId, mailer);
      results.push(result);
      if (result.outcome === "sent") sent++;
      if (result.outcome === "send_failed" || result.outcome === "no_recipient") errors++;
    } catch (err) {
      errors++;
      results.push({
        outcome: "send_failed",
        bookingGroupId: bgId,
        detail: err instanceof Error ? err.message : "unknown",
      });
    }
  }
  return { examined: (rows ?? []).length, sent, errors, results };
}
