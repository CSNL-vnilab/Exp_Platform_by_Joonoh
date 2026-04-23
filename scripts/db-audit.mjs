#!/usr/bin/env node
// Comprehensive DB health audit. Read-only; safe to run against prod.
//
// Exercises every invariant we've claimed in migrations 00001→latest, so
// reviewers / operators can spot drift between code expectations and the
// actual schema state. Fails (exit 1) on any CRITICAL finding; prints
// WARNING for soft findings but doesn't fail.
//
// What it checks:
//   1. Orphan / FK integrity — rows whose parent no longer exists
//   2. RLS enabled on every public table
//   3. Expected triggers present (bookings recompute, observations
//      updated_at, experiments activation gate, participant_classes audit)
//   4. Expected functions present (RPCs the code relies on)
//   5. Expected enum values present
//   6. Expected indexes present (performance-sensitive ones)
//   7. Salt column privilege (00030 — should be service-role only)
//   8. Recent migration landmarks (at least one row seeded per 00025 lab)
//   9. Dead tuples threshold via pg_stat_user_tables (maintenance hint)
//  10. Unique constraint that was dropped stays dropped (00028)
//
// Usage: node scripts/db-audit.mjs [--strict]
//
// --strict flag exits non-zero on WARNINGs too (for CI).

import { readFile } from "node:fs/promises";

const envText = await readFile(".env.local", "utf8").catch(() => "");
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
}
const token = process.env.SUPABASE_ACCESS_TOKEN;
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
if (!token || !url) {
  console.error("Missing SUPABASE_ACCESS_TOKEN or NEXT_PUBLIC_SUPABASE_URL");
  process.exit(1);
}
const ref = url.match(/https?:\/\/([a-z0-9]+)\.supabase\.co/i)?.[1];
if (!ref) {
  console.error("Bad NEXT_PUBLIC_SUPABASE_URL");
  process.exit(1);
}
const strict = process.argv.includes("--strict");

