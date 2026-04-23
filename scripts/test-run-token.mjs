#!/usr/bin/env node
// Unit test for src/lib/experiments/run-token.ts — exercised via a JS mirror
// since the TS module uses Node's crypto API directly. No DB, no server.
//
// Covers:
//   * round-trip (issue → verify)
//   * tampered signature rejected
//   * wrong bookingId rejected
//   * expired token rejected
//   * malformed token rejected
//   * hash stability (two issues → two distinct hashes)

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envText = await readFile(join(__dirname, "..", ".env.local"), "utf8").catch(() => "");
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
}

const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

function getKey() {
  const src =
    process.env.RUN_TOKEN_SECRET ??
    process.env.REGISTRATION_SECRET ??
    process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!src) throw new Error("no secret");
  return createHash("sha256").update(src).digest();
}

function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function issue(bookingId, overrideIssuedAt) {
  const nonce = b64url(randomBytes(16));
  const issuedAt = overrideIssuedAt ?? Date.now();
  const payload = `${bookingId}.${issuedAt}.${nonce}`;
  const sig = b64url(createHmac("sha256", getKey()).update(payload).digest());
  const token = `${payload}.${sig}`;
  return { token, hash: createHash("sha256").update(token).digest("hex") };
}

function verify(token, expectedBookingId) {
  const parts = token.split(".");
  if (parts.length !== 4) return { ok: false, code: "SHAPE" };
  const [bookingId, issuedAtStr, nonce, sig] = parts;
  const issuedAt = Number(issuedAtStr);
  if (!Number.isFinite(issuedAt)) return { ok: false, code: "SHAPE" };
  if (Date.now() - issuedAt > MAX_AGE_MS) return { ok: false, code: "EXPIRED" };
  const expected = b64url(
    createHmac("sha256", getKey()).update(`${bookingId}.${issuedAtStr}.${nonce}`).digest(),
  );
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, code: "SIGNATURE" };
  if (expectedBookingId && bookingId !== expectedBookingId)
    return { ok: false, code: "BOOKING_MISMATCH" };
  return { ok: true, bookingId, issuedAt, nonce };
}

const results = [];
function t(name, passed, extra) {
  results.push({ name, passed, ...(extra ?? {}) });
  console.log(`  ${passed ? "✓" : "✗"} ${name}`);
}

const B = "11111111-2222-3333-4444-555555555555";
const C = "99999999-8888-7777-6666-555555555555";

const i1 = issue(B);
t("round-trip verify", verify(i1.token, B).ok === true);

// Tampered last byte of sig
const tampered = i1.token.slice(0, -1) + (i1.token.slice(-1) === "a" ? "b" : "a");
t("tampered signature rejected", verify(tampered, B).code === "SIGNATURE");

// Wrong expected bookingId
t("bookingId mismatch rejected", verify(i1.token, C).code === "BOOKING_MISMATCH");

// Malformed
t("malformed token rejected", verify("garbage", B).code === "SHAPE");
t("wrong parts count rejected", verify("a.b.c", B).code === "SHAPE");

// Expired
const expired = issue(B, Date.now() - (MAX_AGE_MS + 1000));
t("expired token rejected", verify(expired.token, B).code === "EXPIRED");

// Hash stability
const i2 = issue(B);
t("two issues produce distinct hashes", i1.hash !== i2.hash);
t("same issue yields same hash", i1.hash === createHash("sha256").update(i1.token).digest("hex"));

const failed = results.filter((r) => !r.passed);
console.log("─".repeat(60));
console.log(`${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) {
  console.error("FAIL:", JSON.stringify(failed, null, 2));
  process.exit(1);
}
