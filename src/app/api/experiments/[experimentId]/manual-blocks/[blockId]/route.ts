import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { invalidateCalendarCache } from "@/lib/google/freebusy-cache";
import { isValidUUID } from "@/lib/utils/validation";

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
  if (!isValidUUID(experimentId) || !isValidUUID(blockId)) {
    return NextResponse.json({ error: "잘못된 ID입니다" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data: exp } = await admin
    .from("experiments")
    .select("created_by, google_calendar_id")
    .eq("id", experimentId)
    .maybeSingle();
  if (!exp) {
    return NextResponse.json({ error: "실험을 찾을 수 없습니다" }, { status: 404 });
  }
  const { data: profile } = await admin
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  const isAdmin = profile?.role === "admin";
  if (!isAdmin && exp.created_by !== user.id) {
    return NextResponse.json({ error: "권한이 없습니다" }, { status: 403 });
  }

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
