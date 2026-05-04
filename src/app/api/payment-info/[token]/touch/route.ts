// POST /api/payment-info/[token]/touch
//
// P0-Ε: stamp payment_link_first_opened_at — but only when called by
// a real browser that has actually rendered the form. The previous
// implementation stamped on every server-side page render, which let
// any party who got the URL (email forwarding, spam-preview pane,
// browser sync to a family member, shoulder-surf) trip the flag. That
// flag controls token-preserve behavior in payment-info-notify.service;
// a tripped flag pins the same token alive for the 60-day TTL even
// when the legitimate participant never opened it.
//
// Now: PaymentInfoForm's mount effect fires this after first render.
// Bots / link-previewers that don't execute JS won't hit it.
//
// Auth: token HMAC + DB-hash compare-and-swap. We never trust the
// caller — verify like /submit does, just lighter (no body to parse).
//
// Rate-limited per-IP and per-token (much looser than /submit since
// this is only a stamp, but still bounded against abuse).

import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifyPaymentToken, PaymentTokenError } from "@/lib/payments/token";
import { rateLimit } from "@/lib/utils/rate-limit";

// 30 stamps/min per IP and per token — generous (each touches the DB
// only on the FIRST stamp; subsequent calls no-op via the CAS WHERE
// payment_link_first_opened_at IS NULL filter), but capped so a
// pathological client/bot can't fill the rate-limit map.
const PER_IP_OPTS = { windowMs: 60_000, max: 30 } as const;
const PER_TOKEN_OPTS = { windowMs: 60_000, max: 30 } as const;

function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const xri = req.headers.get("x-real-ip");
  if (xri) return xri.trim();
  return "unknown";
}

function tokenLimiterKey(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 32);
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params;
  if (!token) {
    return NextResponse.json({ error: "missing token" }, { status: 400 });
  }

  const ip = clientIp(req);
  if (!rateLimit("payment-touch-ip", ip, PER_IP_OPTS).allowed) {
    return NextResponse.json({ error: "rate limit" }, { status: 429 });
  }
  if (!rateLimit("payment-touch-token", tokenLimiterKey(token), PER_TOKEN_OPTS).allowed) {
    return NextResponse.json({ error: "rate limit" }, { status: 429 });
  }

  let verified;
  try {
    verified = verifyPaymentToken(token);
  } catch (err) {
    // Same shape-collapse policy as /submit and /page — never let the
    // response distinguish lifecycle states (revoked vs malformed vs
    // expired) for an unauthenticated caller.
    if (err instanceof PaymentTokenError) {
      return NextResponse.json({ error: "invalid" }, { status: 401 });
    }
    return NextResponse.json({ error: "server" }, { status: 500 });
  }

  const supabase = createAdminClient();

  // Look up the row by booking_group_id (extracted from token), confirm
  // hash + lifecycle, then CAS-stamp first_opened_at.
  const { data: row } = await supabase
    .from("participant_payment_info")
    .select("id, status, token_hash, token_revoked_at, payment_link_first_opened_at")
    .eq("booking_group_id", verified.bookingGroupId)
    .maybeSingle();

  if (!row) return NextResponse.json({ error: "invalid" }, { status: 401 });
  if (row.token_hash !== verified.hash) {
    return NextResponse.json({ error: "invalid" }, { status: 401 });
  }
  if (row.status !== "pending_participant") {
    // Already submitted / claimed / paid — no behavior change needed,
    // and stamping would be misleading. Quiet 200 so the client doesn't
    // log noise.
    return NextResponse.json({ ok: true, skipped: "non-pending" });
  }
  if (row.token_revoked_at) {
    return NextResponse.json({ error: "invalid" }, { status: 401 });
  }
  if (row.payment_link_first_opened_at) {
    // Already stamped — no-op, stay quiet.
    return NextResponse.json({ ok: true, skipped: "already-stamped" });
  }

  // CAS: only stamp if still NULL. Concurrent touches no-op cleanly.
  await supabase
    .from("participant_payment_info")
    .update({ payment_link_first_opened_at: new Date().toISOString() })
    .eq("id", row.id)
    .is("payment_link_first_opened_at", null);

  return NextResponse.json({ ok: true });
}
