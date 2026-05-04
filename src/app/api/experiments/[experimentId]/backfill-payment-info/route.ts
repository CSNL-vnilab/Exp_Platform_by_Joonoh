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
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidUUID } from "@/lib/utils/validation";
import { backfillPaymentInfoForExperiment } from "@/lib/payments/backfill";

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ experimentId: string }> },
) {
  const { experimentId } = await ctx.params;
  if (!isValidUUID(experimentId)) {
    return NextResponse.json({ error: "Invalid experiment ID" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();

  // Auth: experiment owner or admin.
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

  const result = await backfillPaymentInfoForExperiment(admin, experimentId);
  return NextResponse.json(result);
}
