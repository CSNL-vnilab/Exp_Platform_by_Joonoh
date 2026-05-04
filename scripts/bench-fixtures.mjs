#!/usr/bin/env node
// Cross-genre / cross-framework fixture bench.
//
// For each fixture under scripts/fixtures/* the expected ground truth
// is encoded inline (small "must-include" sets). The harness runs
// fetchSource → bundle → runHeuristic → runAiAnalysis (with the
// fixture README auto-injected as docs) and prints per-fixture
// pass-rate + a summary leaderboard.
//
// Usage:
//   npx tsx scripts/bench-fixtures.mjs
//   PROVIDER=anthropic npx tsx scripts/bench-fixtures.mjs   # uses Claude Opus
//   FIXTURES=psychopy_estimation,jspsych_decision npx tsx scripts/bench-fixtures.mjs
//   REFINEMENT=on npx tsx scripts/bench-fixtures.mjs        # turn on 2-pass refinement
//   REFINEMENT=on REFINEMENT_MODEL=gemma4:31b npx tsx scripts/bench-fixtures.mjs

import path from "node:path";
import { readFile, readdir } from "node:fs/promises";

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

// --- ground truth per fixture -----------------------------------------
// Each fixture lists the *minimum* the analyzer should recover. Extra
// items don't lose points; missing required ones do.
const FIXTURES = {
  psychopy_estimation: {
    framework: "psychopy",
    domain_genre_one_of: ["estimation", "psychophysics"],
    factors_required: ["stim_duration"],
    factors_bogus: ["expInfo", "expInfo.condition"],
    parameters_required: ["n_blocks", "n_trials_per_block", "fixation_duration", "iti"],
    parameter_values: { fixation_duration: 0.5, iti: 0.6, n_blocks: 6, n_trials_per_block: 40 },
    saved_required: ["rt", "response", "correct", "stim_duration"],
    n_blocks: 6,
    n_trials_per_block: 40,
  },
  jspsych_decision: {
    framework: "jspsych",
    domain_genre_one_of: ["decision", "perception"],
    factors_required: ["coherence", "direction", "payoff"],
    factors_bogus: [],
    parameters_required: ["stimulus_duration", "trial_duration"],
    parameter_values: { stimulus_duration: 800, trial_duration: 2500 },
    saved_required: ["choice", "correct", "rt", "coherence", "direction", "payoff", "participant_id"],
    n_blocks: 4,
    n_trials_per_block: null,        // factorial × repetitions
  },
  ptb_psychophysics: {
    framework: "psychtoolbox",
    domain_genre_one_of: ["psychophysics"],
    factors_required: ["contrast"],
    factors_bogus: ["condition"],     // single-value, not IV
    parameters_required: ["nBlocks", "nT", "tStim", "tFixation", "iti"],
    parameter_values: { nBlocks: 5, nT: 60, tStim: 0.05, tFixation: 0.5, iti: 0.4 },
    saved_required: ["contrast", "response", "correct", "rt", "blockThreshold"],
    n_blocks: 5,
    n_trials_per_block: 60,
  },
  r_categorization: {
    framework: "custom",
    domain_genre_one_of: ["categorization", "decision"],
    factors_required: ["block_kind", "orientation"],
    factors_bogus: [],
    parameters_required: ["N_TRAINING_BLOCKS", "N_TEST_BLOCKS", "N_TRIALS_PER_BLOCK", "ITI_MS", "FEEDBACK_MS"],
    parameter_values: {
      N_TRAINING_BLOCKS: 4,
      N_TEST_BLOCKS: 2,
      N_TRIALS_PER_BLOCK: 50,
      ITI_MS: 400,
      FEEDBACK_MS: 800,
    },
    saved_required: ["block", "block_kind", "trial", "orientation", "response", "correct", "rt"],
    // expects block_phases split: 4 training + 2 test
    expects_block_phases: true,
  },
  labjs_staircase_audiovisual: {
    framework: "lab.js",
    domain_genre_one_of: ["psychophysics"],
    factors_required: ["soa", "modality"],
    factors_bogus: ["QUEST_BETA"], // single value — should be parameter, not factor
    parameters_required: [
      "QUEST_BETA",
      "QUEST_GUESS_RATE",
      "N_TRIALS",
      "AUDIO_DURATION_MS",
      "VISUAL_DURATION_MS",
      "ITI_MS",
      "STARTING_SOA_MS",
    ],
    parameter_values: {
      QUEST_BETA: 3.5,
      N_TRIALS: 80,
      AUDIO_DURATION_MS: 50,
      VISUAL_DURATION_MS: 50,
      ITI_MS: 600,
      STARTING_SOA_MS: 100,
    },
    saved_required: ["soa", "response", "rt", "correct", "quest_mean", "subject_id"],
    expects_block_phases: true,
  },
};

