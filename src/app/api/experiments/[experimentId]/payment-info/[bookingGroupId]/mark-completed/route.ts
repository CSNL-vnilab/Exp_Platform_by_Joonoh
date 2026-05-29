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
import { isValidUUID } from "@/lib/utils/validation";
import { requireExperimentAccess } from "@/lib/auth/experiment-access";
import { notifyPaymentInfoIfReady } from "@/lib/services/payment-info-notify.service";

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ experimentId: string; bookingGroupId: string }> },
) {
  const { experimentId, bookingGroupId } = await ctx.params;
  if (!isValidUUID(bookingGroupId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  // Auth — defense in depth (RPC also enforces).
  const access = await requireExperimentAccess(experimentId);
  if (access instanceof NextResponse) return access;
  const { supabase, admin } = access;

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

  // RPC flips every booking in the group to 'completed' at once. The
  // PUT /api/bookings/[id] path fires notifyPaymentInfoIfReady on each
  // per-booking flip; mark_group_completed bypasses that path, so the
  // payment-info email would otherwise wait until the nightly
  // auto-complete-bookings cron sweep (up to 24h delay). Fire it inline
  // here so the researcher's one click reaches the participant in
  // seconds, not a day. (notify helper is idempotent via the dispatch
  // lock + payment_link_sent_at — safe if any other path also fires.)
  try {
    const result = await notifyPaymentInfoIfReady(admin, bookingGroupId);
    if (result.outcome === "send_failed") {
      console.warn(
        `[MarkCompleted] payment-info dispatch failed for ${bookingGroupId}: ${result.detail}`,
      );
    }
  } catch (err) {
    console.error(
      "[MarkCompleted] notifyPaymentInfoIfReady crashed:",
      err instanceof Error ? err.message : err,
    );
  }

  return NextResponse.json(data);
}
