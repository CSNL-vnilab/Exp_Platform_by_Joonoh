#!/usr/bin/env node
/**
 * QC for backfillPaymentInfoForExperiment (used by
 * /api/experiments/[id]/backfill-payment-info + the panel button).
 *
 * Pins the contract:
 *   - skipped if participation_fee <= 0
 *   - one row per booking_group, period from MIN/MAX of NON-cancelled
 *     bookings only, amount_krw = fee × non-cancelled session_count
 *   - idempotent: re-running skips groups that already have a row
 *   - cancelled-only groups don't get rows
 *   - null booking_group_id (legacy single-session) skipped
 */

process.env.PAYMENT_TOKEN_SECRET ||= "test-token-secret-" + "x".repeat(40);
process.env.PAYMENT_INFO_KEY ||= "test-key-" + "y".repeat(40);

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; process.stdout.write(`  ✅ ${name}\n`); }
  else { failed++; process.stdout.write(`  ❌ ${name}${detail ? " — " + detail : ""}\n`); }
}
async function group(label, fn) {
  console.log(`\n── ${label} ──`);
  try { await fn(); }
  catch (err) { failed++; console.log(`  ❌ ${label} crashed: ${err.message}\n${err.stack ?? ""}`); }
}

function makeSb(state) {
  function fromImpl(table) {
    const filt = {};
    const builder = {
      select() { return builder; },
      eq(c, v) { filt[c] = v; return builder; },
      in(c, v) { filt[c] = { in: v }; return builder; },
      maybeSingle() {
        const row = (state[table] ?? []).find((r) => matches(r, filt)) ?? null;
        return Promise.resolve({ data: row, error: null });
      },
      then(resolve) {
        const rows = (state[table] ?? []).filter((r) => matches(r, filt));
        resolve({ data: rows, error: null });
      },
      insert(payload) {
        const list = (state[table] = state[table] ?? []);
        list.push({ ...payload });
        return Promise.resolve({ error: null });
      },
    };
    return builder;
  }
  function matches(row, filter) {
    for (const [k, v] of Object.entries(filter)) {
      if (v && typeof v === "object" && "in" in v) {
        if (!v.in.includes(row[k])) return false;
      } else if (row[k] !== v) return false;
    }
    return true;
  }
  return { from: fromImpl };
}

const expId = "exp-1";
const fee = 30000;
const session = (groupId, slotStart, slotEnd, status = "confirmed", participantId = "p-1") => ({
  experiment_id: expId,
  participant_id: participantId,
  booking_group_id: groupId,
  slot_start: slotStart,
  slot_end: slotEnd,
  status,
});

await group("happy path: 3 groups all need backfill", async () => {
  const state = {
    experiments: [{ id: expId, participation_fee: fee }],
    bookings: [
      session("g1", "2026-04-01T05:00:00Z", "2026-04-01T06:00:00Z"),
      session("g1", "2026-04-03T05:00:00Z", "2026-04-03T06:00:00Z"),
      session("g2", "2026-04-05T05:00:00Z", "2026-04-05T06:00:00Z", "completed", "p-2"),
      session("g3", "2026-04-08T05:00:00Z", "2026-04-08T06:00:00Z", "completed", "p-3"),
      session("g3", "2026-04-09T05:00:00Z", "2026-04-09T06:00:00Z", "completed", "p-3"),
    ],
    participant_payment_info: [],
  };
  const sb = makeSb(state);
  const m = await import("../src/lib/payments/backfill.ts");
  const r = await m.backfillPaymentInfoForExperiment(sb, expId);
  check("groupsExamined=3", r.groupsExamined === 3);
  check("alreadyHadRow=0", r.alreadyHadRow === 0);
  check("inserted=3", r.inserted === 3, `got ${r.inserted}`);
  check("insertFailures=0", r.insertFailures === 0);
  check("skippedNoFee=false", r.skippedNoFee === false);
  // Per-group fee semantics: each group pays the experiment.participation_fee
  // ONCE regardless of session_count. Multi-session experiments still get
  // a single fee per booking_group.
  const g1Row = state.participant_payment_info.find((r) => r.booking_group_id === "g1");
  check("g1 amount = fee (NOT fee × 2 sessions)", g1Row?.amount_krw === fee);
  const g2Row = state.participant_payment_info.find((r) => r.booking_group_id === "g2");
  check("g2 amount = fee (single session)", g2Row?.amount_krw === fee);
  const g3Row = state.participant_payment_info.find((r) => r.booking_group_id === "g3");
  check("g3 amount = fee (NOT fee × 2 sessions)", g3Row?.amount_krw === fee);
});