// --- scoring helpers ---------------------------------------------------
function approxEq(a, b, tol = 1e-3) {
  if (a == null || b == null) return false;
  return Math.abs(Number(a) - Number(b)) <= tol;
}
// Fuzzy name match: exact (case-insensitive) OR the gt name is a
// substring of the candidate (e.g. "orientation" ↔ "stim_orientation",
// "iti" ↔ "ITI_MS"), OR vice-versa. Keeps scoring meaningful across
// reasonable name choice differences without being trivially permissive.
function findByName(arr, name) {
  const want = name.toLowerCase();
  return (arr ?? []).find((x) => {
    const got = (x.name ?? "").toLowerCase();
    if (got === want) return true;
    if (got.length >= 3 && want.length >= 3) {
      if (got.includes(want) || want.includes(got)) return true;
    }
    return false;
  });
}
function findInSaved(arr, name) {
  const k = name.toLowerCase();
  return (arr ?? []).some((s) => {
    const n = (s.name ?? "").toLowerCase();
    return n === k || n.endsWith(`.${k}`) || n.split(/[.\s]/).pop() === k;
  });
}

function scoreFixture(merged, gt) {
  let total = 0;
  let possible = 0;
  const detail = {};

  // framework
  detail.framework = merged.meta.framework === gt.framework;
  total += detail.framework ? 1 : 0;
  possible += 1;

  // domain genre
  detail.domain_genre = gt.domain_genre_one_of.includes(merged.meta.domain_genre);
  total += detail.domain_genre ? 1 : 0;
  possible += 1;

  // n_blocks / n_trials
  if (gt.n_blocks != null) {
    detail.n_blocks = merged.meta.n_blocks === gt.n_blocks;
    total += detail.n_blocks ? 1 : 0;
    possible += 1;
  }
  if (gt.n_trials_per_block != null) {
    detail.n_trials_per_block = merged.meta.n_trials_per_block === gt.n_trials_per_block;
    total += detail.n_trials_per_block ? 1 : 0;
    possible += 1;
  }

  // factors required
  detail.factors = {};
  for (const f of gt.factors_required) {
    const hit = !!findByName(merged.factors, f);
    detail.factors[f] = hit;
    total += hit ? 2 : 0;
    possible += 2;
  }
  // bogus penalty (subtract — no negative points but flag in output)
  detail.factors_bogus_present = (gt.factors_bogus ?? []).filter((b) =>
    !!findByName(merged.factors, b),
  );

  // parameters
  detail.params = {};
  for (const p of gt.parameters_required) {
    const got = findByName(merged.parameters, p);
    detail.params[`${p}_present`] = !!got;
    total += got ? 1 : 0;
    possible += 1;
    const want = (gt.parameter_values ?? {})[p];
    if (want != null) {
      const valueOk = !!got && approxEq(parseFloat(got.default), want);
      detail.params[`${p}_value`] = valueOk;
      total += valueOk ? 1 : 0;
      possible += 1;
    }
  }

  // saved
  detail.saved = {};
  for (const s of gt.saved_required) {
    const hit = findInSaved(merged.saved_variables, s);
    detail.saved[s] = hit;
    total += hit ? 1 : 0;
    possible += 1;
  }

  // block_phases (categorization fixture)
  if (gt.expects_block_phases) {
    const phases = merged.meta.block_phases ?? [];
    const ok = phases.length >= 2;
    detail.block_phases = ok;
    total += ok ? 2 : 0;
    possible += 2;
  }

  return { score: total, possible, pct: total / possible, detail };
}

