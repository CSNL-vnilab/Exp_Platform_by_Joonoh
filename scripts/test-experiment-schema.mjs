#!/usr/bin/env node
/**
 * Pin the relaxed location_id validation in experimentSchema (Phase 5b
 * hotfix) so we don't accidentally re-tighten it to z.string().uuid()
 * and re-break edits of experiments that reference seeded locations.
 *
 * Background: zod v4's .uuid() enforces strict RFC 4122 v1-v8 — rejects
 * fixture UUIDs like aaaaaaaa-aaaa-aaaa-aaaa-000000000001 that seed
 * scripts produce. The DB column is Postgres UUID so the application-
 * level loose 8-4-4-4-12 hex regex is no looser than the DB itself.
 */

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; process.stdout.write(`  ✅ ${name}\n`); }
  else { failed++; process.stdout.write(`  ❌ ${name}${detail ? " — " + detail : ""}\n`); }
}

const m = await import("../src/lib/utils/validation.ts");

console.log("\n── experimentSchema.location_id ──");

// Minimal valid experiment payload (everything else has defaults).
const baseValid = {
  title: "T",
  start_date: "2026-05-01",
  end_date: "2026-05-31",
  daily_start_time: "09:00",
  daily_end_time: "18:00",
  session_duration_minutes: 30,
};

const cases = [
  { label: "null location_id (most common — 선택 안 함)", value: null, expectOK: true },
  { label: "undefined location_id (omitted from form)", value: undefined, expectOK: true },
  {
    label: "real v4 UUID from gen_random_uuid()",
    value: "550e8400-e29b-41d4-a716-446655440000",
    expectOK: true,
  },
  {
    // The bug: this fixture UUID was seeded into experiment_locations
    // and zod v4 .uuid() rejected it as non-canonical (version nibble
    // 'a' is not in [1-8]).
    label: "fixture UUID with non-canonical version (the bug case)",
    value: "aaaaaaaa-aaaa-aaaa-aaaa-000000000001",
    expectOK: true,
  },
  { label: "garbage string", value: "not-a-uuid", expectOK: false },
  { label: "uuid with extra char", value: "550e8400-e29b-41d4-a716-446655440000x", expectOK: false },
];

for (const c of cases) {
  const r = m.experimentSchema.safeParse({ ...baseValid, location_id: c.value });
  const ok = r.success === c.expectOK;
  check(`${c.label} → ${c.expectOK ? "accepted" : "rejected"}`, ok,
        ok ? "" : `got success=${r.success}` +
              (!r.success ? ` issue=${r.error.issues[0]?.message}` : ""));
}

// ── experimentEditSchema (partial) — used by PUT /api/experiments/[id] ─
//
// Pinned because zod v4 .partial() throws on schemas with object-level
// refinements. The original code path was experimentSchema.partial(),
// which raised "cannot be used on object schemas containing refinements"
// AT RUNTIME inside safeParse — escaping the route's outer try/catch
// and surfacing as "Internal server error" to the researcher. Switching
// to a refine-free base + .partial() fixes it; this test pins the
// invariant so the next refactor doesn't reintroduce a top-level refine.
console.log("\n── experimentEditSchema (partial) ──");

check("does NOT throw on creation",
      typeof m.experimentEditSchema === "object" && m.experimentEditSchema !== null);

const editCases = [
  { label: "empty patch", value: {}, expectOK: true },
  { label: "title-only patch", value: { title: "new" }, expectOK: true },
  {
    label: "patch with the seeded location_id (the bug case)",
    value: { location_id: "aaaaaaaa-aaaa-aaaa-aaaa-000000000001" },
    expectOK: true,
  },
  {
    label: "full DB-shaped row (simulated form re-submit)",
    value: {
      ...baseValid,
      location_id: "aaaaaaaa-aaaa-aaaa-aaaa-000000000001",
      participation_fee: 90000,
      categories: ["offline_behavioral"],
      precautions: [{ question: "test", required_answer: true }],
      reminder_day_before_time: "18:00",
      reminder_day_of_time: "09:00",
    },
    expectOK: true,
  },
];

for (const c of editCases) {
  const r = m.experimentEditSchema.safeParse(c.value);
  const ok = r.success === c.expectOK;
  check(`${c.label} → ${c.expectOK ? "accepted" : "rejected"}`, ok,
        ok ? "" : (!r.success ? `issue=${r.error.issues[0]?.message}` : "unexpected success"));
}

console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`✅ passed: ${passed}   ❌ failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
