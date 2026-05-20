#!/usr/bin/env node
// One-shot: strip the " · <소속>" suffix from the 13 blacklist reasons
// applied by chore/blacklist-reasons-2026-05-20 (bd096a5).
//
// User directive 2026-05-20-bis: "블랙리스트에서 소속은 삭제" —
// 소속(affiliation) was helpful at lookup time but should NOT live in
// the persistent reason; going forward researchers' blacklist
// submissions are reason-only (no affiliation field).
//
// Strategy: insert a fresh participant_classes row per participant via
// assign_participant_class_manual (RPC, audit trigger fires) with the
// cleaned reason. Schema is append-only and latest-wins, so the older
// "<reason> · <소속>" row stays for audit but the effective reason
// becomes clean.
//
// Idempotent: re-running just appends another row with the same clean
// reason — no harm.
//
// DRY-RUN by default; --apply writes.

import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";

const env = await readFile(".env.local", "utf8");
for (const l of env.split("\n")) {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
}

const APPLY = process.argv.includes("--apply");
const LAB_CODE = "CSNL";

// Email → cleaned reason (소속 stripped).
const CLEAN = [
  ["dydrkfl2242@hanmail.net", "참여 도중 욕설 및 불성실한 태도"],
  ["jinyoung2401@gmail.com",  "노쇼 2"],
  ["rhkryoo@gmail.com",       "무응답"],
  ["jp9654@snu.ac.kr",        "직전취소"],
  ["ljeongatus@gmail.com",    "1시간 지각"],
  ["donggeun.lee98@gmail.com","직전취소"],
  ["qwepoi1012@naver.com",    "직전취소"],
  ["ii5603@naver.com",        "노쇼"],
  ["csy459@naver.com",        "직전취소"],
  ["dy9772@naver.com",        "직전취소"],
  ["shjeon09@naver.com",      "노쇼"],
  ["bijumin@snu.ac.kr",       "지각&노쇼 (무응답)"],
  ["sykim713@snu.ac.kr",      "랜덤 응답 사후 적발"],
];

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const { data: lab } = await sb
  .from("labs")
  .select("id, code")
  .eq("code", LAB_CODE)
  .maybeSingle();
if (!lab?.id) { console.error(`FATAL: no lab ${LAB_CODE}`); process.exit(1); }
const { data: admin } = await sb
  .from("profiles")
  .select("id")
  .eq("role", "admin")
  .limit(1)
  .maybeSingle();
if (!admin?.id) { console.error("FATAL: no admin profile"); process.exit(1); }

const { data: existing } = await sb
  .from("participants")
  .select("id, name, email");
const byEmail = new Map();
for (const p of existing ?? []) {
  const em = (p.email ?? "").trim().toLowerCase();
  if (em) byEmail.set(em, p);
}

console.log(APPLY ? "MODE: APPLY" : "MODE: DRY-RUN");
console.log("\n── PLAN ──");
const plan = [];
for (const [email, cleanReason] of CLEAN) {
  const e = email.trim().toLowerCase();
  const m = byEmail.get(e);
  if (!m) {
    console.warn(`  ! ${email} — NOT in participants`);
    continue;
  }
  plan.push({ id: m.id, name: m.name, reason: cleanReason });
  console.log(`  ${m.id.slice(0, 8)} ${m.name.padEnd(8)} → reason="${cleanReason}"`);
}

if (!APPLY) {
  console.log(`\nDRY-RUN. Nothing written. Re-run with --apply.`);
  process.exit(0);
}

console.log(`\n--- APPLYING ---`);
let ok = 0, failed = 0;
for (const p of plan) {
  const { error } = await sb.rpc("assign_participant_class_manual", {
    p_participant_id: p.id,
    p_lab_id: lab.id,
    p_class: "blacklist",
    p_reason: p.reason,
    p_valid_until: null,
    p_assigned_by: admin.id,
  });
  if (error) {
    failed += 1;
    console.error(`  ✗ ${p.name}: ${error.message}`);
  } else {
    ok += 1;
    console.log(`  ⚑ ${p.id.slice(0, 8)} ${p.name}  reason="${p.reason}"`);
  }
}
console.log(`\nDone. cleaned=${ok} failed=${failed}`);
