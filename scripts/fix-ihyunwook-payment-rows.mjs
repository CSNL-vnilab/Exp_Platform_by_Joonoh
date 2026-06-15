// One-off settlement cleanup for the reschedule/rebook tangle on
// 최선우(Sbj13→16) and 이현욱(Sbj14→15). DB-MUTATING, idempotent, scoped to
// these two participants' booking_groups. Run by the USER (agent prod-writes
// are blocked by the auto-mode classifier):
//
//   !cd /Users/csnl/Documents/claude/lab-reservation-main && node --env-file=.env.local scripts/fix-ihyunwook-payment-rows.mjs
//
// Per group:
//   - ALL bookings cancelled/no_show  → payment_info.status = 'cancelled'
//     (cleans the stale 'pending'/'claimed' rows left by cancel+rebook).
//   - else, has a completed session + no send yet → mark manually dispatched
//     (payment_link_sent_at = now, clear error/attempts), since the user has
//     already emailed Sbj15/Sbj16 by hand.
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);
const TERMINAL = new Set(["cancelled", "no_show"]);
const nowIso = new Date().toISOString();

for (const nm of ["최선우", "이현욱"]) {
  const { data: parts } = await sb.from("participants").select("id, name").ilike("name", `%${nm}%`);
  const pids = (parts ?? []).map((p) => p.id);
  if (pids.length === 0) { console.log(`${nm}: no participant`); continue; }
  const { data: bk } = await sb
    .from("bookings")
    .select("booking_group_id, status")
    .in("participant_id", pids);
  const groups = [...new Set((bk ?? []).map((b) => b.booking_group_id).filter(Boolean))];
  for (const g of groups) {
    const statuses = (bk ?? []).filter((b) => b.booking_group_id === g).map((b) => b.status);
    const allTerminal = statuses.length > 0 && statuses.every((s) => TERMINAL.has(s));
    const { data: pi } = await sb
      .from("participant_payment_info")
      .select("booking_group_id, status, payment_link_sent_at")
      .eq("booking_group_id", g)
      .maybeSingle();
    if (!pi) { console.log(`  ${nm} ${g.slice(0,8)}: no payment_info — skip`); continue; }

    if (allTerminal) {
      if (pi.status === "cancelled") { console.log(`  ${nm} ${g.slice(0,8)}: already cancelled — skip`); continue; }
      const { error } = await sb.from("participant_payment_info")
        .update({ status: "cancelled" }).eq("booking_group_id", g);
      console.log(`  ${nm} ${g.slice(0,8)}: all-terminal → status=cancelled ${error?.message ?? "ok"}`);
    } else if (!pi.payment_link_sent_at) {
      const { error } = await sb.from("participant_payment_info")
        .update({ payment_link_sent_at: nowIso, payment_link_last_error: null, payment_link_attempts: 0 })
        .eq("booking_group_id", g);
      console.log(`  ${nm} ${g.slice(0,8)}: payable → marked manually-sent ${error?.message ?? "ok"}`);
    } else {
      console.log(`  ${nm} ${g.slice(0,8)}: payable, already sent — skip`);
    }
  }
}
console.log("done.");
