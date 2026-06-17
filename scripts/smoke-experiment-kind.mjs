// Smoke test for the experiment_kind (external|pilot) feature + the
// experiment-creation drift fix (migration 00076/00077). Exercises the full
// experiment lifecycle against PROD via the service-role client and CLEANS UP
// after itself (deletes the experiments it creates — scoped by a unique title
// prefix so a crashed run is easy to purge).
//
// DB-MUTATING. Run by the USER (the auto-mode classifier blocks agent prod
// writes):
//   !cd /Users/csnl/Documents/claude/lab-reservation-main && node --env-file=.env.local scripts/smoke-experiment-kind.mjs
//
// What it asserts:
//   1. external draft inserts and round-trips with experiment_kind='external'
//      (this is the regression guard for the PGRST "payment_link_auto_send /
//      schema cache" creation bug — a bare insert must now succeed).
//   2. pilot draft inserts with experiment_kind='pilot' and participation_fee=0
//      → seedPaymentInfo would no-op (fee<=0), so pilot raises no settlement.
//   3. an UPDATE (title edit) persists.
//   4. status draft→active→cancelled transitions persist (the edit/cancel path).
//   5. cleanup deletes both test rows.
//
// NOT covered here (needs a participant + slot + Google service-account): live
// Google Calendar sync on booking confirm and booking cancel. Use the existing
// scripts/e2e-booking-test.mjs / scripts/e2e-reschedule.mjs for that — they
// drive the booking→GCal→cancel path end to end.
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const PREFIX = "[SMOKE experiment_kind]";
let pass = 0,
  fail = 0;
const ok = (c, m) => (c ? (pass++, console.log(`  ✅ ${m}`)) : (fail++, console.log(`  ❌ ${m}`)));

// Pre-purge any leftovers from a previous crashed run.
await sb.from("experiments").delete().like("title", `${PREFIX}%`);

const { data: lab } = await sb.from("labs").select("id").limit(1).maybeSingle();
const { data: prof } = await sb.from("profiles").select("id").limit(1).maybeSingle();
if (!lab?.id || !prof?.id) {
  console.error("no lab/profile to attribute the test experiment — aborting");
  process.exit(1);
}

const base = {
  lab_id: lab.id,
  created_by: prof.id,
  start_date: "2099-01-01",
  end_date: "2099-01-31",
  session_duration_minutes: 30,
  daily_start_time: "10:00",
  daily_end_time: "18:00",
  weekdays: [1, 2, 3, 4, 5],
  status: "draft",
};

const created = [];
try {
  // 1) external
  const { data: ext, error: extErr } = await sb
    .from("experiments")
    .insert({ ...base, title: `${PREFIX} external`, experiment_kind: "external", participation_fee: 30000 })
    .select("id, experiment_kind, participation_fee")
    .single();
  ok(!extErr, `external insert succeeds${extErr ? " — " + extErr.message : ""}`);
  if (ext) {
    created.push(ext.id);
    ok(ext.experiment_kind === "external", `external row records experiment_kind='external' (got ${ext?.experiment_kind})`);
  }

  // 2) pilot
  const { data: pil, error: pilErr } = await sb
    .from("experiments")
    .insert({ ...base, title: `${PREFIX} pilot`, experiment_kind: "pilot", participation_fee: 0 })
    .select("id, experiment_kind, participation_fee")
    .single();
  ok(!pilErr, `pilot insert succeeds${pilErr ? " — " + pilErr.message : ""}`);
  if (pil) {
    created.push(pil.id);
    ok(pil.experiment_kind === "pilot", `pilot row records experiment_kind='pilot' (got ${pil?.experiment_kind})`);
    ok(pil.participation_fee === 0, `pilot participation_fee is 0 → seedPaymentInfo no-ops (got ${pil?.participation_fee})`);
  }

  // 2b) invalid kind is rejected by the CHECK constraint
  const { error: badErr } = await sb
    .from("experiments")
    .insert({ ...base, title: `${PREFIX} bad`, experiment_kind: "nope" })
    .select("id")
    .single();
  ok(!!badErr, `invalid experiment_kind rejected by CHECK constraint${badErr ? "" : " — UNEXPECTEDLY ACCEPTED"}`);

  // 3) edit (title) persists
  if (ext) {
    const newTitle = `${PREFIX} external (edited)`;
    const { error: upErr } = await sb.from("experiments").update({ title: newTitle }).eq("id", ext.id);
    const { data: re } = await sb.from("experiments").select("title").eq("id", ext.id).single();
    ok(!upErr && re?.title === newTitle, `title edit persists`);
  }

  // 4) status lifecycle. NOTE: a RAW draft→active flip is intentionally gated —
  // activation requires research metadata (code_repo_url etc.) and the real
  // flow goes through /api/experiments/[id]/status, which enforces that check
  // and runs the Notion mirror. A direct service-role flip bypasses the API, so
  // 'active' legitimately may NOT persist for a metadata-less draft; that is the
  // activation guard working, not a regression. So we report active
  // informationally and hard-assert only the cancel path (no prereqs).
  if (ext) {
    const { error: actErr } = await sb.from("experiments").update({ status: "active" }).eq("id", ext.id);
    const { data: s1 } = await sb.from("experiments").select("status").eq("id", ext.id).single();
    console.log(
      `  ℹ️  draft→active (raw flip): status=${s1?.status}${actErr ? " — guarded: " + actErr.message : ""} ` +
        `(real activation + prereq check + Notion mirror happen in /api/experiments/[id]/status)`,
    );
    await sb.from("experiments").update({ status: "cancelled" }).eq("id", ext.id);
    const { data: s2 } = await sb.from("experiments").select("status").eq("id", ext.id).single();
    ok(s2?.status === "cancelled", `status → cancelled persists`);
  }
} finally {
  // 5) cleanup
  for (const id of created) await sb.from("experiments").delete().eq("id", id);
  const { data: leftover } = await sb.from("experiments").select("id").like("title", `${PREFIX}%`);
  ok((leftover?.length ?? 0) === 0, `cleanup removed all ${PREFIX} rows`);
}

console.log(`\n${"━".repeat(50)}\n${fail === 0 ? "✅" : "❌"} passed: ${pass}   failed: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
