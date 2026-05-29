#!/usr/bin/env node
// One-shot operator smoke — runs every script under scripts/ that's
// safe to fire against prod read-only, collects exit codes, and prints
// a summary table.
//
// Use after a deploy or as an ad-hoc "is the system OK" probe:
//
//     node scripts/smoke-all.mjs
//
// Each child smoke streams its own output (prefixed with the smoke
// name) so a failure shows context inline. The final summary line
// reports which smokes failed and the overall exit code.
//
// Exit codes:
//   0 — every child smoke exited 0
//   1 — at least one child exited non-zero (regression / drift /
//       missing env / unreachable endpoint)

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Each entry: [smoke-file, human-name, what-it-probes].
// All four are safe to run against production — they're either
// auth-gated GET / POST against /api/health|cron/* or pure local
// regex unit checks. None mutate DB state.
const SMOKES = [
  [
    "smoke-cron-auth.mjs",
    "cron-auth",
    "every /api/cron/* + /api/health/* returns 401 without secret",
  ],
  [
    "smoke-secret-audit.mjs",
    "secret-audit",
    "token-secret modules don't fall through to SUPABASE_SERVICE_ROLE_KEY",
  ],
  [
    "smoke-queue-depth.mjs",
    "queue-depth",
    "booking_integrations outbox isn't backlogged",
  ],
  [
    "check-pii-scrub.mjs",
    "pii-scrub",
    "PII redaction regexes still match the 18 golden fixtures",
  ],
];

function runOne(file) {
  return new Promise((resolve) => {
    const path = join(__dirname, file);
    const child = spawn("node", [path], { stdio: "inherit" });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

const results = [];
for (const [file, name, what] of SMOKES) {
  console.log("═".repeat(72));
  console.log(`▶ ${name} — ${what}`);
  console.log("═".repeat(72));
  const code = await runOne(file);
  results.push({ name, code, what });
}

console.log("═".repeat(72));
console.log("Summary");
console.log("─".repeat(72));
let fails = 0;
for (const r of results) {
  const mark = r.code === 0 ? "✓" : "✗";
  if (r.code !== 0) fails += 1;
  console.log(`  ${mark} ${r.name.padEnd(18)} exit=${r.code}`);
}
console.log("─".repeat(72));
if (fails === 0) {
  console.log("✓ all smokes passed");
  process.exit(0);
}
console.log(`✗ ${fails} smoke${fails === 1 ? "" : "s"} failed`);
process.exit(1);
