import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidUUID } from "@/lib/utils/validation";
import { buildPaymentClaimEmail } from "@/lib/services/payment-claim-email";
import { sendEmail } from "@/lib/google/gmail";

// /api/experiments/:experimentId/payment-claim/:claimId/email
//
// 행정 dispatch email — preview + send. Two-stage flow:
//
//   GET   → returns the preview payload (subject / body / recipient /
//           attachment names) so the frontend can render a confirmation
//           modal. No attachments are built (cheap).
//   POST  → re-builds attachments, sends via Gmail SMTP, stamps
//           payment_claims.{email_sent_at, email_sent_to, message_id}.
//
// User flow guard: this route NEVER auto-fires. The /payment-claim
// endpoint that creates the bundle does NOT trigger an email; the
// frontend has to make a deliberate POST here after the researcher
// confirms in a modal. The "preview vs send" split is at this URL: GET
// is read-only, POST has side effects.
//
// Auth: experiment owner or admin.

const sendBodySchema = z.object({
  // Recipient email — researcher can override the default LAB_ADMIN_EMAIL
  // env value in the modal (different deans / different terms have
  // different admin emails).
  recipientEmail: z.string().email().max(254),
  // Force flag — frontend must explicitly opt in. Belt-and-suspenders
  // against accidental single-button auto-sends.
  confirm: z.literal(true),
});

async function loadAuthContext(
  experimentId: string,
): Promise<
  | { ok: true; user: Awaited<ReturnType<Awaited<ReturnType<typeof createClient>>["auth"]["getUser"]>>["data"]["user"]; admin: ReturnType<typeof createAdminClient>; experiment: { id: string; title: string; created_by: string }; researcherName: string; researcherReplyEmail: string | null }
  | { ok: false; status: number; error: string }
> {
  if (!isValidUUID(experimentId)) {
    return { ok: false, status: 400, error: "Invalid experiment ID" };
  }
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }
  const admin = createAdminClient();
  const { data: experiment } = await admin
    .from("experiments")
    .select("id, title, created_by")
    .eq("id", experimentId)
    .maybeSingle();
  if (!experiment) {
    return { ok: false, status: 404, error: "Experiment not found" };
  }
  const { data: profile } = await admin
    .from("profiles")
    .select("role, display_name, contact_email")
    .eq("id", user.id)
    .maybeSingle();
  const isOwner = experiment.created_by === user.id;
  const isAdmin = profile?.role === "admin";
  if (!isOwner && !isAdmin) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  const researcherName =
    (profile as { display_name: string | null } | null)?.display_name ??
    "연구자";
  const researcherReplyEmail =
    (profile as { contact_email: string | null } | null)?.contact_email ??
    null;
  return {
    ok: true,
    user,
    admin,
    experiment: experiment as { id: string; title: string; created_by: string },
    researcherName,
    researcherReplyEmail,
  };
}

function defaultRecipient(): string {
  return process.env.LAB_ADMIN_EMAIL ?? "";
}

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ experimentId: string; claimId: string }> },
) {
  const { experimentId, claimId } = await ctx.params;
  if (!isValidUUID(claimId)) {
    return NextResponse.json({ error: "Invalid claim ID" }, { status: 400 });
  }
  const auth = await loadAuthContext(experimentId);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  // Already-sent? Return the recorded snapshot so the UI can show
  // "발송됨 yyyy-mm-dd → recipient" instead of letting the researcher
  // double-send by accident.
  const { data: claimMeta } = await auth.admin
    .from("payment_claims")
    .select("email_sent_at, email_sent_to, email_message_id")
    .eq("id", claimId)
    .maybeSingle();

  let payload;
  try {
    payload = await buildPaymentClaimEmail({
      supabase: auth.admin,
      experimentId,
      claimId,
      recipientEmail: defaultRecipient(),
      researcherName: auth.researcherName,
      researcherReplyEmail: auth.researcherReplyEmail,
      includeAttachments: false,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Failed to build email preview",
      },
      { status: 500 },
    );
  }

  return NextResponse.json({
    preview: {
      subject: payload.subject,
      to: payload.to,
      replyTo: payload.replyTo,
      html: payload.html,
      text: payload.text,
      meta: payload.meta,
    },
    alreadySent: claimMeta?.email_sent_at
      ? {
          sentAt: claimMeta.email_sent_at,
          sentTo: claimMeta.email_sent_to,
          messageId: claimMeta.email_message_id,
        }
      : null,
  });
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ experimentId: string; claimId: string }> },
) {
  const { experimentId, claimId } = await ctx.params;
  if (!isValidUUID(claimId)) {
    return NextResponse.json({ error: "Invalid claim ID" }, { status: 400 });
  }
  const auth = await loadAuthContext(experimentId);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  let body: z.infer<typeof sendBodySchema>;
  try {
    body = sendBodySchema.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof z.ZodError
            ? `Invalid request: ${err.issues[0]?.message ?? "validation failed"}`
            : "Invalid request body",
      },
      { status: 400 },
    );
  }

  // Build payload with attachments (this is the expensive call —
  // re-fetches rows + downloads bankbooks + decrypts RRN + rebuilds
  // workbooks).
  let payload;
  try {
    payload = await buildPaymentClaimEmail({
      supabase: auth.admin,
      experimentId,
      claimId,
      recipientEmail: body.recipientEmail,
      researcherName: auth.researcherName,
      researcherReplyEmail: auth.researcherReplyEmail,
      includeAttachments: true,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Failed to build email payload",
      },
      { status: 500 },
    );
  }

  // Send via Gmail SMTP.
  const result = await sendEmail({
    to: payload.to,
    subject: payload.subject,
    html: payload.html,
    text: payload.text,
    replyTo: payload.replyTo ?? undefined,
    attachments: payload.attachments,
  });

  if (!result.success) {
    return NextResponse.json(
      { error: `이메일 전송 실패: ${result.error ?? "unknown"}` },
      { status: 502 },
    );
  }

  // Stamp the audit columns.
  await auth.admin
    .from("payment_claims")
    .update({
      email_sent_at: new Date().toISOString(),
      email_sent_to: payload.to,
      email_message_id: result.messageId ?? null,
    })
    .eq("id", claimId);

  return NextResponse.json({
    success: true,
    messageId: result.messageId ?? null,
    sentTo: payload.to,
    attachmentCount: payload.attachments.length,
  });
}
