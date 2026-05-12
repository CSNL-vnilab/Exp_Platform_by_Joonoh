#!/usr/bin/env node
//
// Dump TimeExp1's 1-pass analyzer output (qwen3.6) + the bundled
// code + groundtruth to JSON files under tmp/timeexp1/, so an
// in-session Opus reviewer can read them and emit <patch> blocks
// for a manual refinement round (no auto-pass-2 / no API key needed).
//
//   npx tsx scripts/dump-timeexp1-pass1.mjs

import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

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

const SOURCE = process.env.SOURCE ?? "/Volumes/CSNL_new-1/people/JOP/Magnitude/Experiment";
const ENTRY = process.env.ENTRY ?? "main_duration.m";

await mkdir(`${PROJECT_ROOT}/tmp/timeexp1`, { recursive: true });

console.log(`fetching ${SOURCE}…`);
const fetched = await fetchSource({ source: SOURCE });
console.log(`  ${fetched.files.length} files`);

const docs =
  fetched.files.find((f) => /^(readme|summary|protocol|spec)(\.[a-z]+)?$/i.test(f.path))
    ?.content ?? null;

const b = bundle(fetched.files, { entryHint: ENTRY });
console.log(`bundle: entry=${b.entry}, ${b.selected.length} files, ${b.totalChars} chars`);

const heuristic = runHeuristic({ code: b.bundled, filename: b.entry });
console.log(
  `heuristic: factors=${heuristic.factors.length} params=${heuristic.parameters.length} saved=${heuristic.saved_variables.length}`,
);

console.log("running pass-1 (qwen3.6)…");
const t0 = Date.now();
const r = await runAiAnalysis({
  code: b.bundled,
  filename: b.entry,
  heuristic,
  docs,
  refinement: false,
});
const ms = Date.now() - t0;
const merged = mergeAnalysis(heuristic, r.analysis, null);
console.log(
  `pass-1 done in ${(ms / 1000).toFixed(1)}s · model=${r.model} · factors=${merged.factors.length} params=${merged.parameters.length} saved=${merged.saved_variables.length}`,
);

await writeFile(
  `${PROJECT_ROOT}/tmp/timeexp1/pass1.json`,
  JSON.stringify({ heuristic, ai: r.analysis, merged }, null, 2),
);
await writeFile(`${PROJECT_ROOT}/tmp/timeexp1/bundle.txt`, b.bundled);
await writeFile(
  `${PROJECT_ROOT}/tmp/timeexp1/bundle-meta.json`,
  JSON.stringify(
    {
      entry: b.entry,
      totalChars: b.totalChars,
      selected: b.selected,
      dropped: b.dropped,
    },
    null,
    2,
  ),
);
if (docs) {
  await writeFile(`${PROJECT_ROOT}/tmp/timeexp1/docs.txt`, docs);
}

console.log(`\nwrote:
  tmp/timeexp1/pass1.json        — heuristic + ai + merged
  tmp/timeexp1/bundle.txt        — code bundle (${b.bundled.length} chars)
  tmp/timeexp1/bundle-meta.json  — selected/dropped files
  ${docs ? "tmp/timeexp1/docs.txt          — docs auto-pickup" : ""}`);

if (fetched.cleanup) await fetched.cleanup();
