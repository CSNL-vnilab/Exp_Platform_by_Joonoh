#!/usr/bin/env node
//
// A/B harness: run smoke-from-source twice (baseline + REFINEMENT=on) on
// TimeExp1 and compute recall against scripts/fixtures/timeexp1_groundtruth.json.
//
// The standalone smoke-from-source.mjs only prints names / counts, not
// recall. This wrapper drives the same pipeline programmatically so the
// PR can attach a real "32% → ?%" lift number.
//
//   npx tsx scripts/smoke-timeexp1-ab.mjs
//
// Skips the source-fetch step on a re-run by caching to tmp/.

import path from "node:path";
import { readFile } from "node:fs/promises";

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

const gt = JSON.parse(
  await readFile(`${PROJECT_ROOT}/scripts/fixtures/timeexp1_groundtruth.json`, "utf8"),
);

console.log(`source: ${SOURCE}`);
console.log(`entry:  ${ENTRY}`);

const fetched = await fetchSource({ source: SOURCE });
console.log(
  `fetched: ${fetched.files.length} files (${fetched.truncated ? "truncated" : "full"})`,
);

const docs =
  fetched.files.find((f) => /^(readme|summary|protocol|spec)(\.[a-z]+)?$/i.test(f.path))
    ?.content ?? null;
if (docs) console.log(`docs:    ${docs.length} chars (auto-pickup)`);

const b = bundle(fetched.files, { entryHint: ENTRY });
console.log(`bundle:  entry=${b.entry}, ${b.selected.length} files, ${b.totalChars} chars`);

const heuristic = runHeuristic({ code: b.bundled, filename: b.entry });
console.log(
  `heuristic: factors=${heuristic.factors.length} parameters=${heuristic.parameters.length} saved=${heuristic.saved_variables.length}`,
);

// Fuzzy hit: groundtruth name matches a candidate (case-insensitive)
// when (a) exact, (b) one is suffix of the other (delimited by . or _),
// or (c) >=4-char substring. Mirrors bench-fixtures.mjs scoring.
function hit(name, list) {
  const want = name.toLowerCase();
  return (list ?? []).some((x) => {
    const got = (x.name ?? x.label ?? "").toLowerCase();
    if (got === want) return true;
    const wantTokens = want.split(/[._\s]+/);
    const gotTokens = got.split(/[._\s]+/);
    if (gotTokens.includes(want) || wantTokens.includes(got)) return true;
    if (want.length >= 4 && got.length >= 4 && (got.includes(want) || want.includes(got))) {
      return true;
    }
    return false;
  });
}

function score(merged) {
  const expectFactors = gt.meta.expected_factor_names;
  const expectParams = gt.meta.expected_parameter_names ?? [];
  // Saved variables are organized into 5-7 thematic groups in the
  // groundtruth (per-trial stimulus / response / timing / kinematics
  // / per-block / per-session / persisted). Flatten + dedupe for
  // recall scoring.
  const groups = gt.meta.expected_saved_groups ?? {};
  const expectSaved = [
    ...new Set(
      Object.values(groups)
        .flat()
        .filter((v) => typeof v === "string"),
    ),
  ];

  const factorHits = expectFactors.filter((n) => hit(n, merged.factors));
  const paramHits = expectParams.filter((n) => hit(n, merged.parameters));
  const savedHits = expectSaved.filter((n) => hit(n, merged.saved_variables));

  return {
    factor_recall: { hit: factorHits.length, total: expectFactors.length, names: factorHits },
    factor_misses: expectFactors.filter((n) => !factorHits.includes(n)),
    param_recall: { hit: paramHits.length, total: expectParams.length },
    saved_recall: { hit: savedHits.length, total: expectSaved.length },
    n_factors_total: merged.factors.length,
    n_params_total: merged.parameters.length,
    n_saved_total: merged.saved_variables.length,
    n_blocks: merged.meta.n_blocks,
    n_trials: merged.meta.n_trials_per_block,
    n_block_phases: (merged.meta.block_phases ?? []).length,
    domain_genre: merged.meta.domain_genre,
  };
}

