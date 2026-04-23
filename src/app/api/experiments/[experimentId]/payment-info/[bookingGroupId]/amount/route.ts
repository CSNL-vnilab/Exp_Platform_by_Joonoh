import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod/v4";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidUUID } from "@/lib/utils/validation";

// PATCH /api/experiments/:experimentId/payment-info/:bookingGroupId/amount
// Researcher-only manual override of the amount_krw field. Sets
// amount_overridden=true so the UI can flag "this no longer matches
// fee × sessions".
//
// Forbidden once the row is already claimed (status='claimed'|'paid') —
// you can't retroactively change what was handed to 행정.

const bodySchema = z.object({
  amountKrw: z
    .number()
    .int({ message: "정수로 입력하세요." })
    .min(0, { message: "0 이상이어야 합니다." })
    .max(100_000_000, { message: "금액이 너무 큽니다." }),
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
  const { error, count } = await admin
    .from("participant_payment_info")
    .update(
      {
        amount_krw: parsed.data.amountKrw,
        amount_overridden: true,
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

  return NextResponse.json({ ok: true });
}
