import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod/v4";
import { requireAdmin } from "@/lib/auth/role";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  USERNAME_REGEX,
  PASSWORD_REGEX,
  normalizeUsername,
  toInternalEmail,
} from "@/lib/auth/username";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Admins can bypass the approval flow and provision accounts directly.
// Researcher accounts must follow the same 6-digit-password rule that
// self-signup enforces; admin accounts use a stronger free-form password.
const baseSchema = z.object({
  username: z.string().regex(USERNAME_REGEX, "ID는 영문 3~4자여야 합니다"),
  displayName: z.string().trim().min(1).max(60),
  role: z.enum(["admin", "researcher"]).default("researcher"),
  password: z.string().min(6).max(128),
  contactEmail: z.string().email("올바른 이메일 형식이 아닙니다").max(254),
  phone: z
    .string()
    .regex(/^01[0-9]-?\d{3,4}-?\d{4}$/, "올바른 전화번호 형식이 아닙니다"),
});

export async function POST(request: NextRequest) {
  await requireAdmin();

  const parsed = baseSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "입력값을 확인해 주세요" },
      { status: 400 },
    );
  }

  const { username, displayName, role, password, contactEmail, phone } = parsed.data;

  if (role === "researcher" && !PASSWORD_REGEX.test(password)) {
    return NextResponse.json(
      { error: "연구원 비밀번호는 숫자 6자리여야 합니다" },
      { status: 400 },
    );
  }

  const id = normalizeUsername(username);
  const email = toInternalEmail(id);
  const admin = createAdminClient();

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: displayName },
  });

  if (error || !data.user) {
    const msg = (error?.message ?? "").toLowerCase();
    if (msg.includes("already") || msg.includes("registered")) {
      return NextResponse.json({ error: "이미 사용 중인 ID입니다" }, { status: 409 });
    }
    return NextResponse.json(
      { error: "계정 생성에 실패했습니다" },
      { status: 500 },
    );
  }

  const { data: profile, error: updateError } = await admin
    .from("profiles")
    .update({
      role,
      display_name: displayName,
      disabled: false,
      contact_email: contactEmail,
      phone,
    })
    .eq("id", data.user.id)
    .select()
    .single();

  if (updateError || !profile) {
    return NextResponse.json(
      { error: "프로필 동기화에 실패했습니다. 사용자 목록에서 역할을 확인하세요." },
      { status: 500 },
    );
  }

  return NextResponse.json({ profile, id }, { status: 201 });
}
