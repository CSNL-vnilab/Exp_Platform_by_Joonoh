#!/usr/bin/env node
/**
 * stress-matrix.mjs — TimeExpOnline1 platform robustness suite.
 *
 * Spawns N parallel ideal-observer e2e runs across varied scenarios and
 * collects pass/fail per scenario. Each scenario validates the same
 * baseline assertions (30/30 confirmed, |bias| ≤ 10 ms, |Error|_max ≤
 * 60 ms) but exercises different paths through the platform:
 *
 *   subject_number ∈ {1,2,3,4}   → patList[subj%4]   → dist {U,A,B}
 *   session_number ∈ {1..5}      → patList[..][day-2] for day≥2
 *   blocks ∈ {1, 3}              → cross-block continuity
 *
 * Concurrency keeps wall-clock ~= slowest scenario rather than sum of all.
 *
 * Usage: NEXT_PUBLIC_APP_URL=https://… node scripts/timeexp/stress-matrix.mjs
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, "e2e-ideal-observer.mjs");

const TIER = process.env.MATRIX_TIER ?? "baseline"; // baseline | multiblock | full

const TIERS = {
  // 8 scenarios × 1 block each — cross-section of subj × day matrix
  baseline: [
    { label: "subj1-day1-baseline", subject: 1, session: 1, blocks: 1 },
    { label: "subj2-day1-distA",    subject: 2, session: 1, blocks: 1 },
    { label: "subj3-day1-distB",    subject: 3, session: 1, blocks: 1 },
    { label: "subj4-day1-distU",    subject: 4, session: 1, blocks: 1 },
    { label: "subj1-day2",          subject: 1, session: 2, blocks: 1 },
    { label: "subj1-day3",          subject: 1, session: 3, blocks: 1 },
    { label: "subj1-day5-final",    subject: 1, session: 5, blocks: 1 },
    { label: "subj2-day3-cross",    subject: 2, session: 3, blocks: 1 },
  ],
  // 4 scenarios × 3 blocks each — cross-block continuity (tend chaining,
  // vbl drift, summary chart)
  multiblock: [
    { label: "subj1-day1-3blk",  subject: 1, session: 1, blocks: 3 },
    { label: "subj1-day4-3blk",  subject: 1, session: 4, blocks: 3 },
    { label: "subj5-day1-3blk",  subject: 5, session: 1, blocks: 3 },
    { label: "subj7-day2-3blk",  subject: 7, session: 2, blocks: 3 },
  ],
  // Both tiers
  full: [],
};
TIERS.full = [...TIERS.baseline, ...TIERS.multiblock];

const SCENARIOS = TIERS[TIER] ?? TIERS.baseline;

const APP = process.env.NEXT_PUBLIC_APP_URL ?? "https://lab-reservation-seven.vercel.app";

function runScenario(scn) {
  return new Promise((resolve) => {
    const args = [
      RUNNER,
      "--blocks", String(scn.blocks),
      "--subject", String(scn.subject),
      "--session", String(scn.session),
      "--label", scn.label,
      "--cleanup",
    ];
    const t0 = Date.now();
    const child = spawn("node", args, {
      env: { ...process.env, NEXT_PUBLIC_APP_URL: APP },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines = [];
    child.stdout.on("data", (d) => lines.push(d.toString()));
    child.stderr.on("data", (d) => lines.push(d.toString()));
    child.on("close", (code) => {
      const out = lines.join("");
      const stats = parseOutput(out);
      resolve({
        scenario: scn,
        passed: code === 0,
        durationS: ((Date.now() - t0) / 1000).toFixed(1),
        stats,
        tail: out.split("\n").slice(-12).join("\n"),
      });
    });
  });
}

function parseOutput(text) {
  const stats = { perBlock: [] };
  const re = /block (\d+): valid=(\d+) missed=(\d+) bias=([\-0-9.]+)s absErrMean=([\-0-9.]+)s absErrMax=([\-0-9.]+)s/g;
  let m;
  while ((m = re.exec(text)) != null) {
    stats.perBlock.push({
      block: Number(m[1]),
      valid: Number(m[2]),
      missed: Number(m[3]),
      biasMs: Number(m[4]) * 1000,
      errMeanMs: Number(m[5]) * 1000,
      errMaxMs: Number(m[6]) * 1000,
    });
  }
  if (stats.perBlock.length > 0) {
    stats.valid = stats.perBlock.reduce((s, b) => s + b.valid, 0);
    stats.missed = stats.perBlock.reduce((s, b) => s + b.missed, 0);
    stats.maxAbsBiasMs = Math.max(...stats.perBlock.map((b) => Math.abs(b.biasMs)));
    stats.maxErrMaxMs = Math.max(...stats.perBlock.map((b) => b.errMaxMs));
    stats.meanBiasMs = stats.perBlock.reduce((s, b) => s + b.biasMs, 0) / stats.perBlock.length;
  }
  const m2 = text.match(/dist=([UAB])/);
  if (m2) stats.dist = m2[1];
  const m3 = text.match(/seeded experiment ([0-9a-f-]+)/);
  if (m3) stats.expId = m3[1];
  return stats;
}

function fmtRow(r) {
  const s = r.stats;
  const status = r.passed ? "PASS" : "FAIL";
  const bias = Number.isFinite(s.maxAbsBiasMs) ? s.maxAbsBiasMs.toFixed(2) : "—";
  const errMax = Number.isFinite(s.maxErrMaxMs) ? s.maxErrMaxMs.toFixed(2) : "—";
  const dist = s.dist || "?";
  const trialsStr = s.valid != null ? `${s.valid}/${s.valid + (s.missed ?? 0)}` : "—";
  const blocksLogged = s.perBlock?.length ?? 0;
  return `  ${status.padEnd(4)}  ${r.scenario.label.padEnd(28)}  subj=${String(r.scenario.subject).padStart(2)}  day=${r.scenario.session}  bk=${blocksLogged}/${r.scenario.blocks}  dist=${dist}  ${trialsStr.padEnd(7)}  |bias|max=${bias.padStart(6)}ms  |Err|max=${errMax.padStart(6)}ms  ${r.durationS}s`;
}

console.log(`stress-matrix: ${SCENARIOS.length} scenarios, target=${APP}`);
console.log("─".repeat(60));
const t0 = Date.now();

const results = await Promise.all(SCENARIOS.map(runScenario));

console.log("\nresults:");
for (const r of results) console.log(fmtRow(r));

const passed = results.filter((r) => r.passed).length;
const failed = results.length - passed;
console.log(`\n${passed}/${results.length} passed in ${((Date.now() - t0) / 1000).toFixed(1)}s wall-clock`);

if (failed > 0) {
  console.log("\nFailed-scenario tails:");
  for (const r of results.filter((r) => !r.passed)) {
    console.log(`\n[${r.scenario.label}]\n${r.tail}`);
  }
  process.exit(1);
}

// Summary by dist + by day for a sanity-look at coverage
console.log("\ncoverage:");
const byDist = {};
const byDay = {};
for (const r of results) {
  const d = r.stats.dist || "?";
  byDist[d] = (byDist[d] || 0) + 1;
  byDay[r.scenario.session] = (byDay[r.scenario.session] || 0) + 1;
}
console.log("  dist:", JSON.stringify(byDist));
console.log("  day:", JSON.stringify(byDay));
