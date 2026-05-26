// Booking-edit token — participant self-service for /booking-edit/[token].
//
// Same shape as src/lib/payments/token.ts:
//   `${bookingGroupId}.${issuedAtMs}.${nonceB64url}.${sigB64url}`
//
// Stateless HMAC verification — no DB row. Why not DB-backed: payment-info
// uses a hash row because the payment surface is sensitive (RRN, bank) and
// we want explicit revocation. Booking-edit only allows actions that the
// participant could already trigger by calling the lab — reschedule and
// cancel — so the recovery story (just call the researcher) is simpler.
// If we ever need revocation, add a `booking_edit_token_revoked_at` column
// on booking_groups and check it here.
//
// TTL: 60 days. The token is issued every time a confirmation email goes
// out (runEmail in booking.service.ts + email-retry.service.ts), so a
// participant who needs to edit late re-receives a fresh URL via the
// reminder pipeline. Old tokens stay valid up to TTL.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000; // 60 days
export const BOOKING_EDIT_TOKEN_TTL_MS = MAX_AGE_MS;

function getKey(): Buffer {
  // Fall back through the same secret chain as payment-token so a single
  // env var bootstrap (PAYMENT_TOKEN_SECRET or RUN_TOKEN_SECRET) covers
  // all stateless tokens. SUPABASE_SERVICE_ROLE_KEY is the universal
  // last-resort fallback — it's always set on the server.
  const source =
    process.env.BOOKING_EDIT_TOKEN_SECRET ??
    process.env.PAYMENT_TOKEN_SECRET ??
    process.env.RUN_TOKEN_SECRET ??
    process.env.REGISTRATION_SECRET ??
    process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!source) {
    throw new Error(
      "BOOKING_EDIT_TOKEN_SECRET (or fallback) must be set to issue booking-edit tokens",
    );
  }
  return createHash("sha256").update(source).digest();
}

function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function sign(payload: string): string {
  return b64url(createHmac("sha256", getKey()).update(payload).digest());
}

export interface IssuedBookingEditToken {
  token: string;
  issuedAt: number;
  expiresAt: number;
}

export function issueBookingEditToken(
  bookingGroupId: string,
): IssuedBookingEditToken {
  const nonce = b64url(randomBytes(16));
  const issuedAt = Date.now();
  const payload = `${bookingGroupId}.${issuedAt}.${nonce}`;
  const sig = sign(payload);
  return {
    token: `${payload}.${sig}`,
    issuedAt,
    expiresAt: issuedAt + MAX_AGE_MS,
  };
}

export type BookingEditTokenErrorCode = "SHAPE" | "SIGNATURE" | "EXPIRED";

export class BookingEditTokenError extends Error {
  code: BookingEditTokenErrorCode;
  constructor(code: BookingEditTokenErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface VerifiedBookingEditToken {
  bookingGroupId: string;
  issuedAt: number;
}

export function verifyBookingEditToken(
  token: string,
): VerifiedBookingEditToken {
  const parts = token.split(".");
  if (parts.length !== 4) {
    throw new BookingEditTokenError("SHAPE", "Malformed token");
  }
  const [bookingGroupId, issuedAtStr, nonce, sig] = parts;
  const issuedAt = Number(issuedAtStr);
  if (!Number.isFinite(issuedAt)) {
    throw new BookingEditTokenError("SHAPE", "Bad issuedAt");
  }
  if (Date.now() - issuedAt > MAX_AGE_MS) {
    throw new BookingEditTokenError("EXPIRED", "Token expired");
  }
  const payload = `${bookingGroupId}.${issuedAtStr}.${nonce}`;
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new BookingEditTokenError("SIGNATURE", "Bad signature");
  }
  return { bookingGroupId, issuedAt };
}
