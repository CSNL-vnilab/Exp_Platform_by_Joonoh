import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Signed token that gates /payment-info/[token] submission. Same shape as
// Stream 2's run-token:
//   `${bookingGroupId}.${issuedAtMs}.${nonceB64url}.${sigB64url}`
//
// Why not reuse run-token.ts directly: run tokens are per-booking, payment
// tokens are per-booking-group, and a different TTL / revocation surface
// makes more sense to keep separate.
//
// The SHA-256 hash of the whole token string is stored in
// participant_payment_info.token_hash. Verification is stateless-first
// (HMAC check) and then the hash is matched against the DB row — that's
// how revocation works: DB row gone / hash differs / token_revoked_at set
// → reject.

const MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000; // 60 days
export const PAYMENT_TOKEN_TTL_MS = MAX_AGE_MS;

function getKey(): Buffer {
  const source =
    process.env.PAYMENT_TOKEN_SECRET ??
    process.env.RUN_TOKEN_SECRET ??
    process.env.REGISTRATION_SECRET ??
    process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!source) {
    throw new Error(
      "PAYMENT_TOKEN_SECRET (or fallback) must be set to issue payment-info tokens",
    );
  }
  return createHash("sha256").update(source).digest();
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sign(payload: string): string {
  return b64url(createHmac("sha256", getKey()).update(payload).digest());
}

export interface IssuedPaymentToken {
  token: string;
  hash: string;
  issuedAt: number;
  expiresAt: number;
}

export function issuePaymentToken(bookingGroupId: string): IssuedPaymentToken {
  const nonce = b64url(randomBytes(16));
  const issuedAt = Date.now();
  const payload = `${bookingGroupId}.${issuedAt}.${nonce}`;
  const sig = sign(payload);
  const token = `${payload}.${sig}`;
  const hash = createHash("sha256").update(token).digest("hex");
  return {
    token,
    hash,
    issuedAt,
    expiresAt: issuedAt + MAX_AGE_MS,
  };
}

export type PaymentTokenErrorCode =
  | "SHAPE"
  | "SIGNATURE"
  | "EXPIRED"
  | "GROUP_MISMATCH";

export class PaymentTokenError extends Error {
  code: PaymentTokenErrorCode;
  constructor(code: PaymentTokenErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface VerifiedPaymentToken {
  bookingGroupId: string;
  issuedAt: number;
  hash: string;
}

export function verifyPaymentToken(
  token: string,
  expectedBookingGroupId?: string,
): VerifiedPaymentToken {
  const parts = token.split(".");
  if (parts.length !== 4) {
    throw new PaymentTokenError("SHAPE", "Malformed token");
  }
  const [bookingGroupId, issuedAtStr, nonce, sig] = parts;
  const issuedAt = Number(issuedAtStr);
  if (!Number.isFinite(issuedAt)) {
    throw new PaymentTokenError("SHAPE", "Bad issuedAt");
  }
  if (Date.now() - issuedAt > MAX_AGE_MS) {
    throw new PaymentTokenError("EXPIRED", "Token expired");
  }

  const payload = `${bookingGroupId}.${issuedAtStr}.${nonce}`;
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new PaymentTokenError("SIGNATURE", "Bad signature");
  }

  if (expectedBookingGroupId && expectedBookingGroupId !== bookingGroupId) {
    throw new PaymentTokenError("GROUP_MISMATCH", "Token group mismatch");
  }

  const hash = createHash("sha256").update(token).digest("hex");
  return { bookingGroupId, issuedAt, hash };
}

export function hashPaymentToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
