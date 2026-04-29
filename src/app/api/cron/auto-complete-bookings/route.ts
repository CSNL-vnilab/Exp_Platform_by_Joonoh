import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { authorizeCronRequest } from "@/lib/auth/cron-secret";
import { sweepPaymentInfoNotifications } from "@/lib/services/payment-info-notify.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Auto-complete cron. Runs nightly. For every `confirmed` booking whose
// slot_end is older than the configured grace period (default 7d), flips
// status → 'completed' and stamps auto_completed_at. The bookings-status
// trigger then recomputes the participant's class in the experiment's lab.
//
// Grace period exists so researchers have time to tick post-survey first —
// which would set completed explicitly (attested) and bypass the auto path.
// `auto_completed_at` lets analytics distinguish attested vs auto.

async function handle(request: NextRequest) {
  try {
    if (!authorizeCronRequest(request)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const url = new URL(request.url);
    const graceRaw = url.searchParams.get("grace_days");
    const graceDays = graceRaw
      ? Math.max(0, Math.min(90, Number.parseInt(graceRaw, 10) || 7))
      : 7;

    const admin = createAdminClient();
    const { data, error } = await admin.rpc("auto_complete_stale_bookings", {
      p_grace_days: graceDays,
    });

    if (error) {
      console.error("[AutoCompleteCron] rpc error:", error.message);
      return NextResponse.json(
        { error: "RPC failed", detail: error.message },
        { status: 500 },
      );
    }

    // After flipping bookings to 'completed', sweep participant_payment_info
    // rows whose dispatch is pending. Bounded to SWEEP_LIMIT to keep this
    // cron tick under timeout; rows missed in this tick get picked up
    // tomorrow. Rows whose group has just *partially* completed will
    // remain pending until the last booking is also completed.
    let dispatch: { examined: number; sent: number; errors: number } = {
      examined: 0,
      sent: 0,
      errors: 0,
    };
    try {
      const sweep = await sweepPaymentInfoNotifications(admin);
      dispatch = {
        examined: sweep.examined,
        sent: sweep.sent,
        errors: sweep.errors,
      };
    } catch (err) {
      console.error(
        "[AutoCompleteCron] payment-info sweep crashed:",
        err instanceof Error ? err.message : err,
      );
    }

    return NextResponse.json({
      ok: true,
      grace_days: graceDays,
      completed: data ?? 0,
      payment_info_dispatch: dispatch,
    });
  } catch (err) {
    console.error("[AutoCompleteCron] error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
