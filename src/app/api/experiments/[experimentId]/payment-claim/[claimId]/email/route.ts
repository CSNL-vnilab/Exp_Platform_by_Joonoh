import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidUUID } from "@/lib/utils/validation";
import { requireExperimentAccess } from "@/lib/auth/experiment-access";
import { buildPaymentClaimEmail } from "@/lib/services/payment-claim-email";
import { sendEmail } from "@/lib/google/gmail";
import { scrubPii } from "@/lib/observability/pii";

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

// Server-side recipient domain allowlist (S4 PII finding).
//
// The dispatch email carries plaintext RRN, bank account numbers, and
// bankbook-copy attachments. The client modal lets a researcher type an
// arbitrary recipient, so the server — not the client — must be the
// source of truth on where that PII is allowed to land. We gate sends to
// a small env-driven allowlist of administrative / lab domains.
//
// Subdomains are honoured: an address on a subdomain of an allowlisted
// domain (e.g. dept.snu.ac.kr) passes because we match `endsWith("." + d)`
// in addition to the exact `endsWith("@" + d)` apex match.
// Default recipient allowlist confirmed by the lab operator (2026-06-12):
// 행정실/담당자 주소가 snu.ac.kr · gmail.com · naver.com 중 하나.
// Override per-deploy via PAYMENT_CLAIM_ALLOWED_DOMAINS (comma-separated).
const ALLOWED_RECIPIENT_DOMAINS = (
  process.env.PAYMENT_CLAIM_ALLOWED_DOMAINS ?? "snu.ac.kr,gmail.com,naver.com"
)
  .split(",")
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

// True when `email`'s domain is the allowlisted apex (user@snu.ac.kr) or
// any subdomain of it (user@dept.snu.ac.kr). Case-insensitive; operates
// on the full address so a crafted local-part can't spoof the suffix
// (e.g. "x@evil.com?snu.ac.kr" never endsWith("@snu.ac.kr")).
function isRecipientDomainAllowed(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  return ALLOWED_RECIPIENT_DOMAINS.some(
    (d) => normalized.endsWith("@" + d) || normalized.endsWith("." + d),
  );
}

const sendBodySchema = z.object({
  // Recipient email — researcher can override the default LAB_ADMIN_EMAIL
  // env value in the modal (different deans / different terms have
  // different admin emails).
  //
  // Domain allowlist refine (S4): the body is the only place a recipient
  // is chosen, so this is where the server enforces the allowlist. A
  // rejection here surfaces through the existing Zod-catch path → stampError
  // (scrubPii'd) → 400. Never trust the client's own check.
  recipientEmail: z
    .string()
    .email()
    .max(254)
    .refine(isRecipientDomainAllowed, {
      message: `수신 도메인이 허용 목록에 없습니다 (허용: ${ALLOWED_RECIPIENT_DOMAINS.join(", ")})`,
    }),
  // Force flag — frontend must explicitly opt in. Belt-and-suspenders
  // against accidental single-button auto-sends.
  confirm: z.literal(true),
});

// Wraps the shared requireExperimentAccess helper with the extra
// researcher-profile fields this route needs for the dispatch email
// envelope (display_name → "발송자명", contact_email → reply-to + CC).
// Returns the same flat shape the callers used pre-refactor so GET /
// POST bodies don't need changes.
async function loadAuthContext(experimentId: string) {
  const access = await requireExperimentAccess(experimentId, {
    extraColumns: "title",
  });
  if (access instanceof NextResponse) {
    const body = (await access.json()) as { error?: string };
    return {
      ok: false as const,
      status: access.status,
      error: body.error ?? "Forbidden",
    };
  }
  const { user, admin } = access;
  const experimentRow = access.experiment as unknown as {
    id: string;
    created_by: string | null;
    title: string | null;
  };
  // Profile lookup for the email envelope. The role check already
  // happened inside requireExperimentAccess; we only need
  // display_name + contact_email here.
  const { data: profile } = await admin
    .from("profiles")
    .select("display_name, contact_email")
    .eq("id", user.id)
    .maybeSingle();
  const researcherName =
    (profile as { display_name: string | null } | null)?.display_name ??
    "연구자";
  const researcherReplyEmail =
    (profile as { contact_email: string | null } | null)?.contact_email ??
    null;
  // CC the researcher's primary email so they have a record of every
  // dispatch in their own inbox. Prefer contact_email; fall back to
  // auth.users.email so the field is never null in practice.
  const ccEmail = researcherReplyEmail ?? user.email ?? null;
  return {
    ok: true as const,
    user,
    admin,
    experiment: {
      id: experimentRow.id,
      title: experimentRow.title ?? "experiment",
      created_by: experimentRow.created_by ?? "",
    },
    researcherName,
    researcherReplyEmail,
    ccEmail,
  };
}

