import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod/v4";
import { createClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/auth/role";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  address_lines: z.array(z.string().trim().min(1).max(200)).min(1).max(5),
  naver_url: z.string().url().optional().nullable(),
});

// Public list — booking pages need addresses. RLS enforces SELECT public.
export async function GET() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("experiment_locations")
    .select("*")
    .order("name", { ascending: true });
  return NextResponse.json({ locations: data ?? [] });
}

// Admin-only create.
export async function POST(request: NextRequest) {
  const me = await requireAdmin();
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "입력값을 확인해 주세요" },
      { status: 400 },
    );
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("experiment_locations")
    .insert({
      name: parsed.data.name,
      address_lines: parsed.data.address_lines,
      naver_url: parsed.data.naver_url ?? null,
      created_by: me.id,
    })
    .select()
    .single();

  if (error || !data) {
    return NextResponse.json({ error: "장소 생성에 실패했습니다" }, { status: 500 });
  }
  return NextResponse.json({ location: data }, { status: 201 });
}
