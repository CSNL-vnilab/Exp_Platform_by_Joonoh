#!/usr/bin/env node
// Hits /api/health/queue and reports the integration-outbox depth per
// integration_type. Companion to smoke-secret-audit.mjs. Returns
// non-zero exit when the endpoint says `ok: false` (= operator should
// look at the backlog).
//
// Usage:
//   node scripts/smoke-queue-depth.mjs
//
// Exit codes:
//   0 — every integration_type within threshold
//   1 — at least one type exceeded failed_warn or
//       oldest_pending_age_warn_sec
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
  console.error("CRON_SECRET is required");
  process.exit(2);
}

const url = `${base}/api/health/queue`;
console.log(`Queue-depth smoke against ${url}`);
console.log("─".repeat(72));

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
  console.error("✗ 401 unauthorized — CRON_SECRET mismatch");
  process.exit(2);
}
if (!res.ok) {
  console.error(`✗ unexpected HTTP ${res.status}`);
  console.error(await res.text());
  process.exit(2);
}

const body = await res.json();
console.log(
  `Thresholds: failed_warn=${body.thresholds.failed_warn}, ` +
    `oldest_pending_age_warn_sec=${body.thresholds.oldest_pending_age_warn_sec}`,
);
console.log("─".repeat(72));

const fmtAge = (sec) => {
  if (sec == null) return "—";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h`;
};

if ((body.queue ?? []).length === 0) {
  console.log("  (no pending/failed rows — queue empty)");
} else {
  console.log(
    "  type".padEnd(22) +
      " pending".padStart(8) +
      " failed".padStart(8) +
      " oldest_pending".padStart(16) +
      " oldest_failed".padStart(16),
  );
  for (const b of body.queue) {
    console.log(
      `  ${b.integration_type.padEnd(20)}` +
        ` ${String(b.pending).padStart(7)}` +
        ` ${String(b.failed).padStart(7)}` +
        ` ${fmtAge(b.oldest_pending_age_sec).padStart(15)}` +
        ` ${fmtAge(b.oldest_failed_age_sec).padStart(15)}`,
    );
  }
}

console.log("─".repeat(72));
if (body.ok) {
  console.log("✓ All integration types within threshold");
  process.exit(0);
}
console.log("✗ At least one type exceeded threshold. Operator should:");
console.log("  - check Vercel runtime logs for the relevant retry service");
console.log("  - confirm outbox-retry cron is actually firing");
console.log(
  "  - if oldest_pending is large, the cron may have stopped (gh run list)",
);
console.log(
  "  - if failed_count is large, a downstream API (SMTP / Notion / etc.) is bouncing",
);
process.exit(1);