async function q(sql) {
  const r = await fetch(
    `https://api.supabase.com/v1/projects/${ref}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: sql }),
    },
  );
  const body = await r.json().catch(() => null);
  if (!r.ok) {
    throw new Error(
      `query failed (${r.status}): ${JSON.stringify(body).slice(0, 300)}`,
    );
  }
  return body;
}

const findings = [];
function critical(code, msg, detail) {
  findings.push({ level: "CRITICAL", code, msg, detail });
}
function warning(code, msg, detail) {
  findings.push({ level: "WARNING", code, msg, detail });
}
function ok(code, msg) {
  findings.push({ level: "OK", code, msg });
}

// ─────────────────── checks ───────────────────

async function checkOrphans() {
  const probes = [
    {
      code: "FK_BOOKINGS_EXP",
      sql: "SELECT COUNT(*)::int AS n FROM bookings b LEFT JOIN experiments e ON e.id = b.experiment_id WHERE e.id IS NULL",
    },
    {
      code: "FK_BOOKINGS_PARTICIPANT",
      sql: "SELECT COUNT(*)::int AS n FROM bookings b LEFT JOIN participants p ON p.id = b.participant_id WHERE p.id IS NULL",
    },
    {
      code: "FK_OBS_BOOKING",
      sql: "SELECT COUNT(*)::int AS n FROM booking_observations o LEFT JOIN bookings b ON b.id = o.booking_id WHERE b.id IS NULL",
    },
    {
      code: "FK_PCLASS_PARTICIPANT",
      sql: "SELECT COUNT(*)::int AS n FROM participant_classes pc LEFT JOIN participants p ON p.id = pc.participant_id WHERE p.id IS NULL",
    },
    {
      code: "FK_PCLASS_LAB",
      sql: "SELECT COUNT(*)::int AS n FROM participant_classes pc LEFT JOIN labs l ON l.id = pc.lab_id WHERE l.id IS NULL",
    },
    {
      code: "FK_INTEG_BOOKING",
      sql: "SELECT COUNT(*)::int AS n FROM booking_integrations i LEFT JOIN bookings b ON b.id = i.booking_id WHERE b.id IS NULL",
    },
    {
      code: "FK_EXP_LAB",
      sql: "SELECT COUNT(*)::int AS n FROM experiments e LEFT JOIN labs l ON l.id = e.lab_id WHERE l.id IS NULL",
    },
  ];
  for (const p of probes) {
    const rows = await q(p.sql);
    const n = rows[0].n;
    if (n > 0) critical(p.code, `${n} orphan rows`, p.sql);
    else ok(p.code, "no orphans");
  }
}

async function checkRls() {
  const rows = await q(
    "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity = false ORDER BY c.relname",
  );
  if (rows.length > 0) {
    for (const r of rows) warning("RLS_OFF", `RLS disabled on ${r.relname}`);
  } else {
    ok("RLS_ON", "all public tables have RLS enabled");
  }
}

async function checkTriggers() {
  const expected = [
    "bookings_recompute_class", // 00025
    "experiments_enforce_activation_metadata_trg", // 00022
    "participant_classes_to_audit", // 00029
    "booking_observations_set_updated_at", // 00026
  ];
  const rows = await q(
    `SELECT tgname FROM pg_trigger WHERE tgname IN (${expected
      .map((t) => `'${t}'`)
      .join(",")})`,
  );
  const present = new Set(rows.map((r) => r.tgname));
  for (const t of expected) {
    if (present.has(t)) ok("TRG", `${t} present`);
    else critical("TRG_MISSING", `trigger ${t} missing`);
  }
}

async function checkFunctions() {
  const expected = [
    "book_slot",
    "recompute_participant_class",
    "submit_booking_observation",
    "auto_complete_stale_bookings",
    "assign_participant_class_manual",
    "claim_next_notion_retry",
    "finalize_notion_retry",
    "ensure_participant_lab_identity",
  ];
  const rows = await q(
    `SELECT routine_name FROM information_schema.routines WHERE routine_schema='public' AND routine_name IN (${expected
      .map((t) => `'${t}'`)
      .join(",")})`,
  );
  const present = new Set(rows.map((r) => r.routine_name));
  for (const f of expected) {
    if (present.has(f)) ok("FN", `${f}()`);
    else if (f === "ensure_participant_lab_identity") {
      // App-layer only; DB func is optional.
      continue;
    } else {
      critical("FN_MISSING", `function ${f}() missing`);
    }
  }
}

async function checkEnums() {
  const probes = [
    {
      code: "ENUM_PCLASS",
      enumName: "participant_class",
      expected: ["newbie", "royal", "blacklist", "vip"],
    },
    {
      code: "ENUM_INTEGRATION",
      enumName: "integration_type",
      expected: [
        "gcal",
        "notion",
        "email",
        "sms",
        "notion_experiment",
        "notion_survey",
      ],
    },
    {
      code: "ENUM_HEALTH_CHECK",
      enumName: "notion_health_check_type",
      expected: ["schema_drift", "retry_sweep"],
    },
  ];
  for (const p of probes) {
    const rows = await q(
      `SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = '${p.enumName}' ORDER BY enumlabel`,
    );
    const got = new Set(rows.map((r) => r.enumlabel));
    const missing = p.expected.filter((v) => !got.has(v));
    if (missing.length === 0) ok(p.code, `${p.enumName} complete`);
    else critical(p.code, `${p.enumName} missing values: ${missing.join(", ")}`);
  }
}

async function checkIndexes() {
  const expected = [
    "idx_bookings_confirmed_slot",
    "idx_bookings_experiment_participant",
    "idx_bookings_slot_start",
    "idx_participant_classes_lookup",
    "idx_pli_lab_hmac",
    "idx_notion_health_recent",
  ];
  const rows = await q(
    `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname IN (${expected
      .map((t) => `'${t}'`)
      .join(",")})`,
  );
  const present = new Set(rows.map((r) => r.indexname));
  for (const i of expected) {
    if (present.has(i)) ok("IDX", i);
    else warning("IDX_MISSING", `index ${i} missing`);
  }
}

async function checkSaltPrivilege() {
  const [{ authed, anon, svc }] = await q(
    "SELECT has_column_privilege('authenticated','public.labs','participant_id_salt','SELECT') AS authed, has_column_privilege('anon','public.labs','participant_id_salt','SELECT') AS anon, has_column_privilege('service_role','public.labs','participant_id_salt','SELECT') AS svc",
  );
  if (authed || anon) {
    critical(
      "SALT_EXPOSED",
      "labs.participant_id_salt readable by authenticated/anon",
      { authed, anon, svc },
    );
  } else if (!svc) {
    critical(
      "SALT_UNREADABLE",
      "service_role can't read labs.participant_id_salt — identity module will fail",
      { svc },
    );
  } else {
    ok("SALT", "salt locked to service_role only");
  }
}

async function checkLabSeed() {
  const rows = await q("SELECT COUNT(*)::int AS n FROM labs WHERE code = 'CSNL'");
  if (rows[0].n < 1) critical("LAB_SEED", "CSNL lab row missing");
  else ok("LAB_SEED", "CSNL lab present");
}

async function checkDeadTuples() {
  const rows = await q(
    "SELECT relname, n_live_tup, n_dead_tup FROM pg_stat_user_tables WHERE schemaname='public' AND n_dead_tup > 1000 ORDER BY n_dead_tup DESC LIMIT 5",
  );
  for (const r of rows) {
    warning(
      "DEAD_TUPLES",
      `${r.relname}: live=${r.n_live_tup} dead=${r.n_dead_tup} — consider VACUUM`,
    );
  }
  if (rows.length === 0) ok("DEAD_TUPLES", "no tables exceed dead-tuple threshold");
}

async function checkDroppedUnique() {
  const rows = await q(
    "SELECT conname FROM pg_constraint WHERE conname = 'participant_classes_participant_id_lab_id_valid_from_key'",
  );
  if (rows.length > 0) {
    critical(
      "UNIQUE_RESURRECTED",
      "UNIQUE (participant_id, lab_id, valid_from) is back — 00028 was reverted or reapplied over",
    );
  } else {
    ok("UNIQUE_DROPPED", "participant_classes UNIQUE dropped as expected");
  }
}

async function checkFailedOutboxAccumulation() {
  const rows = await q(
    "SELECT integration_type, COUNT(*)::int AS n FROM booking_integrations WHERE status='failed' AND attempts >= 5 GROUP BY integration_type",
  );
  for (const r of rows) {
    warning(
      "OUTBOX_DEAD_LETTER",
      `${r.n} rows in ${r.integration_type} outbox exhausted retries (attempts >= 5)`,
    );
  }
  if (rows.length === 0) ok("OUTBOX", "no dead-letter accumulation");
}

// ─────────────────── run ───────────────────

console.log(`DB Audit · project ref=${ref} · ${new Date().toISOString()}`);
console.log("─".repeat(70));

const checks = [
  ["Orphans", checkOrphans],
  ["RLS", checkRls],
  ["Triggers", checkTriggers],
  ["Functions", checkFunctions],
  ["Enums", checkEnums],
  ["Indexes", checkIndexes],
  ["Salt privilege", checkSaltPrivilege],
  ["Lab seed", checkLabSeed],
  ["Dead tuples", checkDeadTuples],
  ["Dropped UNIQUE", checkDroppedUnique],
  ["Outbox dead letter", checkFailedOutboxAccumulation],
];

for (const [name, fn] of checks) {
  try {
    process.stdout.write(`[${name}] … `);
    await fn();
    process.stdout.write("done\n");
  } catch (err) {
    critical("CHECK_CRASHED", `${name}: ${err.message}`);
    process.stdout.write("CRASH\n");
  }
}

console.log("─".repeat(70));
const byLevel = { CRITICAL: 0, WARNING: 0, OK: 0 };
for (const f of findings) byLevel[f.level] += 1;

for (const f of findings) {
  if (f.level === "OK") continue;
  const marker = f.level === "CRITICAL" ? "❌" : "⚠ ";
  console.log(`${marker} [${f.level}] ${f.code}: ${f.msg}`);
  if (f.detail) console.log(`     ${JSON.stringify(f.detail)}`);
}

console.log(
  `\nSummary: ${byLevel.CRITICAL} critical · ${byLevel.WARNING} warning · ${byLevel.OK} OK`,
);

if (byLevel.CRITICAL > 0) process.exit(2);
if (strict && byLevel.WARNING > 0) process.exit(1);
process.exit(0);
