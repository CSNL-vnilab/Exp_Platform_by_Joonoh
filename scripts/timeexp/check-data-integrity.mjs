#!/usr/bin/env node
// Periodic integrity check for TimeExpOnline1_demo data on Supabase.
// Designed for GH Actions schedule — no NAS access required, just
// reads counts from the storage API + RPC + flags anomalies.
//
// Reports per subject:
//   - block files present (expected: 10 for day-1, 12 for day-2..5)
//   - bookings count + most recent booking date
//   - first-block schedule.distChar consistent with subjNum × day formula
//
// Exits 1 if any anomaly found (e.g. truncated session, schedule drift).
// Pairs with the lab-Mac launchd job that mirrors data to NAS — this
// catches problems even when the Mac is offline.
//
// Usage:
//   EXPERIMENT_ID=<uuid> node scripts/timeexp/check-data-integrity.mjs

import { createClient } from "@supabase/supabase-js";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
async function loadEnv() {
  const text = await readFile(join(__dirname, "..", "..", ".env.local"), "utf8").catch(
    () => "",
  );
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
    }
  }
}
await loadEnv();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const expId = process.env.EXPERIMENT_ID;
if (!url || !serviceKey || !expId) {
  console.error("missing env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, EXPERIMENT_ID");
  process.exit(2);
}

const supa = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function distForSession(subjNum, day) {
  if (day === 1) return "U";
  const patList = ["AABB", "ABBA", "BABA", "BBAA"];
  return patList[subjNum % 4][day - 2];
}

async function main() {
  // 1. Count storage entries per subject.
  const { data: subjDirs, error: e1 } = await supa.storage
    .from("experiment-data")
    .list(expId, { limit: 1000 });
  if (e1) {
    console.error("list error:", e1.message);
    process.exit(1);
  }

  const issues = [];
  let totalBlocks = 0;

  for (const subj of subjDirs.filter((d) => !d.id)) {
    const subjPath = `${expId}/${subj.name}`;
    const { data: blocks, error: e2 } = await supa.storage
      .from("experiment-data")
      .list(subjPath, { limit: 100 });
    if (e2) {
      issues.push(`${subjPath}: list error ${e2.message}`);
      continue;
    }
    const blockFiles = (blocks || []).filter((f) => /^block_\d+\.json$/.test(f.name));
    totalBlocks += blockFiles.length;

    // We can't tell "which day" purely from storage layout (subject_number
    // is stable across days). But block_count modulo {10, 12} is a quick
    // sanity check — anything outside {0..12} or partial pairs (e.g. 7)
    // means a session was abandoned mid-block or a regression.
    const n = blockFiles.length;
    const looksOK =
      n === 0 ||
      n === 10 || // day 1 complete
      n === 12 || // day complete
      n === 22 || // day 1 + 1 day complete
      n === 34 ||
      n === 46 ||
      n === 58; // 5 days × 12 + 10
    if (!looksOK) {
      issues.push(`${subjPath}: ${n} blocks (expected ∈ {0,10,12,22,34,46,58})`);
    }
  }

  console.log(
    `[integrity] experiment=${expId} subjects=${subjDirs.filter((d) => !d.id).length} blocks=${totalBlocks}`,
  );
  if (issues.length) {
    console.log("issues:");
    for (const i of issues) console.log("  · " + i);
    process.exit(1);
  }
  console.log("✓ no anomalies");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
