#!/usr/bin/env node
//
// Apply in-session-Opus-authored patches to pass-1 TimeExp1 analysis,
// validate each through the strict zod schema (PR #4's patch
// channel), apply via applyPatch, and re-score against the groundtruth
// to measure recall lift.
//
// Inputs:
//   tmp/timeexp1/pass1.json     — heuristic + ai + merged (from dump-timeexp1-pass1.mjs)
//   PATCHES env (default          array of patches written by the
//     scripts/fixtures/            in-session reviewer.
//     timeexp1_inseesion_patches.json)
//
//   npx tsx scripts/in-session-refine-apply.mjs
//   PATCHES=tmp/timeexp1/patches.json npx tsx scripts/in-session-refine-apply.mjs

import path from "node:path";
import { readFile } from "node:fs/promises";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");

const { validatePatch, applyPatch } = await import(
  `${PROJECT_ROOT}/src/lib/experiments/code-analysis-patch.ts`
);
const { CodeAnalysisSchema, mergeAnalysis } = await import(
  `${PROJECT_ROOT}/src/lib/experiments/code-analysis-schema.ts`
);

const pass1 = JSON.parse(
  await readFile(`${PROJECT_ROOT}/tmp/timeexp1/pass1.json`, "utf8"),
);
const patchesPath =
  process.env.PATCHES ?? `${PROJECT_ROOT}/scripts/fixtures/timeexp1_inseesion_patches.json`;
const patches = JSON.parse(await readFile(patchesPath, "utf8"));
console.log(`patches from: ${path.relative(PROJECT_ROOT, patchesPath)}`);
const gt = JSON.parse(
  await readFile(`${PROJECT_ROOT}/scripts/fixtures/timeexp1_groundtruth.json`, "utf8"),
);

console.log(`pass-1: factors=${pass1.merged.factors.length} params=${pass1.merged.parameters.length} saved=${pass1.merged.saved_variables.length}`);
console.log(`patches: ${patches.length} authored`);

// Fuzzy name match (mirrors bench-fixtures.mjs + smoke-timeexp1-ab.mjs)
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

function score(label, merged) {
  const expectFactors = gt.meta.expected_factor_names;
  const expectParams = gt.meta.expected_parameter_names ?? [];
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
  console.log(`\n[${label}]`);
  console.log(
    `  factors:        ${factorHits.length}/${expectFactors.length}  (${((factorHits.length / expectFactors.length) * 100).toFixed(1)}%)  · emitted ${merged.factors.length}`,
  );
  console.log(
    `  hits:           ${factorHits.join(", ")}`,
  );
  console.log(
    `  misses:         ${expectFactors.filter((n) => !factorHits.includes(n)).join(", ")}`,
  );
  console.log(
    `  parameters:     ${paramHits.length}/${expectParams.length}  (${((paramHits.length / expectParams.length) * 100).toFixed(1)}%)  · emitted ${merged.parameters.length}`,
  );
  console.log(
    `  saved:          ${savedHits.length}/${expectSaved.length}  (${((savedHits.length / expectSaved.length) * 100).toFixed(1)}%)  · emitted ${merged.saved_variables.length}`,
  );
  return {
    factors: { hit: factorHits.length, total: expectFactors.length },
    params: { hit: paramHits.length, total: expectParams.length },
    saved: { hit: savedHits.length, total: expectSaved.length },
  };
}

const before = score("BEFORE (pass-1)", pass1.merged);

// CodeAnalysis is structurally a valid CodeAnalysisOverrides — same
// path the analyzer's runRefinement uses.
let working = pass1.merged;
let applied = 0;
let rejected = 0;
const rejectedDetail = [];
for (let i = 0; i < patches.length; i += 1) {
  const v = validatePatch(patches[i]);
  if (!v.ok) {
    rejected += 1;
    rejectedDetail.push({ idx: i, error: v.error, raw: patches[i] });
    continue;
  }
  const r = applyPatch(working, v.patch);
  if (r.error) {
    rejected += 1;
    rejectedDetail.push({ idx: i, error: r.error, raw: patches[i] });
    continue;
  }
  working = r.next;
  applied += 1;
}

console.log(`\napplied ${applied} / rejected ${rejected}`);
if (rejected > 0) {
  for (const d of rejectedDetail) {
    console.log(`  rejected #${d.idx}: ${d.error}`);
    console.log(`    raw: ${JSON.stringify(d.raw).slice(0, 200)}`);
  }
}

const final = CodeAnalysisSchema.parse(working);
// re-merge heuristic + (ai+overrides) so the comparison is apples to
// apples with bench-fixtures.mjs (which feeds mergeAnalysis the AI
// output).
const merged = mergeAnalysis(pass1.heuristic, final, null);
const after = score("AFTER (pass-1 + Opus patches)", merged);

const dF = after.factors.hit - before.factors.hit;
const dP = after.params.hit - before.params.hit;
const dS = after.saved.hit - before.saved.hit;
console.log(`\n========== DELTA ==========`);
console.log(`  factors:    Δ ${dF >= 0 ? "+" : ""}${dF}`);
console.log(`  parameters: Δ ${dP >= 0 ? "+" : ""}${dP}`);
console.log(`  saved:      Δ ${dS >= 0 ? "+" : ""}${dS}`);
