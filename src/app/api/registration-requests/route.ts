import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod/v4";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptString } from "@/lib/crypto/symmetric";
import { sendEmail } from "@/lib/google/gmail";
import { USERNAME_REGEX, PASSWORD_REGEX, normalizeUsername, toInternalEmail } from "@/lib/auth/username";
import { getCurrentProfile } from "@/lib/auth/role";
import { BRAND_NAME, BRAND_CONTACT_EMAIL } from "@/lib/branding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Approvals are emailed to the lab's own contact inbox (same address
// participants already see on the booking confirmation page). Override per
// deployment with NEXT_PUBLIC_LAB_CONTACT_EMAIL.
const APPROVAL_EMAIL =
  process.env.LAB_APPROVAL_EMAIL || BRAND_CONTACT_EMAIL;

const bodySchema = z.object({
  username: z.string().regex(USERNAME_REGEX, "ID는 영문 3~4자여야 합니다"),
  password: z.string().regex(PASSWORD_REGEX, "비밀번호는 숫자 6자리여야 합니다"),
  displayName: z.string().trim().min(1).max(60),
  contactEmail: z.string().email("올바른 이메일 형식이 아닙니다").max(254),
  phone: z
    .string()
    .regex(/^01[0-9]-?\d{3,4}-?\d{4}$/, "올바른 전화번호 형식이 아닙니다"),
});

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

// Public endpoint: researcher submits a registration request.
export async function POST(request: NextRequest) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "잘못된 요청입니다" },
      { status: 400 },
    );
  }

  const username = normalizeUsername(parsed.data.username);
  const admin = createAdminClient();

  // Reject if a profile (existing user) already owns this ID.
  const { data: existingProfile } = await admin
    .from("profiles")
    .select("id")
    .eq("email", toInternalEmail(username))
    .maybeSingle();
  if (existingProfile) {
    return NextResponse.json({ error: "이미 사용 중인 ID입니다" }, { status: 409 });
  }

  const blob = encryptString(parsed.data.password);

  const { data: inserted, error } = await admin
    .from("registration_requests")
    .insert({
      username,
      display_name: parsed.data.displayName.trim(),
      password_cipher: blob.cipher.toString("base64"),
      password_iv: blob.iv.toString("base64"),
      password_tag: blob.tag.toString("base64"),
      contact_email: parsed.data.contactEmail,
      phone: parsed.data.phone,
    })
    .select()
    .single();

  if (error || !inserted) {
    // unique violation (username_format or pending duplicate)
    const code = error?.code === "23505" ? 409 : 500;
    const msg =
      code === 409
        ? "이미 동일한 ID로 대기 중인 요청이 있습니다"
        : "요청 접수에 실패했습니다";
    return NextResponse.json({ error: msg }, { status: code });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  const approveUrl = appUrl ? `${appUrl}/users` : "(웹 콘솔의 /users 페이지)";

  // Fire-and-forget email notification. We don't block request success on
  // email delivery — the admin can still see pending rows on /users.
  sendEmail(
    APPROVAL_EMAIL,
    `[${BRAND_NAME}] 연구원 등록 요청 — ${username}`,
    `<div style="font-family:sans-serif;line-height:1.6">
      <h2>새로운 연구원 등록 요청</h2>
      <ul>
        <li><b>ID:</b> ${escapeHtml(username)}</li>
        <li><b>이름:</b> ${escapeHtml(parsed.data.displayName.trim())}</li>
        <li><b>요청 시각:</b> ${escapeHtml(inserted.requested_at)}</li>
      </ul>
      <p>관리자 승인: <a href="${escapeHtml(approveUrl)}">${escapeHtml(approveUrl)}</a></p>
      <p style="color:#666;font-size:12px">이 메일은 ${BRAND_NAME} 예약 시스템에서 자동 발송되었습니다.</p>
    </div>`,
  ).catch(() => {
    // swallow — already logged in sendEmail, and DB row exists
  });

  return NextResponse.json(
    { id: inserted.id, username: inserted.username },
    { status: 202 },
  );
}

// Admin-only: list pending requests. Used to hydrate the /users panel.
export async function GET() {
  const me = await getCurrentProfile();
  if (!me || me.role !== "admin" || me.disabled) {
    return NextResponse.json({ error: "관리자 권한이 필요합니다" }, { status: 403 });
  }

  const admin = createAdminClient();
  const { data } = await admin
    .from("registration_requests")
    .select("id, username, display_name, status, requested_at")
    .eq("status", "pending")
    .order("requested_at", { ascending: true });

  return NextResponse.json({ requests: data ?? [] });
}
