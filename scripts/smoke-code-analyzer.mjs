#!/usr/bin/env node
// Smoke-test the heuristic + AI parsers without going through Next.
// Usage: node scripts/smoke-code-analyzer.mjs [path-to-code]
//
// If path is omitted, uses an inline PsychoPy-shaped sample.

// Run with: npx tsx scripts/smoke-code-analyzer.mjs

import { readFile } from "node:fs/promises";
import path from "node:path";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");

const { runHeuristic } = await import(
  `${PROJECT_ROOT}/src/lib/experiments/code-heuristics.ts`
);
const { runAiAnalysis } = await import(
  `${PROJECT_ROOT}/src/lib/experiments/code-ai-analyzer.ts`
);
const { mergeAnalysis } = await import(
  `${PROJECT_ROOT}/src/lib/experiments/code-analysis-schema.ts`
);

const arg = process.argv[2];
let code;
let filename;
if (arg) {
  code = await readFile(arg, "utf8");
  filename = path.basename(arg);
} else {
  filename = "demo_psychopy.py";
  code = `# Demo PsychoPy-shaped script
from psychopy import visual, core, event, data

expInfo = {'participant': '', 'session': '001', 'condition': 'A'}

n_blocks = 4
n_trials = 30           # per block
contrast_levels = [0.05, 0.1, 0.2, 0.4, 0.8]
seed = 'sub01_v1'

trials = data.TrialHandler(
    trialList=data.importConditions('cond.csv'),
    nReps=n_trials,
    method='random',
)

for trial in trials:
    trials.addData('rt', 0.42)
    trials.addData('accuracy', 1)
`;
}

console.log(`heuristic on ${filename} (${code.length} chars)`);
const heuristic = runHeuristic({ code, filename });
console.log(JSON.stringify(heuristic, null, 2));

if (process.env.SKIP_AI === "1") process.exit(0);

console.log("\n--- AI pass ---");
try {
  const r = await runAiAnalysis({ code, filename, heuristic });
  console.log("model:", r.model);
  console.log(JSON.stringify(r.analysis, null, 2));
  console.log("\n--- merged ---");
  console.log(JSON.stringify(mergeAnalysis(heuristic, r.analysis, null), null, 2));
} catch (err) {
  console.error("AI pass failed:", err.message);
}
