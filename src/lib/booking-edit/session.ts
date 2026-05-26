// Booking-edit "I am the participant" gate — name + phone identity check
// on top of the URL token. The token alone is bearer-credential: anyone
// who screenshots / forwards / shoulder-surfs the email link can act on
// behalf of the participant. The identity gate adds something only the
// participant should know (their own name + phone as recorded in
// participants).
//
// Verified state is held in a signed, HttpOnly cookie so the participant
// doesn't have to re-enter on every refresh. The cookie is short-lived
// (24h) and scoped to a single bookingGroupId — using a stale cookie
// against a different token's group rejects.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const COOKIE_NAME = "be_session";
const COOKIE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function getKey(): Buffer {
  const source =
    process.env.BOOKING_EDIT_SESSION_SECRET ??
    process.env.BOOKING_EDIT_TOKEN_SECRET ??
    process.env.PAYMENT_TOKEN_SECRET ??
    process.env.RUN_TOKEN_SECRET ??
    process.env.REGISTRATION_SECRET ??
    process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!source) {
    throw new Error(
      "BOOKING_EDIT_SESSION_SECRET (or fallback) must be set to sign booking-edit verify cookies",
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

export interface VerifySession {
  bookingGroupId: string;
  participantId: string;
  verifiedAt: number;
}

// Returns the signed cookie value to set after a successful name+phone
// check. Format: `${bookingGroupId}.${participantId}.${verifiedAt}.${sig}`.
export function issueVerifySession(s: {
  bookingGroupId: string;
  participantId: string;
}): { value: string; maxAgeSeconds: number } {
  const verifiedAt = Date.now();
  const payload = `${s.bookingGroupId}.${s.participantId}.${verifiedAt}`;
  const sig = sign(payload);
  return {
    value: `${payload}.${sig}`,
    maxAgeSeconds: Math.floor(COOKIE_TTL_MS / 1000),
  };
}

// Parses + verifies an incoming cookie. Returns null on any failure
// (malformed, bad signature, expired, group mismatch).
export function readVerifySession(
  raw: string | null | undefined,
  expectedBookingGroupId: string,
): VerifySession | null {
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 4) return null;
  const [bookingGroupId, participantId, verifiedAtStr, sig] = parts;
  if (bookingGroupId !== expectedBookingGroupId) return null;
  const verifiedAt = Number(verifiedAtStr);
  if (!Number.isFinite(verifiedAt)) return null;
  if (Date.now() - verifiedAt > COOKIE_TTL_MS) return null;
  const payload = `${bookingGroupId}.${participantId}.${verifiedAtStr}`;
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { bookingGroupId, participantId, verifiedAt };
}

export const BOOKING_EDIT_SESSION_COOKIE = COOKIE_NAME;
export const BOOKING_EDIT_SESSION_TTL_MS = COOKIE_TTL_MS;
