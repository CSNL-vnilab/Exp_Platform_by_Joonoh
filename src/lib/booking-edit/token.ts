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
import { resolveSecret } from "@/lib/auth/secret-source";

const MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000; // 60 days
export const BOOKING_EDIT_TOKEN_TTL_MS = MAX_AGE_MS;

function getKey(): Buffer {
  // resolveSecret centralizes the fallback chain + warns once when we
  // fall through to SUPABASE_SERVICE_ROLE_KEY (60-day token TTL means
  // a service-role rotation can silently dead-letter weeks of issued
  // edit links). See src/lib/auth/secret-source.ts.
  const source = resolveSecret({
    primary: "BOOKING_EDIT_TOKEN_SECRET",
    fallbacks: [
      "PAYMENT_TOKEN_SECRET",
      "RUN_TOKEN_SECRET",
      "REGISTRATION_SECRET",
    ],
    purpose: "booking-edit token signing key",
  });
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
