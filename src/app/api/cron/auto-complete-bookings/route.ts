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
    let dispatch: {
      examined: number;
      sent: number;
      errors: number;
      // Permanently-undeliverable rows (empty/sentinel recipient). NOT an
      // infrastructure failure — the row has been retired past the sweep
      // ceiling and won't be re-examined. Tracked separately so it's
      // excluded from the outage denominator below.
      undeliverable: number;
      // Rows we actually tried to deliver to = sent + errors. EXCLUDES
      // benign skips (lock_held / already_sent / auto_send_disabled /
      // not_all_completed / amount_zero / no_payment_row) and undeliverable
      // rows. The outage detector divides by this, not `examined`, so a
      // single real failure among four lock_held skips no longer reads as
      // a total outage.
      attempted: number;
    } = {
      examined: 0,
      sent: 0,
      errors: 0,
      undeliverable: 0,
      attempted: 0,
    };
    // S4 observability: the previous catch swallowed a sweep throw as
    // examined:0, hiding a total outage. Carry the throw out as a flag so
    // the operator (and the outage check below) can see it.
    let sweepThrew = false;
    try {
      const sweep = await sweepPaymentInfoNotifications(admin);
      dispatch = {
        examined: sweep.examined,
        sent: sweep.sent,
        errors: sweep.errors,
        undeliverable: sweep.undeliverable,
        attempted: sweep.sent + sweep.errors,
      };
    } catch (err) {
      sweepThrew = true;
      console.error(
        "[AutoCompleteCron] payment-info sweep crashed:",
        err instanceof Error ? err.message : err,
      );
    }

    // S4 observability: signal a TOTAL dispatch outage with a non-200 so GH
    // Actions notify-cron-failure can fire. Outage = the sweep itself threw,
    // OR every row we *actually tried to deliver to* failed (infrastructure
    // errors only, none sent).
    //
    // The denominator is `attempted` (= sent + errors), NOT `examined`. This
    // matters two ways:
    //   (1) Benign skips — lock_held (a concurrent trigger holds the dispatch
    //       lease; positive, not a failure), already_sent, auto_send_disabled,
    //       not_all_completed, amount_zero, no_payment_row — are in `examined`
    //       but never in `attempted`. Under the old `examined>0` denominator,
    //       a tick of {1 send_failed, 4 lock_held} read as a TOTAL outage even
    //       though it was a 1-of-5 partial failure. Now those four drop out.
    //   (2) Permanently-undeliverable rows (empty/sentinel recipient) are
    //       counted as `undeliverable`, never `errors`, and are retired past
    //       the sweep ceiling so they leave the candidate set. A quiet night
    //       whose only pending row is undeliverable now yields attempted=0,
    //       errors=0 → no outage, instead of the previous perpetual false 500.
    //
    // Partial failures (some sent) and nothing-attempted (attempted===0) stay
    // 200 to avoid GH retry stampedes.
    const dispatchOutage =
      sweepThrew ||
      (dispatch.errors > 0 && dispatch.sent === 0 && dispatch.attempted > 0);
    if (dispatchOutage) {
      console.error(
        `[AutoCompleteCron] TOTAL DISPATCH OUTAGE — sweepThrew=${sweepThrew}, examined=${dispatch.examined}, attempted=${dispatch.attempted}, sent=${dispatch.sent}, errors=${dispatch.errors}, undeliverable=${dispatch.undeliverable}`,
      );
    }

    return NextResponse.json(
      {
        ok: !dispatchOutage,
        grace_days: graceDays,
        completed: data ?? 0,
        payment_info_dispatch: dispatch,
        payment_info_sweep_errored: sweepThrew,
      },
      { status: dispatchOutage ? 500 : 200 },
    );
  } catch (err) {
    console.error("[AutoCompleteCron] error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
