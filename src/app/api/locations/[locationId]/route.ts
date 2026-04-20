import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod/v4";
import { createClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/auth/role";
import { isValidUUID } from "@/lib/utils/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  address_lines: z.array(z.string().trim().min(1).max(200)).min(1).max(5).optional(),
  naver_url: z.string().url().optional().nullable(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ locationId: string }> },
) {
  await requireAdmin();
  const { locationId } = await params;
  if (!isValidUUID(locationId)) {
    return NextResponse.json({ error: "잘못된 장소 ID입니다" }, { status: 400 });
  }

  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "입력값을 확인해 주세요" },
      { status: 400 },
    );
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("experiment_locations")
    .update(parsed.data)
    .eq("id", locationId)
    .select()
    .single();

  if (error || !data) {
    return NextResponse.json({ error: "장소 수정에 실패했습니다" }, { status: 500 });
  }
  return NextResponse.json({ location: data });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ locationId: string }> },
) {
  await requireAdmin();
  const { locationId } = await params;
  if (!isValidUUID(locationId)) {
    return NextResponse.json({ error: "잘못된 장소 ID입니다" }, { status: 400 });
  }

  const supabase = await createClient();
  // If any experiments still point here, block delete and tell the admin to
  // reassign them first. Cascade to SET NULL would silently strip location.
  const { count } = await supabase
    .from("experiments")
    .select("id", { count: "exact", head: true })
    .eq("location_id", locationId);
  if ((count ?? 0) > 0) {
    return NextResponse.json(
      { error: `이 장소를 사용하는 실험이 ${count}개 있습니다. 먼저 장소를 변경해 주세요.` },
      { status: 409 },
    );
  }

  const { error } = await supabase
    .from("experiment_locations")
    .delete()
    .eq("id", locationId);
  if (error) {
    return NextResponse.json({ error: "장소 삭제에 실패했습니다" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
