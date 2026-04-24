#!/usr/bin/env node
// Post-deploy smoke: verify every cron endpoint is reachable and
// authenticates correctly. For each path we send one unauthenticated
// POST and expect 401 (not 404 — a 404 means the deploy dropped the
// route, not that auth rejected us).
//
// Runs read-only — never sends a valid secret, so no side effects.
//
// Usage:
//   NEXT_PUBLIC_APP_URL=https://lab-reservation-seven.vercel.app \
//     node scripts/smoke-cron-auth.mjs
//
// Exit code:
//   0 — all endpoints return 401
//   1 — at least one endpoint returned something other than 401
//       (404 = route missing, 500 = handler crash before auth check,
//        200 = auth bypass regression — treat all as hard failures)

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

// Keep this list in sync with the cron inventory in docs/ops-playbook.md.
// Adding a route here is cheap; missing one from prod is the whole point
// of this smoke.
const CRON_PATHS = [
  "/api/notifications/reminders",
  "/api/cron/auto-complete-bookings",
  // notion-retry retired 2026-04-24 — superseded by outbox-retry.
  // `git log --diff-filter=D -- src/app/api/cron/notion-retry/route.ts`
  // to recover if needed.
  "/api/cron/notion-health",
  "/api/cron/outbox-retry",
  "/api/cron/promotion-notifications",
  "/api/cron/metadata-reminders",
];

const base = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
if (!base) {
  console.error("NEXT_PUBLIC_APP_URL is required");
  process.exit(2);
}

console.log(`Cron-auth smoke against ${base}`);
console.log("────────────────────────────────────────────────────────────");

let fails = 0;
for (const path of CRON_PATHS) {
  const url = `${base}${path}`;
  let status = 0;
  let note = "";
  try {
    const res = await fetch(url, { method: "POST" });
    status = res.status;
  } catch (err) {
    note = ` (fetch error: ${err instanceof Error ? err.message : String(err)})`;
  }
  const ok = status === 401;
  if (!ok) fails += 1;
  console.log(`  ${ok ? "✓" : "✗"} ${status} ${path}${note}`);
}

console.log("────────────────────────────────────────────────────────────");
if (fails === 0) {
  console.log("✓ All cron endpoints gated by auth (HTTP 401)");
  process.exit(0);
}
console.log(`✗ ${fails} endpoint(s) did not return 401`);
process.exit(1);
