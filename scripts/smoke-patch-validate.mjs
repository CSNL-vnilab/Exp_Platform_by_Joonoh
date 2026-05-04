#!/usr/bin/env node
//
// Smoke test for the chatbot patch validator.
//
// Exercises validatePatch / parsePatchBlocks / applyPatch with:
//   - 9 happy-path patches (one per op + a set_meta enum field)
//   - 6 malformed patches (bad op, unknown enum, wrong value type,
//     missing required name, malformed JSON, non-object payload)
//   - the post-apply re-parse safety net
//
// Run: npx tsx scripts/smoke-patch-validate.mjs

import path from "node:path";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");

const { applyPatch, parsePatchBlocks, summarisePatch, validatePatch } =
  await import(`${PROJECT_ROOT}/src/lib/experiments/code-analysis-patch.ts`);
const { CodeAnalysisOverridesSchema } = await import(
  `${PROJECT_ROOT}/src/lib/experiments/code-analysis-schema.ts`
);

let pass = 0;
let fail = 0;
const log = (ok, label, detail) => {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    fail += 1;
    console.error(`  FAIL ${label} — ${detail}`);
  }
};

// ---- valid patches ---------------------------------------------------

const valid = [
  { op: "set_meta", field: "n_blocks", value: 5 },
  { op: "set_meta", field: "estimated_duration_min", value: 22.5 },
  { op: "set_meta", field: "framework", value: "psychopy" },
  {
    op: "upsert_factor",
    name: "contrast",
    type: "continuous",
    levels: ["0.1", "0.3", "0.6"],
    role: "per_trial",
  },
  { op: "remove_factor", name: "contrast" },
  {
    op: "upsert_parameter",
    name: "tfeedback",
    type: "number",
    default: "1.0",
    unit: "s",
    shape: "constant",
  },
  { op: "remove_parameter", name: "tfeedback" },
  {
    op: "upsert_condition",
    label: "low",
    factor_assignments: { contrast: "0.1" },
  },
  {
    op: "upsert_saved_variable",
    name: "rt",
    format: "float",
    unit: "s",
  },
];

console.log("[1] valid patches");
for (const p of valid) {
  const r = validatePatch(p);
  log(r.ok, summarisePatch(r.ok ? r.patch : p), r.ok ? "" : r.error);
}

// ---- invalid patches -------------------------------------------------

const invalid = [
  { input: { op: "delete_universe" }, expectMsg: /알 수 없는 op/ },
  {
    input: { op: "upsert_factor", name: "x", role: "between_planet" },
    expectMsg: /role/i,
  },
  {
    input: { op: "set_meta", field: "n_blocks", value: "five" },
    expectMsg: /n_blocks/,
  },
  {
    input: { op: "set_meta", field: "framework", value: "homemade" },
    expectMsg: /framework/i,
  },
  { input: { op: "upsert_factor" }, expectMsg: /name/ },
  { input: "not-an-object", expectMsg: /object/ },
];

console.log("\n[2] invalid patches");
for (const { input, expectMsg } of invalid) {
  const r = validatePatch(input);
  if (r.ok) {
    log(false, JSON.stringify(input), "expected reject but got ok");
    continue;
  }
  log(
    expectMsg.test(r.error),
    `${JSON.stringify(input).slice(0, 70)} → ${r.error.slice(0, 80)}`,
    `error did not match ${expectMsg}`,
  );
}

// ---- parsePatchBlocks ------------------------------------------------

console.log("\n[3] parsePatchBlocks");
const sample = `
좋습니다, 두 가지를 제안드립니다.

<patch>{"op":"upsert_factor","name":"contrast","type":"continuous","levels":["0.1","0.6"],"role":"per_trial"}</patch>

그리고 이건 잘못된 enum 입니다 (테스트):

<patch>{"op":"set_meta","field":"framework","value":"homemade"}</patch>

JSON 자체가 깨진 경우:
<patch>{op:"oops"}</patch>
`;
const parsed = parsePatchBlocks(sample);
log(
  parsed.blocks.length === 3,
  `block count = ${parsed.blocks.length} (expect 3)`,
  "expected 3 blocks",
);
log(
  parsed.blocks[0].patch !== null && parsed.blocks[0].error === null,
  "block 0 valid",
  "block 0 should be valid",
);
log(
  parsed.blocks[1].patch === null && /framework/i.test(parsed.blocks[1].error ?? ""),
  "block 1 rejected (framework enum)",
  `error="${parsed.blocks[1].error}"`,
);
log(
  parsed.blocks[2].patch === null && /JSON/i.test(parsed.blocks[2].error ?? ""),
  "block 2 rejected (JSON parse)",
  `error="${parsed.blocks[2].error}"`,
);
log(
  parsed.prose.includes("좋습니다") && !parsed.prose.includes("<patch>"),
  "prose strips patch blocks",
  "prose did not strip patches",
);

// ---- applyPatch round-trip ------------------------------------------

console.log("\n[4] applyPatch + post-apply re-parse");

let overrides = CodeAnalysisOverridesSchema.parse({});

const seq = [
  {
    op: "upsert_factor",
    name: "contrast",
    type: "continuous",
    levels: ["0.1", "0.3", "0.6"],
    role: "per_trial",
    description: "Stimulus contrast",
  },
  { op: "set_meta", field: "n_blocks", value: 12 },
  { op: "set_meta", field: "summary", value: "5-day estimation" },
  {
    op: "upsert_saved_variable",
    name: "rt",
    format: "float",
    unit: "s",
  },
  { op: "upsert_factor", name: "contrast", levels: ["0.1", "0.3", "0.6", "1.0"] },
];

for (const p of seq) {
  const r = validatePatch(p);
  if (!r.ok) {
    log(false, summarisePatch(p), r.error);
    continue;
  }
  const result = applyPatch(overrides, r.patch);
  if (result.error) {
    log(false, summarisePatch(p), result.error);
    continue;
  }
  overrides = result.next;
  log(true, summarisePatch(p));
}

const finalParse = CodeAnalysisOverridesSchema.safeParse(overrides);
log(finalParse.success, "final overrides re-parses cleanly", finalParse.error?.message ?? "");
log(
  overrides.factors?.[0]?.levels?.length === 4,
  `factor "contrast" levels = ${JSON.stringify(overrides.factors?.[0]?.levels)}`,
  "expected 4 levels after second upsert",
);
log(
  overrides.meta?.n_blocks === 12,
  `meta.n_blocks = ${overrides.meta?.n_blocks}`,
  "expected n_blocks=12",
);

// ---- summary --------------------------------------------------------

console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
