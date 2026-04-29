import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidUUID } from "@/lib/utils/validation";
import { notifyPaymentInfoIfReady } from "@/lib/services/payment-info-notify.service";

// POST /api/experiments/:experimentId/payment-info/:bookingGroupId/resend
//
// Researcher-triggered manual resend of the 정산 정보 입력 link email.
// Useful when:
//   - the participant says they didn't receive the auto-dispatched mail
//     (e.g. it landed in spam, or the recipient address has changed)
//   - the auto-complete cron failed for transient SMTP reasons and the
//     researcher wants to nudge it manually
//
// This endpoint:
//   1. Authorizes researcher-owner or admin
//   2. Verifies all bookings in the group are 'completed'
//   3. Resets payment_link_sent_at + last_error via the SECURITY DEFINER RPC
//      so the notify helper takes the "first send" branch
//   4. Issues a fresh token (so a stolen URL from a prior dispatch can't
//      shortcut anything) and sends the email
//
// On success: 200 with { ok: true }. The notify helper internally records
// payment_link_sent_at = now(); we surface the same outcome string.

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ experimentId: string; bookingGroupId: string }> },
) {
  const { experimentId, bookingGroupId } = await ctx.params;
  if (!isValidUUID(experimentId) || !isValidUUID(bookingGroupId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();

  const { data: experiment } = await admin
    .from("experiments")
    .select("id, created_by")
    .eq("id", experimentId)
    .maybeSingle();
  if (!experiment) {
    return NextResponse.json({ error: "Experiment not found" }, { status: 404 });
  }
  const { data: profile } = await admin
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  const isOwner = experiment.created_by === user.id;
  const isAdmin = profile?.role === "admin";
  if (!isOwner && !isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Confirm the row belongs to this experiment so a researcher can't
  // resend dispatch for another experiment by guessing IDs.
  const { data: row } = await admin
    .from("participant_payment_info")
    .select("id, experiment_id, status")
    .eq("booking_group_id", bookingGroupId)
    .maybeSingle();
  if (!row || row.experiment_id !== experimentId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (row.status !== "pending_participant") {
    return NextResponse.json(
      { error: "이미 정산 정보가 제출되었습니다." },
      { status: 409 },
    );
  }

  // Reset the dispatch state. The RPC re-checks ownership too (defense in
  // depth + works under user-scoped client when called from elsewhere).
  // Here we use the admin client for simplicity; the auth check above
  // already guards entry.
  const { error: resetErr } = await admin
    .from("participant_payment_info")
    .update({
      payment_link_sent_at: null,
      payment_link_last_error: null,
      payment_link_attempts: 0,
    })
    .eq("id", row.id);
  if (resetErr) {
    return NextResponse.json(
      { error: "재발송 준비 중 오류가 발생했습니다." },
      { status: 500 },
    );
  }

  const result = await notifyPaymentInfoIfReady(admin, bookingGroupId);
  if (result.outcome === "sent") {
    return NextResponse.json({ ok: true, outcome: result.outcome });
  }
  if (result.outcome === "not_all_completed") {
    return NextResponse.json(
      { error: "모든 실험 세션이 종료된 후에 발송할 수 있습니다.", outcome: result.outcome },
      { status: 409 },
    );
  }
  if (result.outcome === "no_recipient") {
    return NextResponse.json(
      { error: "참여자 이메일 주소가 비어 있습니다.", outcome: result.outcome },
      { status: 422 },
    );
  }
  if (result.outcome === "send_failed") {
    return NextResponse.json(
      {
        error: "메일 발송에 실패했습니다. 잠시 후 다시 시도해 주세요.",
        outcome: result.outcome,
        detail: result.detail,
      },
      { status: 502 },
    );
  }
  // amount_zero / no_payment_row / already_sent — no-op or impossible
  // states for the researcher path.
  return NextResponse.json(
    { error: "발송 대상이 아닙니다.", outcome: result.outcome },
    { status: 409 },
  );
}
