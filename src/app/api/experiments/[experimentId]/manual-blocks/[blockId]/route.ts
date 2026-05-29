import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { invalidateCalendarCache } from "@/lib/google/freebusy-cache";
import { isValidUUID } from "@/lib/utils/validation";
import { requireExperimentAccess } from "@/lib/auth/experiment-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  _request: NextRequest,
  {
    params,
  }: {
    params: Promise<{ experimentId: string; blockId: string }>;
  },
) {
  const { experimentId, blockId } = await params;
  if (!isValidUUID(blockId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  const access = await requireExperimentAccess(experimentId, {
    extraColumns: "google_calendar_id",
  });
  if (access instanceof NextResponse) return access;
  const { admin } = access;
  const exp = access.experiment as unknown as {
    id: string;
    created_by: string | null;
    google_calendar_id: string | null;
  };

  const { error } = await admin
    .from("experiment_manual_blocks")
    .delete()
    .eq("id", blockId)
    .eq("experiment_id", experimentId);
  if (error) {
    return NextResponse.json({ error: "블록 삭제에 실패했습니다" }, { status: 500 });
  }

  if (exp.google_calendar_id) {
    invalidateCalendarCache(exp.google_calendar_id).catch(() => {});
  }

  return NextResponse.json({ ok: true });
}
