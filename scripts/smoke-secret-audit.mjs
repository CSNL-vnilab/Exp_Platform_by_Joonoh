#!/usr/bin/env node
// Post-deploy smoke: hits /api/health/secret-audit with the cron secret
// and reports whether any token-secret module fell through to
// SUPABASE_SERVICE_ROLE_KEY (= rotation footgun, refactor-roadmap A3).
//
// Use after a deploy to confirm the per-token secrets are explicitly set:
//   - PAYMENT_TOKEN_SECRET, BOOKING_EDIT_TOKEN_SECRET,
//     BOOKING_EDIT_SESSION_SECRET, RUN_TOKEN_SECRET, REGISTRATION_SECRET
//
// Reads the same .env.local conventions as the other smoke scripts —
// NEXT_PUBLIC_APP_URL + CRON_SECRET.
//
// Exit codes:
//   0 — every module resolves from a non-SUPABASE_SERVICE_ROLE_KEY source
//   1 — at least one module falls through (operator action needed)
//   2 — env misconfigured or endpoint unreachable

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dirname, "..", ".env.local");

async function loadEnv() {
  const text = await readFile(ENV_PATH, "utf8").catch(() => "");
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    if (!process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
    }
  }
}
await loadEnv();

const base = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
const secret = process.env.CRON_SECRET ?? "";

if (!base) {
  console.error("NEXT_PUBLIC_APP_URL is required");
  process.exit(2);
}
if (!secret) {
  console.error("CRON_SECRET is required (same secret cron workflows use)");
  process.exit(2);
}

const url = `${base}/api/health/secret-audit`;
console.log(`Secret-audit smoke against ${url}`);
console.log("─".repeat(64));

let res;
try {
  res = await fetch(url, {
    method: "GET",
    headers: { "x-cron-secret": secret },
  });
} catch (err) {
  console.error(
    "✗ fetch error:",
    err instanceof Error ? err.message : String(err),
  );
  process.exit(2);
}

if (res.status === 401) {
  console.error(
    "✗ 401 unauthorized — CRON_SECRET in .env.local does not match prod",
  );
  process.exit(2);
}
if (!res.ok) {
  console.error(`✗ unexpected HTTP ${res.status}`);
  console.error(await res.text());
  process.exit(2);
}

const body = await res.json();

for (const entry of body.audit ?? []) {
  const mark = entry.fellThroughToServiceRole
    ? "🚨"
    : entry.resolvedFrom === null
      ? "✗ "
      : "✓ ";
  const from = entry.resolvedFrom ?? "(none — module will throw)";
  console.log(
    `  ${mark} ${entry.module.padEnd(28)} ← ${from.padEnd(28)} (ttl ${entry.tokenTtl})`,
  );
}

console.log("─".repeat(64));
if (body.ok) {
  console.log("✓ All token-secret modules resolve from explicit env vars");
  process.exit(0);
}
if (body.anyFellThroughToServiceRole) {
  console.log(
    "🚨 At least one module fell through to SUPABASE_SERVICE_ROLE_KEY.",
  );
  console.log(
    "   Rotating Supabase service role will silently invalidate every",
  );
  console.log(
    "   outstanding token of that kind. Set the missing env vars per",
  );
  console.log("   DEPLOY.md → Token-secret rotation 주의 section.");
}
if (body.anyMissing) {
  console.log(
    "✗ At least one module has no source set at all — handlers will",
  );
  console.log("  throw on first invocation.");
}
process.exit(1);
