// Backfill orphaned settlement rows → status='cancelled'.
//
// Companion to migration 00075 (which relaxes the two CHECK constraints so
// 'cancelled' is a legal terminal state) and 00074 (which added the enum
// value). This is the one-time DATA repair that 00075 part-3 deliberately
// does NOT contain: a fully-terminal group (every booking cancelled/no_show)
// whose settlement row never reached 'cancelled' because the old constraints
// rejected the transition and the helper swallowed the error.
//
// DB-MUTATING. Run by the USER (agent prod-writes are blocked by the
// auto-mode classifier — that is why this is a script, not part of the
// migration):
//
//   !cd /Users/csnl/Documents/claude/lab-reservation-main && node --env-file=.env.local scripts/backfill-cancelled-settlement-rows.mjs
//
// Idempotent + paid-protective, mirroring the migration's WHERE clause:
//   - status NOT IN ('cancelled','paid','paid_offline')  — never reverse a
//     real payment or re-touch a settled row.
//   - the group has ≥1 booking AND none is live (all cancelled/no_show) — a
//     genuinely dead group.
// Only `status` flips (+ payment_link_sent_at stamped if blank, so the row
// also exits the "send pending" candidate set). claimed_at / amount_krw /
// PII columns are preserved for the audit trail. Re-running matches 0 rows
// once every dead group is settled.
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);
const TERMINAL = new Set(["cancelled", "no_show"]);
const nowIso = new Date().toISOString();

const { data: rows, error } = await sb
  .from("participant_payment_info")
  .select("id, booking_group_id, status, payment_link_sent_at")
  .not("status", "in", "(cancelled,paid,paid_offline)");
if (error) {
  console.error("query failed:", error.message);
  process.exit(1);
}

let settled = 0;
let skipped = 0;
for (const r of rows ?? []) {
  if (!r.booking_group_id) {
    skipped++;
    continue;
  }
  const { data: bks } = await sb
    .from("bookings")
    .select("status")
    .eq("booking_group_id", r.booking_group_id);
  if (!bks || bks.length === 0) {
    skipped++;
    continue;
  }
  const allTerminal = bks.every((b) => TERMINAL.has(b.status));
  if (!allTerminal) {
    skipped++;
    continue;
  }
  const { error: upErr } = await sb
    .from("participant_payment_info")
    .update({
      status: "cancelled",
      payment_link_sent_at: r.payment_link_sent_at ?? nowIso,
      updated_at: nowIso,
    })
    .eq("id", r.id);
  if (upErr) {
    console.error(`  ${r.id.slice(0, 8)} (was ${r.status}): FAILED — ${upErr.message}`);
    continue;
  }
  console.log(`  ${r.id.slice(0, 8)} (grp ${r.booking_group_id.slice(0, 8)}, was ${r.status}) → cancelled`);
  settled++;
}
console.log(`done. settled=${settled} skipped=${skipped} (of ${rows?.length ?? 0} non-terminal rows examined)`);
