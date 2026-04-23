import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Signed token handed to a participant when they open the /run shell.
// Format: `${bookingId}.${issuedAtMs}.${nonceB64url}.${sigB64url}`
//   sig = HMAC-SHA256(bookingId + '.' + issuedAtMs + '.' + nonce, key)
//
// The token is:
//   * Bound to a specific booking (researcher-granted, one booking one token)
//   * Dated (we expire anything older than MAX_AGE_MS to bound replay)
//   * Nonce-carrying so the same booking can rotate tokens if needed
//   * Timing-safe verified so we don't leak token contents via compare timing
//
// A hash of the whole token is also persisted in experiment_run_progress
// (token_hash) so the researcher can revoke it without holding the plaintext.
// The ingestion route validates the signature first (cheap, stateless) and
// then checks the hash against the DB as a second gate.

// 14 days — covers a typical 1-3 week study window. Outlier participants
// who drop off and return later can be reissued a fresh link by the
// researcher via the reissue-run-token endpoint.
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

let warnedAboutFallback = false;

function getKey(): Buffer {
  const explicit = process.env.RUN_TOKEN_SECRET ?? process.env.REGISTRATION_SECRET;
  const source = explicit ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!source) {
    throw new Error(
      "RUN_TOKEN_SECRET, REGISTRATION_SECRET, or SUPABASE_SERVICE_ROLE_KEY must be set",
    );
  }
  // If we fell back to the service-role key, rotating Supabase credentials
  // will silently invalidate every outstanding run token. Warn once per
  // process so deploys without an explicit secret leave a breadcrumb.
  if (!explicit && !warnedAboutFallback) {
    warnedAboutFallback = true;
    console.warn(
      "[run-token] RUN_TOKEN_SECRET not set — deriving HMAC key from " +
        "SUPABASE_SERVICE_ROLE_KEY. Rotating the service role will invalidate " +
        "all participant /run links. Set RUN_TOKEN_SECRET in production.",
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

export interface IssuedToken {
  token: string;
  hash: string; // SHA-256 hex of the token itself (stored in DB)
  nonce: string;
  issuedAt: number;
}

export function issueRunToken(bookingId: string): IssuedToken {
  const nonce = b64url(randomBytes(16));
  const issuedAt = Date.now();
  const payload = `${bookingId}.${issuedAt}.${nonce}`;
  const sig = sign(payload);
  const token = `${payload}.${sig}`;
  const hash = createHash("sha256").update(token).digest("hex");
  return { token, hash, nonce, issuedAt };
}

export interface VerifiedToken {
  bookingId: string;
  issuedAt: number;
  nonce: string;
  hash: string;
}

export type TokenErrorCode = "SHAPE" | "SIGNATURE" | "EXPIRED" | "BOOKING_MISMATCH";

export class TokenError extends Error {
  code: TokenErrorCode;
  constructor(code: TokenErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

// Pure stateless verification — does not touch the DB. Callers must also
// confirm token hash matches experiment_run_progress.token_hash.
export function verifyRunToken(token: string, expectedBookingId?: string): VerifiedToken {
  const parts = token.split(".");
  if (parts.length !== 4) {
    throw new TokenError("SHAPE", "Malformed token");
  }
  const [bookingId, issuedAtStr, nonce, sig] = parts;
  const issuedAt = Number(issuedAtStr);
  if (!Number.isFinite(issuedAt)) {
    throw new TokenError("SHAPE", "Bad issuedAt");
  }
  if (Date.now() - issuedAt > MAX_AGE_MS) {
    throw new TokenError("EXPIRED", "Token expired");
  }

  const payload = `${bookingId}.${issuedAtStr}.${nonce}`;
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new TokenError("SIGNATURE", "Bad signature");
  }

  if (expectedBookingId && expectedBookingId !== bookingId) {
    throw new TokenError("BOOKING_MISMATCH", "Token bookingId mismatch");
  }

  const hash = createHash("sha256").update(token).digest("hex");
  return { bookingId, issuedAt, nonce, hash };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
