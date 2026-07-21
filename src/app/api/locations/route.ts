import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod/v4";
import { createClient } from "@/lib/supabase/server";
import { requireUserApi } from "@/lib/auth/role";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// http/https only. z.string().url() alone accepts javascript:/data: schemes,
// and naver_url is rendered as an <a href> on the participant confirm page —
// restrict the scheme so a saved location can't become a stored-XSS vector.
const httpUrl = z
  .string()
  .url()
  .max(2048)
  .refine((u) => /^https?:\/\//i.test(u), {
    message: "http 또는 https URL만 허용됩니다",
  });

const bodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  address_lines: z.array(z.string().trim().min(1).max(200)).min(1).max(5),
  naver_url: httpUrl.optional().nullable(),
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

// Any active researcher/admin can create a location (they need it to
// register an experiment's address). Edit/delete stay admin-only. RLS
// (00080) enforces the same: INSERT for authenticated with
// created_by = auth.uid(); UPDATE/DELETE admin-only.
export async function POST(request: NextRequest) {
  const me = await requireUserApi();
  if (!me) {
    return NextResponse.json({ error: "로그인이 필요합니다" }, { status: 401 });
  }
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
