import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod/v4";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidUUID } from "@/lib/utils/validation";
import { notifyPaymentInfoIfReady } from "@/lib/services/payment-info-notify.service";

// PATCH /api/experiments/:experimentId/payment-info/:bookingGroupId/amount
// Researcher-only manual override of the amount_krw field. Sets
// amount_overridden=true plus amount_overridden_by/at (migration 00063)
// so the UI can show "수정됨 — {user} at {time}" and 행정 can audit-
// trail any divergence from experiments.participation_fee.
//
// Forbidden once the row is already claimed (status='claimed'|'paid') —
// you can't retroactively change what was handed to 행정.
//
// Optional `resend: true` in the body — after saving the new amount,
// immediately dispatch (or re-dispatch) the participant info-request
// email with the new amount baked in. Used by the payment-panel
// "수정 후 즉시 발송" path so the researcher doesn't have to PATCH +
// click resend in two steps.

const bodySchema = z.object({
  amountKrw: z
    .number()
    .int({ message: "정수로 입력하세요." })
    .min(0, { message: "0 이상이어야 합니다." })
    .max(100_000_000, { message: "금액이 너무 큽니다." }),
  resend: z.boolean().optional(),
});

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ experimentId: string; bookingGroupId: string }> },
) {
  const { experimentId, bookingGroupId } = await ctx.params;
  if (!isValidUUID(experimentId) || !isValidUUID(bookingGroupId)) {
    return NextResponse.json({ error: "Invalid ID" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
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

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed" }, { status: 400 });
  }

  // Only allow override while the row is editable (pre-claim).
  // We also stamp amount_overridden_by/at (migration 00063) so the UI
  // and 행정 can see who/when last changed the amount.
  const nowIso = new Date().toISOString();
  const { error, count } = await admin
    .from("participant_payment_info")
    .update(
      {
        amount_krw: parsed.data.amountKrw,
        amount_overridden: true,
        amount_overridden_by: user.id,
        amount_overridden_at: nowIso,
      },
      { count: "exact" },
    )
    .eq("experiment_id", experimentId)
    .eq("booking_group_id", bookingGroupId)
    .in("status", ["pending_participant", "submitted_to_admin"]);

  if (error) {
    return NextResponse.json({ error: "수정에 실패했습니다." }, { status: 500 });
  }
  if ((count ?? 0) === 0) {
    return NextResponse.json(
      { error: "이미 청구된 참가자는 수정할 수 없습니다." },
      { status: 409 },
    );
  }

  // Optional: dispatch (or re-dispatch) the info-request email right
  // away with the new amount. Two cases:
  //   - payment_link_sent_at is NULL → first send. force=true bypasses
  //     the experiment-level auto-send opt-out because the researcher
  //     just confirmed the amount and is asking for it explicitly.
  //   - payment_link_sent_at is set → already sent once at the old
  //     amount. notify (with force=true) atomically nulls sent_at as
  //     part of acquiring the dispatch lock — single source of truth
  //     for "who is dispatching" even on resend. We deliberately do
  //     NOT pre-reset sent_at here: that would re-introduce the
  //     C6 double-send race (two concurrent PATCH-with-resend clicks
  //     both reset, both acquire the lock, both send).
  let resendOutcome: string | null = null;
  if (parsed.data.resend) {
    try {
      const result = await notifyPaymentInfoIfReady(
        admin,
        bookingGroupId,
        undefined,
        { force: true },
      );
      resendOutcome = result.outcome;
    } catch (err) {
      console.error(
        "[AmountPATCH] resend after override failed:",
        err instanceof Error ? err.message : err,
      );
      resendOutcome = "send_crashed";
    }
  }

  // Codex 2nd-pass L (2026-05-29): when resend:true was requested but
  // the dispatch didn't actually send, surface the failure with a non-
  // 2xx so the client doesn't silently toast "성공". The amount edit
  // itself still landed in the DB (and the audit columns are stamped),
  // which is why this still returns the new amount + overriddenAt —
  // the caller can use those to update the in-memory row even when it
  // shows a separate "메일 발송 실패" notice.
  if (parsed.data.resend && resendOutcome && resendOutcome !== "sent") {
    const httpStatus = resendOutcome === "lock_held" ? 409 : 502;
    return NextResponse.json(
      {
        ok: false,
        amountKrw: parsed.data.amountKrw,
        overriddenAt: nowIso,
        resendOutcome,
        error:
          resendOutcome === "lock_held"
            ? "다른 발송 작업이 진행 중입니다. 잠시 후 다시 시도해 주세요."
            : resendOutcome === "auto_send_disabled"
              ? "자동 발송이 비활성화된 실험입니다. 안내 메일은 별도로 발송해 주세요."
              : resendOutcome === "amount_zero"
                ? "지급액이 0이거나 미설정 상태라 메일이 발송되지 않았습니다."
                : resendOutcome === "no_recipient"
                  ? "참여자 이메일 주소가 비어 있어 발송할 수 없습니다."
                  : "안내 메일 발송에 실패했습니다.",
      },
      { status: httpStatus },
    );
  }

  return NextResponse.json({
    ok: true,
    amountKrw: parsed.data.amountKrw,
    overriddenAt: nowIso,
    resendOutcome,
  });
}
