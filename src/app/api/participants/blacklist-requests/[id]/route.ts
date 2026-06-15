import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidUUID } from "@/lib/utils/validation";
import { COMPLETABLE_STATUSES } from "@/lib/bookings/status";
import { notifyPaymentInfoIfReady } from "@/lib/services/payment-info-notify.service";

// POST /api/participants/blacklist-requests/[id]
//   body: { action: "approve" | "reject", rejectedReason?: string }
//
// Admin-only. Approve flow runs the same class-flip path the manual
// admin UI uses (assign_participant_class_manual RPC) + stamps the
// supplied phone_last4 into participants.phone (privacy: full phone
// never stored for blacklisted rows) + cascade-cancels future
// confirmed/running bookings + settles participant_payment_info for
// every affected group via propagate_payment_period +
// notifyPaymentInfoIfReady (mirrors P2-3 in
// /api/participants/[id]/class).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  action: z.enum(["approve", "reject"]),
  rejectedReason: z.string().trim().max(500).optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isValidUUID(id)) {
    return NextResponse.json({ error: "Invalid request ID" }, { status: 400 });
  }

  // Auth + admin gate.
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("role, disabled")
    .eq("id", user.id)
    .maybeSingle();
  const p = profile as { role?: string; disabled?: boolean } | null;
  if (!p || p.disabled || p.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { action, rejectedReason } = parsed.data;

  const { data: req } = await admin
    .from("participant_blacklist_requests")
    .select("id, participant_id, lab_id, reason, phone_last4, status")
    .eq("id", id)
    .maybeSingle();
  if (!req) {
    return NextResponse.json({ error: "요청을 찾을 수 없습니다" }, { status: 404 });
  }
  if (req.status !== "pending") {
    return NextResponse.json(
      { error: `이미 처리된 요청입니다 (status=${req.status})` },
      { status: 409 },
    );
  }

  if (action === "reject") {
    const { error } = await admin
      .from("participant_blacklist_requests")
      .update({
        status: "rejected",
        approved_by: user.id,
        approved_at: new Date().toISOString(),
        rejected_reason: rejectedReason ?? null,
      })
      .eq("id", id)
      .eq("status", "pending");
    if (error) {
      return NextResponse.json(
        { error: `반려 실패: ${error.message}` },
        { status: 500 },
      );
    }
    return NextResponse.json({ ok: true, status: "rejected" });
  }

  // action === "approve"
  // 1. Flip class via the audit-logged RPC.
  const { error: rpcErr } = await admin.rpc("assign_participant_class_manual", {
    p_participant_id: req.participant_id,
    p_lab_id: req.lab_id,
    p_class: "blacklist",
    p_reason: req.reason,
    p_valid_until: null,
    p_assigned_by: user.id,
  });
  if (rpcErr) {
    return NextResponse.json(
      { error: `클래스 변경 실패: ${rpcErr.message}` },
      { status: 500 },
    );
  }

  // 2. Stamp phone_last4 (privacy: full phone never stored).
  if (req.phone_last4) {
    const { error: phErr } = await admin
      .from("participants")
      .update({ phone: req.phone_last4 })
      .eq("id", req.participant_id);
    if (phErr) {
      console.error(
        `[BlacklistReq approve] phone stamp failed for ${req.participant_id}: ${phErr.message}`,
      );
      // continue — class change already committed; UI will show empty 연락처
    }
  }

  // 3. Cascade-cancel future confirmed/running bookings (P2-3 mirror).
  const nowIso = new Date().toISOString();
  const { data: futureBks } = await admin
    .from("bookings")
    .select("id, booking_group_id")
    .eq("participant_id", req.participant_id)
    // COMPLETABLE_STATUSES = in-flight 출발상태 (bookings/status SSOT).
    .in("status", [...COMPLETABLE_STATUSES])
    .gt("slot_start", nowIso);
  let cancelled = 0;
  const cascadeGroups = new Set<string>();
  for (const b of futureBks ?? []) {
    const { error: cancelErr } = await admin
      .from("bookings")
      .update({ status: "cancelled" })
      .eq("id", b.id)
      // CAS: don't flip a booking that raced to 'completed' or was
      // cancelled by another admin in the gap between SELECT and UPDATE.
      .in("status", [...COMPLETABLE_STATUSES]);
    if (!cancelErr) {
      cancelled += 1;
      const bg = (b as { booking_group_id?: string | null }).booking_group_id;
      if (bg) cascadeGroups.add(bg);
    }
  }

  // 3b. Settle payment_info for every affected group (mirrors the
  // /api/participants/[participantId]/class cascade path). The direct
  // class-flip path already funnels through this helper; the researcher-
  // request → admin-approval path here did NOT, so when an approved
  // cascade cancelled the LAST live booking of a group the
  // participant_payment_info row stayed stuck in pending/claimed/
  // submitted_to_admin until the nightly cron — and the cron only sweeps
  // status='pending_participant', so a claimed/submitted row was never
  // reconciled at all (live prod: sbj13 pi=818c13e9). For each group we
  // first re-derive 활용일자 via propagate_payment_period, then dispatch:
  // all-terminal groups transition payment_info → 'cancelled' (no email),
  // groups with completed sessions become payable. Best-effort — the
  // class flip + cancellations have already committed, so a settlement
  // failure must never fail the approval.
  for (const bg of cascadeGroups) {
    try {
      await admin.rpc("propagate_payment_period", {
        p_booking_group_id: bg,
      });
    } catch (err) {
      console.warn(
        `[BlacklistReq approve] propagate_payment_period failed for ${bg}:`,
        err instanceof Error ? err.message : err,
      );
    }
    try {
      await notifyPaymentInfoIfReady(admin, bg);
    } catch (err) {
      console.error(
        `[BlacklistReq approve] notifyPaymentInfoIfReady crashed for ${bg}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // 4. Mark request approved.
  const { error: updErr } = await admin
    .from("participant_blacklist_requests")
    .update({
      status: "approved",
      approved_by: user.id,
      approved_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("status", "pending");
  if (updErr) {
    return NextResponse.json(
      { error: `상태 업데이트 실패: ${updErr.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    status: "approved",
    cascade_cancelled_bookings: cancelled,
  });
}
