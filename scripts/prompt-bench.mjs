#!/usr/bin/env node
// Prompt orchestration bench: scores N prompt presets × M JSON
// structures × K models against a fixed ground truth, on the
// Magnitude/Experiment bundle from Joonoh.
//
// Usage:
//   npx tsx scripts/prompt-bench.mjs                # default Magnitude bench
//   PROMPTS=baseline,branch-aware MODELS=qwen3.6:latest npx tsx scripts/prompt-bench.mjs
//
// Env knobs:
//   MAGNITUDE_DIR       directory containing main_duration.m + sub/ + summary.MD
//   PROMPTS             comma-separated preset names (default: all)
//   MODELS              comma-separated ollama model tags (default: qwen3.6:latest,gemma4:31b)
//   USE_DOCS            "0" to skip docs-injection arm (default: include both)
//   N_RUNS              repetitions per cell (default: 1; use 3 to measure variance)
//   OUT_JSON            path for full results JSON (default: tmp/prompt-bench.json)

import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");

// --- imports from the actual source -----------------------------------
const { bundle } = await import(`${PROJECT_ROOT}/src/lib/experiments/code-bundler.ts`);
const { runHeuristic } = await import(`${PROJECT_ROOT}/src/lib/experiments/code-heuristics.ts`);
const { runAiAnalysis, SYSTEM_PROMPT_PRESETS } = await import(
  `${PROJECT_ROOT}/src/lib/experiments/code-ai-analyzer.ts`
);
const { mergeAnalysis } = await import(
  `${PROJECT_ROOT}/src/lib/experiments/code-analysis-schema.ts`
);

// --- ground truth (extracted from summary.MD) ------------------------------
// Human-curated. Each item has a "key" we score against the model output.
const GROUND_TRUTH = {
  meta: {
    language: "matlab",
    framework: "psychtoolbox",
    n_blocks_main: 12,        // Day2~5; Day1=10. The bench accepts either.
    n_blocks_alt: 10,
    n_trials_per_block: 30,   // par.nT = [0 30 30] for main
    seed_eq_zero: 0,          // condition=2 → seed=0
  },
  factors: [
    // canonical IVs
    { name: "dist", levels_subset: ["U", "A", "B"] },
    { name: "day", levels_subset: ["1", "2", "3", "4", "5"] },
  ],
  parameters_required: [
    "lentrial",
    "tprecue",
    "testimate",
    "tfeedback",
    "trest",
    "tdelay",
    "tmask",
    "tstim",
  ],
  parameter_values: {
    // "name": { value, tolerance(optional, for floats) }
    lentrial: { value: 7.7 },
    tprecue: { value: 0.3 },
    testimate: { value: 2.5 },
    tfeedback: { value: 1.0 },   // header changelog says 0.7 — but the active value is 1.0
    trest: { value: 5 },
    tdelay: { value: 0.5 },
    tmask: { value: 0.5 },
    tstim: { value: 3 },
  },
  saved_required: [
    // per-trial
    "Stm", "Stm_pr", "thetaLabel", "feedback",
    "Est", "Error", "RT", "ResponseAngle",
    // timing channels (par.tp.*)
    "vbl_start", "vbl_cue", "vbl_occlu", "vbl_occlu_end",
    "vbl_cue2", "vbl_respOnset", "vbl_resp", "tend", "occlu_dur_observed",
    // per-block / per-session
    "biasRepro", "blockState", "finalState",
  ],
};

const TOL = 1e-3;
function approxEq(a, b, tol = TOL) {
  if (a == null || b == null) return false;
  return Math.abs(Number(a) - Number(b)) <= tol;
}

