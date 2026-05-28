import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// /api/lab/settings
//
// Lab-wide settings (currently just irb_base_url; structured as a
// settings endpoint so future lab-wide fields can hang off the same
// surface without proliferating routes).
//
//   GET  → { irb_base_url } for any authenticated lab member.
//   PUT  → admin only. body { irb_base_url: string | null }.
//          Empty string is normalised to null so the UI's "지우기"
//          gesture round-trips cleanly.
//
// Single-tenant CSNL deployment — operates on the one labs row matched
// by code='CSNL'. Multi-lab will add a path/query param later.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LAB_CODE = "CSNL";

const putBodySchema = z.object({
  irb_base_url: z
    .string()
    .trim()
    .max(2048)
    .url("올바른 URL 이어야 합니다")
    .nullable()
    .or(z.literal("").transform(() => null)),
});

async function requireMember(): Promise<
  | { ok: true; userId: string; role: "admin" | "researcher"; admin: ReturnType<typeof createAdminClient> }
  | { ok: false; status: number; error: string }
> {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }
  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("role, disabled")
    .eq("id", user.id)
    .maybeSingle();
  const p = profile as { role?: string; disabled?: boolean } | null;
  if (!p || p.disabled || (p.role !== "admin" && p.role !== "researcher")) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  return {
    ok: true,
    userId: user.id,
    role: p.role as "admin" | "researcher",
    admin,
  };
}

export async function GET() {
  const auth = await requireMember();
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const { data, error } = await auth.admin
    .from("labs")
    .select("id, code, name, irb_base_url")
    .eq("code", LAB_CODE)
    .maybeSingle();
  if (error || !data) {
    return NextResponse.json(
      { error: "랩 설정을 불러오지 못했습니다" },
      { status: 500 },
    );
  }
  return NextResponse.json({
    lab: { id: data.id, code: data.code, name: data.name },
    irb_base_url: data.irb_base_url ?? null,
  });
}

export async function PUT(request: NextRequest) {
  const auth = await requireMember();
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  if (auth.role !== "admin") {
    return NextResponse.json(
      { error: "관리자만 랩 설정을 수정할 수 있습니다" },
      { status: 403 },
    );
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = putBodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { error } = await auth.admin
    .from("labs")
    .update({ irb_base_url: parsed.data.irb_base_url })
    .eq("code", LAB_CODE);
  if (error) {
    return NextResponse.json(
      { error: `저장 실패: ${error.message}` },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, irb_base_url: parsed.data.irb_base_url });
}
