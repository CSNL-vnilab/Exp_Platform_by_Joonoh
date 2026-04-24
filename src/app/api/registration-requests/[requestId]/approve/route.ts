import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth/role";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptString } from "@/lib/crypto/symmetric";
import { toInternalEmail } from "@/lib/auth/username";
import { sendRegistrationApprovedEmail } from "@/lib/services/lab-notifications.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const uuidRe =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ requestId: string }> },
) {
  const me = await requireAdmin();
  const { requestId } = await params;
  if (!uuidRe.test(requestId)) {
    return NextResponse.json({ error: "잘못된 요청 ID입니다" }, { status: 400 });
  }

  const admin = createAdminClient();

  const { data: req, error: fetchError } = await admin
    .from("registration_requests")
    .select("*")
    .eq("id", requestId)
    .eq("status", "pending")
    .maybeSingle();

  if (fetchError || !req) {
    return NextResponse.json(
      { error: "대기 중인 등록 요청을 찾을 수 없습니다" },
      { status: 404 },
    );
  }

  let plaintextPassword: string;
  try {
    plaintextPassword = decryptString({
      cipher: Buffer.from(req.password_cipher, "base64"),
      iv: Buffer.from(req.password_iv, "base64"),
      tag: Buffer.from(req.password_tag, "base64"),
    });
  } catch {
    return NextResponse.json(
      { error: "비밀번호 복호화에 실패했습니다. 요청을 거절 후 재신청하게 하세요." },
      { status: 500 },
    );
  }

  const email = toInternalEmail(req.username);
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password: plaintextPassword,
    email_confirm: true,
    user_metadata: { display_name: req.display_name },
  });

  if (createError || !created.user) {
    const msg = createError?.message?.toLowerCase() ?? "";
    if (msg.includes("already") || msg.includes("registered")) {
      // Mark as approved anyway (someone else created the account) and return 409.
      await admin
        .from("registration_requests")
        .update({ status: "approved", processed_at: new Date().toISOString(), processed_by: me.id })
        .eq("id", requestId);
      return NextResponse.json({ error: "이미 동일한 ID가 존재합니다" }, { status: 409 });
    }
    return NextResponse.json({ error: "계정 생성에 실패했습니다" }, { status: 500 });
  }

  // Ensure the profile row (from the auth trigger) carries the right display_name, phone, and contact_email.
  await admin
    .from("profiles")
    .update({
      display_name: req.display_name,
      role: "researcher",
      disabled: false,
      contact_email: req.contact_email,
      phone: req.phone ?? '',
    })
    .eq("id", created.user.id);

  // Mark the request approved and clear sensitive cipher material so the
  // password can no longer be recovered from the row.
  await admin
    .from("registration_requests")
    .update({
      status: "approved",
      processed_at: new Date().toISOString(),
      processed_by: me.id,
      password_cipher: "",
      password_iv: "",
      password_tag: "",
    })
    .eq("id", requestId);

  // Fire-and-forget: notify the requester that their account is live.
  // Awaiting would stretch the approve-endpoint latency; a failed send
  // doesn't undo the account creation so we intentionally don't await.
  sendRegistrationApprovedEmail({
    contact_email: req.contact_email,
    display_name: req.display_name,
    username: req.username,
  }).catch((err) => {
    console.error(
      "[Approve] registration approval email fire-and-forget failed:",
      err instanceof Error ? err.message : err,
    );
  });

  return NextResponse.json({ ok: true, userId: created.user.id });
}