function scoreAnalysis(a) {
  const detail = {};
  let total = 0;
  let possible = 0;

  // -- meta
  const m = a.meta ?? {};
  const metaCheck = [
    ["language", m.language === GROUND_TRUTH.meta.language, 1],
    ["framework", m.framework === GROUND_TRUTH.meta.framework, 1],
    [
      "n_blocks_correct",
      m.n_blocks === GROUND_TRUTH.meta.n_blocks_main ||
        m.n_blocks === GROUND_TRUTH.meta.n_blocks_alt,
      2,
    ],
    [
      "n_trials_correct",
      m.n_trials_per_block === GROUND_TRUTH.meta.n_trials_per_block,
      2,
    ],
  ];
  detail.meta = {};
  for (const [k, ok, w] of metaCheck) {
    detail.meta[k] = ok;
    if (ok) total += w;
    possible += w;
  }

  // -- factors (just check presence of key names)
  detail.factors = {};
  const factorNames = new Set((a.factors ?? []).map((f) => (f.name ?? "").toLowerCase()));
  for (const want of GROUND_TRUTH.factors) {
    const hit = factorNames.has(want.name.toLowerCase());
    detail.factors[want.name] = hit;
    if (hit) total += 3; // weight high — this is the hard part
    possible += 3;
  }
  // penalize bogus factors (e.g. "scaling" / "seed" as factor) — neutral, just flag
  const bogus = (a.factors ?? [])
    .map((f) => (f.name ?? "").toLowerCase())
    .filter((n) => !["dist", "day", "subjnum", "subject", "participant"].includes(n));
  detail.factors_bogus = bogus;

  // -- parameters: existence + value
  detail.params = {};
  const params = new Map(
    (a.parameters ?? []).map((p) => [(p.name ?? "").toLowerCase(), p]),
  );
  for (const name of GROUND_TRUTH.parameters_required) {
    const got = params.get(name.toLowerCase());
    let ok = !!got;
    detail.params[`${name}_present`] = ok;
    if (ok) total += 1;
    possible += 1;
    const want = GROUND_TRUTH.parameter_values[name];
    if (want != null) {
      const valueOk = ok && approxEq(parseFloat(got.default), want.value);
      detail.params[`${name}_value`] = valueOk;
      if (valueOk) total += 1;
      possible += 1;
    }
  }

  // -- saved variables: existence
  detail.saved = {};
  const savedNames = new Set(
    (a.saved_variables ?? []).map((s) => (s.name ?? "").toLowerCase()),
  );
  for (const name of GROUND_TRUTH.saved_required) {
    // accept partial matches (par.results.X, tp.X, etc.) — strip prefix
    const key = name.toLowerCase();
    const hit =
      savedNames.has(key) ||
      [...savedNames].some(
        (s) => s.endsWith(`.${key}`) || s.endsWith(`/${key}`) || s.split(/[.\s]/).pop() === key,
      );
    detail.saved[name] = hit;
    if (hit) total += 1;
    possible += 1;
  }

  return { score: total, possible, pct: total / possible, detail };
}

// --- collect files ------------------------------------------------------
async function collectMagnitude() {
  const root = process.env.MAGNITUDE_DIR ?? "/Volumes/CSNL_new-1/people/JOP/Magnitude/Experiment";
  const files = [];
  // root files
  for (const e of await readdir(root, { withFileTypes: true })) {
    if (e.isFile() && /\.(m|md)$/i.test(e.name)) {
      const p = path.join(root, e.name);
      const c = await readFile(p, "utf8");
      files.push({ path: e.name, content: c });
    }
  }
  // sub/ files (filter out .asv)
  const subDir = path.join(root, "sub");
  for (const e of await readdir(subDir, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith(".m") && !e.name.endsWith(".asv")) {
      const c = await readFile(path.join(subDir, e.name), "utf8");
      files.push({ path: `sub/${e.name}`, content: c });
    }
  }
  return files;
}

async function loadDocs() {
  const root = process.env.MAGNITUDE_DIR ?? "/Volumes/CSNL_new-1/people/JOP/Magnitude/Experiment";
  try {
    return await readFile(path.join(root, "summary.MD"), "utf8");
  } catch {
    return null;
  }
}

// --- run ---------------------------------------------------------------
const promptNames = (process.env.PROMPTS ?? Object.keys(SYSTEM_PROMPT_PRESETS).join(",")).split(",");
const models = (process.env.MODELS ?? "qwen3.6:latest,gemma4:31b").split(",");
const useDocsArms = process.env.USE_DOCS === "0" ? [false] : [false, true];
const nRuns = parseInt(process.env.N_RUNS ?? "1", 10);
const outJson = process.env.OUT_JSON ?? path.join(PROJECT_ROOT, "tmp", "prompt-bench.json");

const allFiles = await collectMagnitude();
const docs = await loadDocs();

console.log(`bench: ${allFiles.length} files; entry detection in progress...`);
const b = bundle(allFiles, { entryHint: "main_duration.m" });
console.log(`bundled ${b.selected.length} files (${b.totalChars} chars), entry=${b.entry}`);
console.log(`top-10 selected:`);
for (const s of b.selected.slice(0, 10)) {
  console.log(`  ${s.role.padEnd(11)} ${s.path}`);
}

