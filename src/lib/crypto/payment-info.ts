import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// AES-256-GCM for participant_payment_info.rrn_* columns.
//
// Why its own key instead of sharing src/lib/crypto/symmetric.ts: RRN is
// higher-sensitivity PII than the pending-registration-password use case
// that helper was written for. Different key = different blast radius if
// one is ever leaked.
//
// Rotation plan:
//   - Set PAYMENT_INFO_KEY_V{N} for the current version N.
//   - Bump RRN_ACTIVE_KEY_VERSION to match. New writes use version N.
//   - To rotate: introduce PAYMENT_INFO_KEY_V{N+1}, keep N readable by not
//     unsetting it, bump RRN_ACTIVE_KEY_VERSION. Run a background
//     re-encryption job (decrypt with N, encrypt with N+1, bump the row's
//     rrn_key_version). Once no rows at version N remain, remove the env.
//
// The key itself is SHA-256(env string) — so the env can be any high-entropy
// string (≥32 chars recommended); we derive a fixed 32-byte key from it.

const ACTIVE_VERSION_RAW = process.env.RRN_ACTIVE_KEY_VERSION ?? "1";
const PARSED = Number(ACTIVE_VERSION_RAW);
export const RRN_ACTIVE_KEY_VERSION: number =
  Number.isFinite(PARSED) && PARSED >= 1 ? Math.floor(PARSED) : 1;

function keyEnvName(version: number): string {
  return `PAYMENT_INFO_KEY_V${version}`;
}

// Minimum entropy guard for the env-var source. SHA-256 derivation is fine
// for high-entropy inputs but leaves a low-entropy operator-typed value
// (e.g. "supersecret") trivially brute-forceable. Reject anything under 32
// chars at startup so the misconfiguration fails fast in deploy logs
// instead of silently producing a weak key.
const MIN_KEY_SOURCE_LENGTH = 32;

function deriveKey(source: string, envName: string): Buffer {
  if (source.length < MIN_KEY_SOURCE_LENGTH) {
    throw new Error(
      `${envName} is too short (${source.length} chars; need ≥${MIN_KEY_SOURCE_LENGTH}) — pick a high-entropy random string`,
    );
  }
  return createHash("sha256").update(source).digest();
}

function getKey(version: number): Buffer {
  const envName = keyEnvName(version);
  const source = process.env[envName];
  if (!source) {
    // Fall back to the generic PAYMENT_INFO_KEY so local dev and the first
    // deploy don't require per-version vars. Rotation requires explicit V2.
    if (version === 1 && process.env.PAYMENT_INFO_KEY) {
      return deriveKey(process.env.PAYMENT_INFO_KEY, "PAYMENT_INFO_KEY");
    }
    throw new Error(
      `${envName} must be set to encrypt/decrypt RRN at key version ${version}`,
    );
  }
  return deriveKey(source, envName);
}

export interface EncryptedRrn {
  cipher: Buffer;
  iv: Buffer;
  tag: Buffer;
  keyVersion: number;
}

export function encryptRrn(plaintext: string): EncryptedRrn {
  const version = RRN_ACTIVE_KEY_VERSION;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(version), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { cipher: enc, iv, tag, keyVersion: version };
}

export function decryptRrn(blob: {
  cipher: Buffer;
  iv: Buffer;
  tag: Buffer;
  keyVersion: number;
}): string {
  const decipher = createDecipheriv("aes-256-gcm", getKey(blob.keyVersion), blob.iv);
  decipher.setAuthTag(blob.tag);
  const dec = Buffer.concat([decipher.update(blob.cipher), decipher.final()]);
  return dec.toString("utf8");
}

// ── Token plaintext encryption (P0 #6) ─────────────────────────────────
//
// `participant_payment_info.token_hash` stores SHA-256(token) which is
// non-reversible. To support resending the SAME link to participants who
// already opened it (so their bookmarked URL keeps working — see
// payment-info-notify.service.ts auto-dispatch flow) we additionally
// store the plaintext token AES-256-GCM-encrypted with the same
// PAYMENT_INFO_KEY as RRN. Same key, same threat profile: a service-role
// + DB compromise that grants RRN decrypt also grants token decrypt.
// Tokens have a 60-day TTL and are revoked on submit.

export interface EncryptedToken {
  cipher: Buffer;
  iv: Buffer;
  tag: Buffer;
  keyVersion: number;
}

export function encryptToken(plaintext: string): EncryptedToken {
  const version = RRN_ACTIVE_KEY_VERSION;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(version), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { cipher: enc, iv, tag, keyVersion: version };
}

export function decryptToken(blob: {
  cipher: Buffer;
  iv: Buffer;
  tag: Buffer;
  keyVersion: number;
}): string {
  // Same algorithm as decryptRrn; kept as a separate function for call-
  // site clarity and so future token-only changes (e.g. AAD) don't
  // accidentally break RRN decrypt.
  const decipher = createDecipheriv("aes-256-gcm", getKey(blob.keyVersion), blob.iv);
  decipher.setAuthTag(blob.tag);
  const dec = Buffer.concat([decipher.update(blob.cipher), decipher.final()]);
  return dec.toString("utf8");
}

// Supabase returns bytea as \x-prefixed hex or a Buffer depending on the
// driver path. Normalize both.
export function bytesFromSupabase(value: unknown): Buffer {
  if (value == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") {
    const hex = value.startsWith("\\x") ? value.slice(2) : value;
    return Buffer.from(hex, "hex");
  }
  throw new Error(`Unexpected bytea shape: ${typeof value}`);
}
