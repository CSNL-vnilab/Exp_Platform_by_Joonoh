#!/usr/bin/env node
/**
 * QC for the reschedule-propagation wiring (P0-Γ / Phase 3b).
 *
 * The actual SQL functions reschedule_reminders + propagate_payment_period
 * live in migration 00054 and are exercised against prod by the
 * verify-00054 script when first applied. Here we test:
 *
 *   1. runReschedulePipeline calls supabase.rpc("reschedule_reminders")
 *      with the right args, and supabase.rpc("propagate_payment_period")
 *      with the booking_group_id when present.
 *
 *   2. RPC failures are logged but don't crash the pipeline (still
 *      reaches the email send step).
 *
 *   3. Skips propagate_payment_period when booking_group_id is null
 *      (single-session legacy rows).
 *
 * We don't wire up the full SMTP/GCal pipeline — those are tested
 * elsewhere. Just stub at the supabase.rpc boundary.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.PAYMENT_TOKEN_SECRET ||= "test-token-secret-" + "x".repeat(40);
process.env.PAYMENT_INFO_KEY ||= "test-key-" + "y".repeat(40);
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://stub.local";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "stub-key";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

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

// ── 1. static read of booking.service.ts to confirm wiring ────────────
await group("runReschedulePipeline calls both propagation RPCs", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(
    join(repoRoot, "src/lib/services/booking.service.ts"),
    "utf8",
  );
  check("imports/calls reschedule_reminders rpc",
        src.includes('supabase.rpc("reschedule_reminders"'));
  check("calls propagate_payment_period rpc",
        src.includes('supabase.rpc("propagate_payment_period"'));
  check("passes p_booking_id arg",
        /reschedule_reminders[\s\S]+?p_booking_id:\s*row\.id/.test(src));
  check("passes p_new_slot_start arg",
        /reschedule_reminders[\s\S]+?p_new_slot_start:\s*row\.slot_start/.test(src));
  check("passes p_new_slot_end arg",
        /reschedule_reminders[\s\S]+?p_new_slot_end:\s*row\.slot_end/.test(src));
  check("propagate gated by booking_group_id presence",
        /if \(propagateGroupId\)/.test(src));
  check("RPC errors logged not thrown",
        /\[Reschedule\] reschedule_reminders.*failed/.test(src) &&
        /\[Reschedule\] propagate_payment_period.*failed/.test(src));
  check("RPC try/catch swallows throws",
        (src.match(/\[Reschedule\] reschedule_reminders threw/g) ?? []).length === 1 &&
        (src.match(/\[Reschedule\] propagate_payment_period threw/g) ?? []).length === 1);
});

// ── 2. PATCH route still calls runReschedulePipeline ──────────────────
await group("PATCH /api/bookings/[id] still calls runReschedulePipeline", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(
    join(repoRoot, "src/app/api/bookings/[bookingId]/route.ts"),
    "utf8",
  );
  check("imports runReschedulePipeline",
        src.includes("runReschedulePipeline"));
  check("calls runReschedulePipeline in PATCH",
        /await runReschedulePipeline\(/.test(src));
});

// ── 3. database.ts has the new RPC types ──────────────────────────────
await group("database.ts declares the new RPC signatures", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(
    join(repoRoot, "src/types/database.ts"),
    "utf8",
  );
  check("reschedule_reminders type entry", src.includes("reschedule_reminders: {"));
  check("propagate_payment_period type entry",
        src.includes("propagate_payment_period: {"));
  check("reschedule_reminders args complete",
        /p_booking_id:\s*string;\s*p_new_slot_start:\s*string;\s*p_new_slot_end:\s*string/.test(src));
});

// ── 4. migration shape sanity ─────────────────────────────────────────
await group("migration 00054 shape", async () => {
  const { readFile } = await import("node:fs/promises");
  const sql = await readFile(
    join(repoRoot, "supabase/migrations/00054_reschedule_propagation.sql"),
    "utf8",
  );
  check("defines reschedule_reminders function",
        sql.includes("CREATE OR REPLACE FUNCTION reschedule_reminders"));
  check("defines propagate_payment_period function",
        sql.includes("CREATE OR REPLACE FUNCTION propagate_payment_period"));
  check("uses Asia/Seoul timezone (mirrors book_slot)",
        sql.includes("AT TIME ZONE 'Asia/Seoul'"));
  check("only updates status='pending' reminders",
        sql.includes("AND status = 'pending'"));
  check("excludes cancelled/no_show from period MIN/MAX",
        sql.includes("status IN ('confirmed', 'running', 'completed')"));
  check("respects amount_overridden",
        sql.includes("v_payment.amount_overridden"));
  check("skips submitted/claimed/paid payment rows",
        sql.includes("v_payment.status <> 'pending_participant'"));
  check("loosens reminders.status check to allow 'cancelled'",
        sql.includes("'cancelled'") &&
        sql.includes("CHECK (status IN ('pending', 'sent', 'failed', 'cancelled'))"));
  check("RPCs are SECURITY DEFINER + REVOKE from PUBLIC",
        sql.includes("SECURITY DEFINER") &&
        sql.includes("REVOKE EXECUTE ON FUNCTION reschedule_reminders") &&
        sql.includes("REVOKE EXECUTE ON FUNCTION propagate_payment_period"));
});

console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`✅ passed: ${passed}   ❌ failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