async function runOne(mode) {
  console.log(`\n========== ${mode} ==========`);
  const t0 = Date.now();
  const r = await runAiAnalysis({
    code: b.bundled,
    filename: b.entry,
    heuristic,
    docs,
    refinement: mode === "REFINEMENT=on",
  });
  const ms = Date.now() - t0;
  const merged = mergeAnalysis(heuristic, r.analysis, null);
  const s = score(merged);
  console.log(
    `  factors:        ${s.factor_recall.hit}/${s.factor_recall.total} expected (${((s.factor_recall.hit / s.factor_recall.total) * 100).toFixed(1)}%)  · total emitted: ${s.n_factors_total}`,
  );
  console.log(`  factor hits:    ${s.factor_recall.names.join(", ")}`);
  console.log(`  factor misses:  ${s.factor_misses.join(", ")}`);
  console.log(
    `  parameters:     ${s.param_recall.hit}/${s.param_recall.total} (${((s.param_recall.hit / Math.max(s.param_recall.total, 1)) * 100).toFixed(1)}%)  · total emitted: ${s.n_params_total}`,
  );
  console.log(
    `  saved:          ${s.saved_recall.hit}/${s.saved_recall.total} (${((s.saved_recall.hit / Math.max(s.saved_recall.total, 1)) * 100).toFixed(1)}%)  · total emitted: ${s.n_saved_total}`,
  );
  console.log(`  meta.n_blocks:  ${s.n_blocks}  · gt=${gt.meta.n_blocks}`);
  console.log(`  meta.n_trials:  ${s.n_trials}  · gt=${gt.meta.n_trials_per_block}`);
  console.log(`  block_phases:   ${s.n_block_phases}  · gt_min=${gt.meta.block_phases_count_min}`);
  console.log(`  domain_genre:   ${s.domain_genre}  · gt=${gt.meta.domain_genre}`);
  console.log(`  duration:       ${(ms / 1000).toFixed(1)}s`);
  if (r.refinement) {
    console.log(
      `  refinement:     ${r.refinement.appliedCount} applied · ${r.refinement.rejectedCount} rejected · ${(r.refinement.durationMs / 1000).toFixed(1)}s · ${r.refinement.model}`,
    );
  }
  return { mode, ...s, ms, model: r.model, refinement: r.refinement };
}

const results = [];
results.push(await runOne("baseline (1-pass)"));
// Force the REFINEMENT env even if shell didn't propagate it.
process.env.REFINEMENT = "on";
results.push(await runOne("REFINEMENT=on"));

console.log("\n========== A/B ==========");
const [a, b2] = results;
const dF = b2.factor_recall.hit - a.factor_recall.hit;
const dP = b2.param_recall.hit - a.param_recall.hit;
const dS = b2.saved_recall.hit - a.saved_recall.hit;
console.log(
  `  factors:    ${a.factor_recall.hit}/${a.factor_recall.total} → ${b2.factor_recall.hit}/${b2.factor_recall.total}  (Δ ${dF >= 0 ? "+" : ""}${dF})`,
);
console.log(
  `  parameters: ${a.param_recall.hit}/${a.param_recall.total} → ${b2.param_recall.hit}/${b2.param_recall.total}  (Δ ${dP >= 0 ? "+" : ""}${dP})`,
);
console.log(
  `  saved:      ${a.saved_recall.hit}/${a.saved_recall.total} → ${b2.saved_recall.hit}/${b2.saved_recall.total}  (Δ ${dS >= 0 ? "+" : ""}${dS})`,
);
console.log(
  `  duration:   ${(a.ms / 1000).toFixed(1)}s → ${(b2.ms / 1000).toFixed(1)}s  (Δ +${((b2.ms - a.ms) / 1000).toFixed(1)}s)`,
);

if (fetched.cleanup) await fetched.cleanup();
