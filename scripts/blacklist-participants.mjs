#!/usr/bin/env node
// Bulk-assign 'blacklist' class to a hand-picked list of participants.
//
// User directive 2026-05-20: 이 사람들을 블랙리스트로 등록. 이미
// 존재하는 id면 클래스만 'blacklist'로 변경. 13건.
//
// Uses the same path the admin UI uses:
//   admin.rpc("assign_participant_class_manual", {...})
// which (per migration 00029) takes a per-(participant,lab) advisory
// lock and lets the AFTER-INSERT trigger write the audit row. The
// 60-second cooldown check in /api/participants/[id]/class is a
// route-level pre-check, NOT enforced in the RPC, so a batch backfill
// can call it back-to-back safely.
//
// For each pair:
//   * Look up by normalized email. If 'dy9772@nave.com' style typos
//     don't match, also probe the 'naver.com' correction.
//   * If found AND already on active 'blacklist' → skip (idempotent).
//   * If found → assign_participant_class_manual(blacklist).
//   * If not found → create the participant (phone="", placeholder
//     birthdate/gender, per the standing 2026-05-19 "phone empty"
//     policy), then assign blacklist.
//   * Cascade-cancel any future confirmed/running bookings (mirrors
//     the API route's P2-3 behaviour). Best-effort — skipped for
//     historical-only participants who have no future slots.
//
// Default DRY-RUN. --apply writes.

import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";

const env = await readFile(".env.local", "utf8");
for (const l of env.split("\n")) {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
}

const APPLY = process.argv.includes("--apply");
const LAB_CODE = "CSNL";
const REASON = "backfill 2026-05-20: 사용자 지정 블랙리스트 일괄 등록";

// (email-as-given, name). Order preserved for reporting.
const TARGETS = [
  ["dydrkfl2242@hanmail.net", "이종진"],
  ["jinyoung2401@gmail.com", "서진영"],
  ["rhkryoo@gmail.com", "문지수"],
  ["jp9654@snu.ac.kr", "윤종필"],
  ["ljeongatus@gmail.com", "이정은"],
  ["donggeun.lee98@gmail.com", "이동근"],
  ["qwepoi1012@naver.com", "임재홍"],
  ["ii5603@naver.com", "이호규"],
  ["csy459@naver.com", "조소예"],
  ["dy9772@nave.com", "이동연"], // likely typo for naver.com — probe both
  ["shjeon09@naver.com", "허가솔"],
  ["bijumin@snu.ac.kr", "김정민"],
  ["sykim713@snu.ac.kr", "김수연"],
];

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

function normEmail(s) {
  return (s ?? "").trim().toLowerCase();
}

// 1. resolve lab + admin profile
const { data: lab } = await sb
  .from("labs")
  .select("id, code")
  .eq("code", LAB_CODE)
  .maybeSingle();
if (!lab?.id) {
  console.error(`FATAL: no lab ${LAB_CODE}`);
  process.exit(1);
}
const { data: admin } = await sb
  .from("profiles")
  .select("id, display_name")
  .eq("role", "admin")
  .limit(1)
  .maybeSingle();
if (!admin?.id) {
  console.error(`FATAL: no admin profile`);
  process.exit(1);
}

// 2. load existing participants once (small table)
const { data: existingAll } = await sb
  .from("participants")
  .select("id, name, email");
const byEmail = new Map();
for (const p of existingAll ?? []) {
  const em = normEmail(p.email);
  if (em) byEmail.set(em, p);
}

// 3. plan
console.log(APPLY ? "MODE: APPLY" : "MODE: DRY-RUN");
const plan = [];
for (const [emailRaw, name] of TARGETS) {
  const email = normEmail(emailRaw);
  let match = byEmail.get(email);
  let resolvedEmail = email;
  let typoCorrected = false;
  if (!match && /@nave\.com$/.test(email)) {
    const corrected = email.replace(/@nave\.com$/, "@naver.com");
    const probe = byEmail.get(corrected);
    if (probe) {
      match = probe;
      resolvedEmail = corrected;
      typoCorrected = true;
    }
  }
  plan.push({ emailRaw, name, email: resolvedEmail, match, typoCorrected });
}