await group("idempotent: groups already with row are skipped", async () => {
  const state = {
    experiments: [{ id: expId, participation_fee: fee }],
    bookings: [
      session("g1", "2026-04-01T05:00:00Z", "2026-04-01T06:00:00Z"),
      session("g2", "2026-04-05T05:00:00Z", "2026-04-05T06:00:00Z"),
    ],
    participant_payment_info: [
      // g1 already exists
      { id: "pi-1", booking_group_id: "g1", experiment_id: expId, status: "submitted_to_admin" },
    ],
  };
  const sb = makeSb(state);
  const m = await import("../src/lib/payments/backfill.ts");
  const r = await m.backfillPaymentInfoForExperiment(sb, expId);
  check("groupsExamined=2", r.groupsExamined === 2);
  check("alreadyHadRow=1", r.alreadyHadRow === 1);
  check("inserted=1 (only g2)", r.inserted === 1);
  check("g1 not duplicated", state.participant_payment_info.filter((r) => r.booking_group_id === "g1").length === 1);
});

await group("zero fee → skippedNoFee, no inserts", async () => {
  const state = {
    experiments: [{ id: expId, participation_fee: 0 }],
    bookings: [session("g1", "2026-04-01T05:00:00Z", "2026-04-01T06:00:00Z")],
    participant_payment_info: [],
  };
  const sb = makeSb(state);
  const m = await import("../src/lib/payments/backfill.ts");
  const r = await m.backfillPaymentInfoForExperiment(sb, expId);
  check("skippedNoFee=true", r.skippedNoFee === true);
  check("inserted=0", r.inserted === 0);
  check("no rows created", state.participant_payment_info.length === 0);
});

await group("cancelled-only group → no row", async () => {
  const state = {
    experiments: [{ id: expId, participation_fee: fee }],
    bookings: [
      session("g1", "2026-04-01T05:00:00Z", "2026-04-01T06:00:00Z", "cancelled"),
      session("g1", "2026-04-03T05:00:00Z", "2026-04-03T06:00:00Z", "cancelled"),
    ],
    participant_payment_info: [],
  };
  const sb = makeSb(state);
  const m = await import("../src/lib/payments/backfill.ts");
  const r = await m.backfillPaymentInfoForExperiment(sb, expId);
  check("groupsExamined=0 (cancelled-only filtered)", r.groupsExamined === 0);
  check("inserted=0", r.inserted === 0);
});

await group("half-cancelled group: amount = fee (per-group), period from non-cancelled", async () => {
  const state = {
    experiments: [{ id: expId, participation_fee: fee }],
    bookings: [
      session("g1", "2026-04-01T05:00:00Z", "2026-04-01T06:00:00Z", "completed"),
      session("g1", "2026-04-03T05:00:00Z", "2026-04-03T06:00:00Z", "completed"),
      session("g1", "2026-04-10T05:00:00Z", "2026-04-10T06:00:00Z", "cancelled"),
    ],
    participant_payment_info: [],
  };
  const sb = makeSb(state);
  const m = await import("../src/lib/payments/backfill.ts");
  await m.backfillPaymentInfoForExperiment(sb, expId);
  const row = state.participant_payment_info[0];
  check("amount = fee (per-group, NOT × N)", row.amount_krw === fee);
  // Period from MIN/MAX of non-cancelled only.
  check("period_end based on non-cancelled max",
        row.period_end === "2026-04-03",
        `got ${row.period_end}`);
});

await group("null booking_group_id (legacy) → skipped", async () => {
  const state = {
    experiments: [{ id: expId, participation_fee: fee }],
    bookings: [
      { experiment_id: expId, participant_id: "p-1", booking_group_id: null, slot_start: "2026-04-01T05:00:00Z", slot_end: "2026-04-01T06:00:00Z", status: "completed" },
    ],
    participant_payment_info: [],
  };
  const sb = makeSb(state);
  const m = await import("../src/lib/payments/backfill.ts");
  const r = await m.backfillPaymentInfoForExperiment(sb, expId);
  check("groupsExamined=0", r.groupsExamined === 0);
});

console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`✅ passed: ${passed}   ❌ failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