// --- run ---------------------------------------------------------------
const fixturesArg = process.env.FIXTURES?.split(",") ?? Object.keys(FIXTURES);
const provider = (process.env.PROVIDER ?? "auto");

console.log(`bench-fixtures: provider=${provider}; ${fixturesArg.length} fixtures`);
const results = [];
for (const name of fixturesArg) {
  const gt = FIXTURES[name];
  if (!gt) {
    console.log(`  [skip ${name}] not in registry`);
    continue;
  }
  const dir = path.join(PROJECT_ROOT, "scripts", "fixtures", name);
  process.stdout.write(`  [${name.padEnd(28)}] `);
  let fetched, bundleInfo, ai, t0, ms;
  try {
    fetched = await fetchSource({ source: dir });
    if (fetched.files.length === 0) throw new Error("empty fixture");
    // auto docs from fixture README
    const docs = fetched.files.find((f) => /^readme/i.test(f.path))?.content ?? null;
    bundleInfo = bundle(fetched.files);
    if (!bundleInfo.entry) throw new Error("no entry detected");
    const heuristic = runHeuristic({ code: bundleInfo.bundled, filename: bundleInfo.entry });
    t0 = Date.now();
    const r = await runAiAnalysis({
      code: bundleInfo.bundled,
      filename: bundleInfo.entry,
      heuristic,
      docs,
      provider,
    });
    ai = r.analysis;
    ms = Date.now() - t0;
    const merged = mergeAnalysis(heuristic, ai, null);
    const sc = scoreFixture(merged, gt);
    let refineNote = "";
    if (r.refinement) {
      const ref = r.refinement;
      refineNote =
        ` · refine ${ref.appliedCount}±${ref.rejectedCount} (${(ref.durationMs / 1000).toFixed(1)}s, ${ref.model})`;
    }
    console.log(
      `${(sc.pct * 100).toFixed(1).padStart(5)}% (${sc.score}/${sc.possible}) in ${(ms / 1000).toFixed(1)}s · model ${r.model}${refineNote}`,
    );
    if (sc.detail.factors_bogus_present.length > 0) {
      console.log(`     bogus factors detected: ${sc.detail.factors_bogus_present.join(", ")}`);
    }
    results.push({ name, ...sc, ms, model: r.model, refinement: r.refinement });
  } catch (err) {
    console.log(`FAIL ${(err && err.message) ? err.message.slice(0, 100) : err}`);
    results.push({ name, score: 0, possible: 1, pct: 0, ms: 0, error: String(err) });
  } finally {
    if (fetched?.cleanup) await fetched.cleanup();
  }
}

// summary
console.log("\n--- summary ---");
let totalScore = 0;
let totalPossible = 0;
let totalApplied = 0;
let totalRejected = 0;
let totalRefineMs = 0;
for (const r of results) {
  totalScore += r.score;
  totalPossible += r.possible;
  if (r.refinement) {
    totalApplied += r.refinement.appliedCount;
    totalRejected += r.refinement.rejectedCount;
    totalRefineMs += r.refinement.durationMs;
  }
  console.log(
    `  ${r.name.padEnd(28)} ${(r.pct * 100).toFixed(1).padStart(5)}%  (${r.score}/${r.possible})${r.error ? "  · " + r.error.slice(0, 60) : ""}`,
  );
}
const overall = totalScore / Math.max(totalPossible, 1);
console.log(`\noverall: ${(overall * 100).toFixed(1)}% (${totalScore}/${totalPossible})`);
if (totalApplied + totalRejected > 0) {
  console.log(
    `refinement: ${totalApplied} applied · ${totalRejected} rejected · ${(totalRefineMs / 1000).toFixed(1)}s total`,
  );
}