const heuristic = runHeuristic({ code: b.bundled, filename: b.entry });

const cells = [];
for (const prompt of promptNames) {
  for (const model of models) {
    for (const useDocs of useDocsArms) {
      cells.push({ prompt, model, useDocs });
    }
  }
}

const results = [];
for (const cell of cells) {
  for (let run = 0; run < nRuns; run += 1) {
    const tag = `[${cell.prompt} | ${cell.model} | docs=${cell.useDocs ? "Y" : "N"}${nRuns > 1 ? ` | run${run + 1}` : ""}]`;
    process.stdout.write(`${tag} … `);
    const t0 = Date.now();
    let analysis = null;
    let err = null;
    try {
      const sysFn = SYSTEM_PROMPT_PRESETS[cell.prompt];
      if (!sysFn) throw new Error(`unknown prompt preset ${cell.prompt}`);
      const r = await runAiAnalysis({
        code: b.bundled,
        filename: b.entry,
        heuristic,
        docs: cell.useDocs ? docs : null,
        model: cell.model,
        systemPromptOverride: sysFn({ hasDocs: cell.useDocs }),
      });
      analysis = r.analysis;
    } catch (e) {
      err = e.message ?? String(e);
    }
    const ms = Date.now() - t0;
    const merged = analysis ? mergeAnalysis(heuristic, analysis, null) : heuristic;
    const sc = scoreAnalysis(merged);
    console.log(
      `${err ? "FAIL" : `${(sc.pct * 100).toFixed(1).padStart(5)}%`} ` +
        `(${sc.score}/${sc.possible}) in ${(ms / 1000).toFixed(1)}s${err ? "  " + err.slice(0, 80) : ""}`,
    );
    results.push({
      prompt: cell.prompt,
      model: cell.model,
      docs: cell.useDocs,
      run,
      ms,
      err,
      score: sc.score,
      possible: sc.possible,
      pct: sc.pct,
      detail: sc.detail,
      analysis,
      merged,
    });
  }
}

await mkdir(path.dirname(outJson), { recursive: true });
await writeFile(outJson, JSON.stringify(results, null, 2));

// leaderboard
const grouped = new Map();
for (const r of results) {
  const k = `${r.prompt}|${r.model}|docs=${r.docs ? "Y" : "N"}`;
  if (!grouped.has(k)) grouped.set(k, []);
  grouped.get(k).push(r);
}
const leaderboard = [...grouped.entries()].map(([k, rs]) => {
  const ok = rs.filter((r) => !r.err);
  const avg = ok.length ? ok.reduce((a, r) => a + r.pct, 0) / ok.length : 0;
  const ms = ok.length ? ok.reduce((a, r) => a + r.ms, 0) / ok.length : 0;
  const fails = rs.length - ok.length;
  return { key: k, avg, ms, runs: rs.length, fails };
});
leaderboard.sort((a, b) => b.avg - a.avg);

console.log("\n--- leaderboard ---");
console.log("rank  pct%   avg-s   fails  runs  preset|model|docs");
for (const [i, e] of leaderboard.entries()) {
  console.log(
    `${(i + 1).toString().padStart(2)}.  ${(e.avg * 100).toFixed(1).padStart(5)}%  ${(e.ms / 1000).toFixed(1).padStart(5)}s  ${String(e.fails).padStart(3)}    ${String(e.runs).padStart(3)}   ${e.key}`,
  );
}

// detail breakdown for the winner
const winner = leaderboard[0];
const winnerRun = results.find(
  (r) => `${r.prompt}|${r.model}|docs=${r.docs ? "Y" : "N"}` === winner.key && !r.err,
);
if (winnerRun) {
  console.log("\n--- winner detail ---");
  console.log("preset:", winnerRun.prompt, "| model:", winnerRun.model, "| docs:", winnerRun.docs);
  console.log(JSON.stringify(winnerRun.detail, null, 2));
  console.log("\nfactors found:", (winnerRun.merged.factors ?? []).map((f) => f.name).join(", "));
  console.log("conditions:", (winnerRun.merged.conditions ?? []).length);
  console.log("saved_variables:", (winnerRun.merged.saved_variables ?? []).length);
}

console.log(`\nfull results: ${outJson}`);
