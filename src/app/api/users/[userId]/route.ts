import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod/v4";
import { requireAdmin } from "@/lib/auth/role";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const uuidRe =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const patchSchema = z
  .object({
    role: z.enum(["admin", "researcher"]).optional(),
    disabled: z.boolean().optional(),
  })
  .refine((v) => v.role !== undefined || v.disabled !== undefined, {
    message: "role 또는 disabled 중 하나는 필요합니다",
  });

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const me = await requireAdmin();
  const { userId } = await params;

  if (!uuidRe.test(userId)) {
    return NextResponse.json({ error: "잘못된 사용자 ID입니다" }, { status: 400 });
  }
  if (userId === me.id) {
    return NextResponse.json(
      { error: "본인 계정은 변경할 수 없습니다" },
      { status: 400 },
    );
  }

  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("profiles")
    .update(parsed.data)
    .eq("id", userId)
    .select()
    .single();

  if (error || !data) {
    return NextResponse.json({ error: "업데이트에 실패했습니다" }, { status: 500 });
  }

  return NextResponse.json({ profile: data });
}
