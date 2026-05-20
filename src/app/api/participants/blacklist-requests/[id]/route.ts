import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidUUID } from "@/lib/utils/validation";

// POST /api/participants/blacklist-requests/[id]
//   body: { action: "approve" | "reject", rejectedReason?: string }
//
// Admin-only. Approve flow runs the same class-flip path the manual
// admin UI uses (assign_participant_class_manual RPC) + stamps the
// supplied phone_last4 into participants.phone (privacy: full phone
// never stored for blacklisted rows) + cascade-cancels future
// confirmed/running bookings (mirrors P2-3 in
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
    .select("id")
    .eq("participant_id", req.participant_id)
    .in("status", ["confirmed", "running"])
    .gt("slot_start", nowIso);
  let cancelled = 0;
  for (const b of futureBks ?? []) {
    const { error: cancelErr } = await admin
      .from("bookings")
      .update({ status: "cancelled" })
      .eq("id", b.id)
      .in("status", ["confirmed", "running"]);
    if (!cancelErr) cancelled += 1;
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