// Inspect current effective class for matched participants in one batch.
const matchedIds = plan.filter((p) => p.match).map((p) => p.match.id);
const currentClass = new Map();
if (matchedIds.length) {
  const { data: classRows } = await sb
    .from("participant_classes")
    .select("participant_id, class, valid_from, valid_until")
    .eq("lab_id", lab.id)
    .in("participant_id", matchedIds)
    .order("valid_from", { ascending: false });
  const now = Date.now();
  for (const r of classRows ?? []) {
    if (currentClass.has(r.participant_id)) continue;
    if (r.valid_until && new Date(r.valid_until).getTime() <= now) continue;
    currentClass.set(r.participant_id, r.class);
  }
}

console.log(`\n── PLAN ──`);
let toAssign = 0, toCreate = 0, alreadyBL = 0, typoFixed = 0;
for (const p of plan) {
  if (p.match) {
    const cur = currentClass.get(p.match.id) ?? "(none)";
    if (cur === "blacklist") {
      console.log(`  = ${p.name.padEnd(8)} ${p.emailRaw}  already blacklist (skip)`);
      alreadyBL += 1;
    } else {
      console.log(
        `  ~ ${p.name.padEnd(8)} ${p.emailRaw}  ${p.match.id.slice(0, 8)}  ${cur} → blacklist`,
      );
      toAssign += 1;
    }
    if (p.typoCorrected) {
      console.log(`     (matched via typo-corrected email ${p.email})`);
      typoFixed += 1;
    }
  } else {
    console.log(`  + ${p.name.padEnd(8)} ${p.emailRaw}  NOT in roster → create + blacklist`);
    toCreate += 1;
  }
}
console.log(
  `\nSummary: assign=${toAssign}  create+assign=${toCreate}  already=${alreadyBL}  typo-fixed=${typoFixed}`,
);

if (!APPLY) {
  console.log(`\nDRY-RUN. Nothing written. Re-run with --apply.`);
  process.exit(0);
}

// 4. apply
console.log(`\n--- APPLYING ---`);
let assigned = 0, created = 0, skipped = 0, failed = 0, cancelledBookings = 0;
for (const p of plan) {
  let participantId = p.match?.id ?? null;

  // Create if missing.
  if (!participantId) {
    const { data: ins, error } = await sb
      .from("participants")
      .insert({
        name: p.name,
        phone: "", // policy: phone empty
        email: p.email,
        gender: "other",
        birthdate: "1900-01-01",
      })
      .select("id")
      .single();
    if (error) {
      const { data: again } = await sb
        .from("participants")
        .select("id")
        .eq("phone", "")
        .eq("email", p.email)
        .maybeSingle();
      if (again) {
        participantId = again.id;
      } else {
        failed += 1;
        console.error(`  ✗ create ${p.emailRaw}: ${error.message}`);
        continue;
      }
    } else {
      participantId = ins.id;
      created += 1;
      console.log(`  + created ${participantId.slice(0, 8)} ${p.name} ${p.email}`);
    }
  }

  // Skip if already on blacklist (idempotent).
  if (p.match && currentClass.get(p.match.id) === "blacklist") {
    skipped += 1;
    continue;
  }

  // Assign blacklist via the RPC (advisory-locked, audit trigger fires).
  const { error: rpcErr } = await sb.rpc("assign_participant_class_manual", {
    p_participant_id: participantId,
    p_lab_id: lab.id,
    p_class: "blacklist",
    p_reason: REASON,
    p_valid_until: null,
    p_assigned_by: admin.id,
  });
  if (rpcErr) {
    failed += 1;
    console.error(`  ✗ assign ${p.name} ${p.emailRaw}: ${rpcErr.message}`);
    continue;
  }
  assigned += 1;
  console.log(`  ~ blacklist ${participantId.slice(0, 8)} ${p.name}`);

  // Cascade-cancel any future confirmed/running bookings (mirrors P2-3).
  const nowIso = new Date().toISOString();
  const { data: futureBks } = await sb
    .from("bookings")
    .select("id")
    .eq("participant_id", participantId)
    .in("status", ["confirmed", "running"])
    .gt("slot_start", nowIso);
  for (const b of futureBks ?? []) {
    const { error: cancelErr } = await sb
      .from("bookings")
      .update({ status: "cancelled" })
      .eq("id", b.id)
      .in("status", ["confirmed", "running"]);
    if (!cancelErr) cancelledBookings += 1;
  }
}

console.log(
  `\nDone. assigned=${assigned} created+assigned=${created} skipped(already)=${skipped} failed=${failed} cascade-cancelled-bookings=${cancelledBookings}`,
);
