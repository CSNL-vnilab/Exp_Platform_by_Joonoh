// POST /api/experiments/[experimentId]/backfill-payment-info
//
// One-shot backfill for experiments whose bookings were imported via a
// script that bypassed runPostBookingPipeline → no participant_payment_info
// rows exist → payment panel stays empty / "정산안내 발송" disabled.
//
// Auth: experiment owner or admin only. Idempotent — safe to re-run.
// Returns counts so the caller can show a toast like "9개 row 백필 완료".

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireExperimentAccess } from "@/lib/auth/experiment-access";
import { backfillPaymentInfoForExperiment } from "@/lib/payments/backfill";

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ experimentId: string }> },
) {
  const { experimentId } = await ctx.params;

  const access = await requireExperimentAccess(experimentId);
  if (access instanceof NextResponse) return access;
  const { admin } = access;

  const result = await backfillPaymentInfoForExperiment(admin, experimentId);
  return NextResponse.json(result);
}
