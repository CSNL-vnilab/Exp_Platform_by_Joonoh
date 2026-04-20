import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod/v4";
import { requireAdmin } from "@/lib/auth/role";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const uuidRe =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const bodySchema = z.object({
  reason: z.string().trim().max(200).optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ requestId: string }> },
) {
  const me = await requireAdmin();
  const { requestId } = await params;
  if (!uuidRe.test(requestId)) {
    return NextResponse.json({ error: "잘못된 요청 ID입니다" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("registration_requests")
    .update({
      status: "rejected",
      processed_at: new Date().toISOString(),
      processed_by: me.id,
      rejection_reason: parsed.data.reason ?? null,
      password_cipher: "",
      password_iv: "",
      password_tag: "",
    })
    .eq("id", requestId)
    .eq("status", "pending")
    .select()
    .single();

  if (error || !data) {
    return NextResponse.json(
      { error: "대기 중인 요청을 찾을 수 없습니다" },
      { status: 404 },
    );
  }

  return NextResponse.json({ ok: true });
}
