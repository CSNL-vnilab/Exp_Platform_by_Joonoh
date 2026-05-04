// POST /api/experiments/[experimentId]/payment-info/[bookingGroupId]/mark-completed
//
// One-click flip every confirmed/running booking in the group to
// 'completed'. Removes the per-booking observation-modal tedium for the
// payment dispatch flow — a researcher who has already confirmed the
// participant finished offline doesn't need to open 5 modals to mark a
// 5-session multi experiment as done.
//
// After this returns, allBookingsCompleted becomes true and the
// payment panel's "안내 메일 발송" button enables.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidUUID } from "@/lib/utils/validation";

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

  // Auth — defense in depth (RPC also enforces).
  const { data: exp } = await admin
    .from("experiments")
    .select("id, created_by")
    .eq("id", experimentId)
    .maybeSingle();
  if (!exp) {
    return NextResponse.json({ error: "Experiment not found" }, { status: 404 });
  }
  const { data: profile } = await admin
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  const isOwner = exp.created_by === user.id;
  const isAdmin = profile?.role === "admin";
  if (!isOwner && !isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Verify the group actually belongs to this experiment so a
  // researcher can't flip another experiment's bookings by guessing IDs.
  const { data: groupCheck } = await admin
    .from("bookings")
    .select("id")
    .eq("experiment_id", experimentId)
    .eq("booking_group_id", bookingGroupId)
    .limit(1);
  if (!groupCheck || groupCheck.length === 0) {
    return NextResponse.json({ error: "Group not found" }, { status: 404 });
  }

  // Use the user-scoped client so the RPC's SECURITY DEFINER auth
  // check sees the actual auth.uid() rather than the service role.
  const { data, error } = await supabase.rpc("mark_group_completed", {
    p_booking_group_id: bookingGroupId,
  });
  if (error) {
    return NextResponse.json(
      { error: error.message ?? "마킹에 실패했습니다." },
      { status: 500 },
    );
  }
  return NextResponse.json(data);
}
