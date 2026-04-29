#!/usr/bin/env node
// Smoke test: drive the from-source pipeline directly (no Next route),
// exercising fetchSource → bundle → runHeuristic → runAiAnalysis on
// the Magnitude (TimeExp1) experiment.
//
//   npx tsx scripts/smoke-from-source.mjs
//
// Env knobs:
//   SOURCE  override the source path/URL
//   ENTRY   override entry hint
//   DOCS    "0" to disable docs auto-pickup
//   MODE    heuristic|ai|both (default both)

import path from "node:path";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const { fetchSource } = await import(`${PROJECT_ROOT}/src/lib/experiments/source-fetcher.ts`);
const { bundle } = await import(`${PROJECT_ROOT}/src/lib/experiments/code-bundler.ts`);
const { runHeuristic } = await import(`${PROJECT_ROOT}/src/lib/experiments/code-heuristics.ts`);
const { runAiAnalysis } = await import(
  `${PROJECT_ROOT}/src/lib/experiments/code-ai-analyzer.ts`
);
const { mergeAnalysis } = await import(
  `${PROJECT_ROOT}/src/lib/experiments/code-analysis-schema.ts`
);

const SOURCE =
  process.env.SOURCE ??
  "/Volumes/CSNL_new-1/people/JOP/Magnitude/Experiment";
const ENTRY = process.env.ENTRY ?? "main_duration.m";
const MODE = process.env.MODE ?? "both";

console.log(`fetching source: ${SOURCE}`);
const fetched = await fetchSource({ source: SOURCE });
console.log(
  `  → ${fetched.files.length} files (${fetched.truncated ? "truncated" : "full"}); ${fetched.skipped.length} skipped`,
);

// auto-pickup docs
let docs = null;
if (process.env.DOCS !== "0") {
  const conv = fetched.files.find((f) =>
    /^(readme|summary|protocol|spec)(\.[a-z]+)?$/i.test(f.path),
  );
  if (conv) {
    docs = conv.content;
    console.log(`  → docs auto: ${conv.path} (${conv.content.length} chars)`);
  }
}

const b = bundle(fetched.files, { entryHint: ENTRY });
console.log(`bundle: entry=${b.entry}; ${b.selected.length} files; ${b.totalChars} chars`);
for (const s of b.selected.slice(0, 8)) {
  console.log(`  ${s.role.padEnd(10)} ${s.path}`);
}

const heuristic = runHeuristic({ code: b.bundled, filename: b.entry });
console.log(`heuristic: factors=${heuristic.factors.length} parameters=${heuristic.parameters.length} saved=${heuristic.saved_variables.length}`);

if (MODE !== "heuristic") {
  const t0 = Date.now();
  const r = await runAiAnalysis({
    code: b.bundled,
    filename: b.entry,
    heuristic,
    docs,
  });
  console.log(`AI (${r.model}): ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const merged = mergeAnalysis(heuristic, r.analysis, null);
  console.log(`merged: factors=${(merged.factors ?? []).map((f) => f.name).join(", ")}`);
  console.log(`        n_blocks=${merged.meta.n_blocks} n_trials=${merged.meta.n_trials_per_block}`);
  console.log(`        params=${merged.parameters.length} saved=${merged.saved_variables.length}`);
  console.log(`        warnings:`);
  for (const w of merged.warnings.slice(0, 5)) console.log(`          - ${w}`);
}

if (fetched.cleanup) await fetched.cleanup();
