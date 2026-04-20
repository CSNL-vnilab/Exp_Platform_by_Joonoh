import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod/v4";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { invalidateCalendarCache } from "@/lib/google/freebusy-cache";
import { isValidUUID } from "@/lib/utils/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    block_start: z.string().datetime(),
    block_end: z.string().datetime(),
    reason: z.string().max(200).optional().nullable(),
  })
  .refine((v) => new Date(v.block_end) > new Date(v.block_start), {
    message: "종료 시각이 시작 시각 이후여야 합니다",
  });

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ experimentId: string }> },
) {
  const { experimentId } = await params;
  if (!isValidUUID(experimentId)) {
    return NextResponse.json({ error: "잘못된 실험 ID입니다" }, { status: 400 });
  }
  const supabase = await createClient();
  const { data } = await supabase
    .from("experiment_manual_blocks")
    .select("*")
    .eq("experiment_id", experimentId)
    .order("block_start", { ascending: true });
  return NextResponse.json({ blocks: data ?? [] });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ experimentId: string }> },
) {
  const { experimentId } = await params;
  if (!isValidUUID(experimentId)) {
    return NextResponse.json({ error: "잘못된 실험 ID입니다" }, { status: 400 });
  }
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });
  }

  // Permission: admin OR experiment owner.
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

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "잘못된 요청입니다" },
      { status: 400 },
    );
  }

  const { data, error } = await admin
    .from("experiment_manual_blocks")
    .insert({
      experiment_id: experimentId,
      block_start: parsed.data.block_start,
      block_end: parsed.data.block_end,
      reason: parsed.data.reason ?? null,
      created_by: user.id,
    })
    .select()
    .single();

  if (error || !data) {
    return NextResponse.json({ error: "블록 추가에 실패했습니다" }, { status: 500 });
  }

  // Participants fetching slots for this experiment will need fresh busy data.
  if (exp.google_calendar_id) {
    invalidateCalendarCache(exp.google_calendar_id).catch(() => {});
  }

  return NextResponse.json({ block: data }, { status: 201 });
}