function defaultRecipient(): string {
  return process.env.LAB_ADMIN_EMAIL ?? "";
}

// Stamp a failure on payment_claims so the UI can surface "마지막 시도
// ... 실패" inside the modal without reaching for Vercel runtime logs.
// Best-effort — if THIS update fails too we just log and move on.
async function stampError(
  admin: ReturnType<typeof createAdminClient>,
  claimId: string,
  message: string,
): Promise<void> {
  // Scrub before persisting — callers pass SMTP / payload-build errors
  // that can echo the recipient envelope (email) or decrypted RRN /
  // bankbook detail. Single chokepoint so every caller inherits the
  // redaction (A6 / hidden-couplings #1, extended to payment_claims in
  // iter 38). Internal Zod-validation messages carry no PII but the
  // scrub is a harmless no-op on them.
  const truncated = scrubPii(message).slice(0, 500);
  const { error } = await admin
    .from("payment_claims")
    .update({
      email_last_error: truncated,
      email_last_error_at: new Date().toISOString(),
    })
    .eq("id", claimId);
  if (error) {
    console.error(
      `[PaymentClaimEmail] failed to stamp error on claim ${claimId}: ${error.message}`,
    );
  }
}

// Bump attempt counter at request start so we can tell "researcher
// clicked 발송 but request never reached the route" (attempts == 0) from
// "request reached the route and failed for X reason" (attempts > 0).
async function stampAttempt(
  admin: ReturnType<typeof createAdminClient>,
  claimId: string,
): Promise<void> {
  const { data } = await admin
    .from("payment_claims")
    .select("email_attempt_count")
    .eq("id", claimId)
    .maybeSingle();
  const next =
    ((data as { email_attempt_count: number } | null)?.email_attempt_count ??
      0) + 1;
  const { error } = await admin
    .from("payment_claims")
    .update({ email_attempt_count: next })
    .eq("id", claimId);
  if (error) {
    console.error(
      `[PaymentClaimEmail] failed to bump attempts on claim ${claimId}: ${error.message}`,
    );
  }
}

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ experimentId: string; claimId: string }> },
) {
  const { experimentId, claimId } = await ctx.params;
  console.log(
    `[PaymentClaimEmail][GET] preview experiment=${experimentId} claim=${claimId}`,
  );
  if (!isValidUUID(claimId)) {
    console.warn(`[PaymentClaimEmail][GET] invalid claim id "${claimId}"`);
    return NextResponse.json({ error: "Invalid claim ID" }, { status: 400 });
  }
  const auth = await loadAuthContext(experimentId);
  if (!auth.ok) {
    console.warn(
      `[PaymentClaimEmail][GET] auth ${auth.status} — ${auth.error}`,
    );
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  // Already-sent + last-error snapshot so the UI can show context
  // when the modal opens (success badge OR "마지막 시도 실패: …").
  const { data: claimMeta } = await auth.admin
    .from("payment_claims")
    .select(
      "email_sent_at, email_sent_to, email_message_id, email_last_error, email_last_error_at, email_attempt_count",
    )
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
      ccEmail: auth.ccEmail,
      includeAttachments: false,
    });
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : "Failed to build email preview";
    console.error(`[PaymentClaimEmail][GET] preview build throw: ${msg}`, err);
    // Don't stamp this on the claim row — preview is read-only and a
    // bad preview attempt isn't a "send attempt".
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  console.log(
    `[PaymentClaimEmail][GET] preview OK — ${payload.meta.attachmentNames.length} attachments, to=${payload.to}, cc=${payload.cc ?? "-"}`,
  );

  const claimSnapshot = claimMeta as {
    email_sent_at: string | null;
    email_sent_to: string | null;
    email_message_id: string | null;
    email_last_error: string | null;
    email_last_error_at: string | null;
    email_attempt_count: number | null;
  } | null;

  return NextResponse.json({
    preview: {
      subject: payload.subject,
      to: payload.to,
      cc: payload.cc,
      replyTo: payload.replyTo,
      html: payload.html,
      text: payload.text,
      meta: payload.meta,
    },
    alreadySent: claimSnapshot?.email_sent_at
      ? {
          sentAt: claimSnapshot.email_sent_at,
          sentTo: claimSnapshot.email_sent_to,
          messageId: claimSnapshot.email_message_id,
        }
      : null,
    lastError: claimSnapshot?.email_last_error
      ? {
          message: claimSnapshot.email_last_error,
          at: claimSnapshot.email_last_error_at,
          attempts: claimSnapshot.email_attempt_count ?? 0,
        }
      : null,
  });
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ experimentId: string; claimId: string }> },
) {
  const { experimentId, claimId } = await ctx.params;
  console.log(
    `[PaymentClaimEmail][POST] start experiment=${experimentId} claim=${claimId}`,
  );

  if (!isValidUUID(claimId)) {
    console.warn(`[PaymentClaimEmail][POST] invalid claim id "${claimId}"`);
    return NextResponse.json({ error: "Invalid claim ID" }, { status: 400 });
  }
  const auth = await loadAuthContext(experimentId);
  if (!auth.ok) {
    console.warn(
      `[PaymentClaimEmail][POST] auth ${auth.status} — ${auth.error}`,
    );
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  // Bump attempt count + clear stale error eagerly. Even if the request
  // ultimately fails the bump records "they tried" — useful when the
  // researcher reports "the button doesn't work" and we want to know
  // whether the request hit the server at all.
  await stampAttempt(auth.admin, claimId);

  let body: z.infer<typeof sendBodySchema>;
  try {
    body = sendBodySchema.parse(await req.json());
  } catch (err) {
    const msg =
      err instanceof z.ZodError
        ? `Invalid request: ${err.issues[0]?.message ?? "validation failed"}`
        : "Invalid request body";
    console.warn(`[PaymentClaimEmail][POST] body parse: ${msg}`);
    await stampError(auth.admin, claimId, msg);
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  // Build payload with attachments. This is the expensive call —
  // re-fetches rows + downloads bankbooks + decrypts RRN + rebuilds
  // workbooks. Most likely failure source.
  let payload;
  try {
    payload = await buildPaymentClaimEmail({
      supabase: auth.admin,
      experimentId,
      claimId,
      recipientEmail: body.recipientEmail,
      researcherName: auth.researcherName,
      researcherReplyEmail: auth.researcherReplyEmail,
      ccEmail: auth.ccEmail,
      includeAttachments: true,
    });
    console.log(
      `[PaymentClaimEmail][POST] payload built — ${payload.attachments.length} attachments, total ${payload.attachments.reduce((a, x) => a + x.content.length, 0)} bytes`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to build payload";
    console.error(`[PaymentClaimEmail][POST] buildPayload throw: ${msg}`, err);
    await stampError(auth.admin, claimId, `payload build: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  // Send via Gmail SMTP. CC the researcher so they have a record of
  // every dispatch in their own inbox.
  let result: Awaited<ReturnType<typeof sendEmail>>;
  try {
    result = await sendEmail({
      to: payload.to,
      cc: payload.cc ?? undefined,
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
      replyTo: payload.replyTo ?? undefined,
      attachments: payload.attachments,
    });
  } catch (err) {
    // sendEmail catches its own errors and returns { success: false }
    // but if nodemailer throws (e.g. transport init), it propagates.
    const msg = err instanceof Error ? err.message : "SMTP error";
    console.error(`[PaymentClaimEmail][POST] sendEmail throw: ${msg}`, err);
    await stampError(auth.admin, claimId, `smtp throw: ${msg}`);
    return NextResponse.json(
      { error: `이메일 전송 실패: ${msg}` },
      { status: 502 },
    );
  }

  if (!result.success) {
    const msg = result.error ?? "unknown";
    console.error(`[PaymentClaimEmail][POST] sendEmail !ok: ${msg}`);
    await stampError(auth.admin, claimId, `smtp: ${msg}`);
    return NextResponse.json(
      { error: `이메일 전송 실패: ${msg}` },
      { status: 502 },
    );
  }

  // Success — stamp the audit columns and clear any stale error.
  const { error: updateErr } = await auth.admin
    .from("payment_claims")
    .update({
      email_sent_at: new Date().toISOString(),
      email_sent_to: payload.to,
      email_message_id: result.messageId ?? null,
      email_last_error: null,
      email_last_error_at: null,
    })
    .eq("id", claimId);
  if (updateErr) {
    // Email already went out — but the audit row update failed. Log
    // loudly so we can reconcile, but don't 5xx the request (the
    // researcher already got a success toast in the UI).
    console.error(
      `[PaymentClaimEmail][POST] post-send audit update failed: ${updateErr.message}`,
    );
  }

  console.log(
    `[PaymentClaimEmail][POST] OK messageId=${result.messageId} to=${payload.to}`,
  );
  return NextResponse.json({
    success: true,
    messageId: result.messageId ?? null,
    sentTo: payload.to,
    attachmentCount: payload.attachments.length,
  });
}
