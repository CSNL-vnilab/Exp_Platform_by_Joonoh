#!/usr/bin/env node
// Follow-up to scripts/blacklist-participants.mjs:
//   1. Fix 이동연 email typo dy9772@nave.com → dy9772@naver.com.
//   2. Stamp the last-4 of each provided phone number into
//      participants.phone for identification (the standing "phone empty"
//      policy is overridden here per explicit user request: "식별을
//      위하여 전화번호 뒷자리 4개를 표시해줘"). Full phones are NOT
//      stored — only the trailing 4 digits.
//   3. Re-assign 'blacklist' with a proper reason via
//      assign_participant_class_manual (RPC = audit-logged, advisory-
//      locked). reason = "<사유> · <소속>" so the operator gets context
//      in the class history.
//
// Idempotent on the email + phone updates (no-op if already correct).
// The blacklist re-assignment is intentionally append: each call adds
// one more participant_classes row capturing the latest reason; the
// effective class stays 'blacklist'. Re-running just appends another
// identical row — preferable to a silent UPDATE because the audit
// trigger records the action.
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

// [email (corrected), name, affiliation, phone (raw), reason]
const ENTRIES = [
  ["dydrkfl2242@hanmail.net", "이종진", "서울대 국사학과",       "010-2961-0988", "참여 도중 욕설 및 불성실한 태도"],
  ["jinyoung2401@gmail.com",  "서진영", "무소속",               "010-4916-3088", "노쇼 2"],
  ["rhkryoo@gmail.com",       "문지수", "이화여대",             "010-9680-4958", "무응답"],
  ["jp9654@snu.ac.kr",        "윤종필", "서울대학교",           "0101-3822-9719", "직전취소"],
  ["ljeongatus@gmail.com",    "이정은", "서울대학교",           "010-6315-3958", "1시간 지각"],
  ["donggeun.lee98@gmail.com","이동근", "서울대학교",           "010-2461-0069", "직전취소"],
  ["qwepoi1012@naver.com",    "임재홍", "경기도청",             "010-5210-7281", "직전취소"],
  ["ii5603@naver.com",        "이호규", "서울대학교",           "010-7279-5603", "노쇼"],
  ["csy459@naver.com",        "조소예", "숙명여자대학교",       "1057965539",     "직전취소"],
  ["dy9772@naver.com",        "이동연", "서울대학교 음악대학",   "010-3783-5900", "직전취소"],
  ["shjeon09@naver.com",      "허가솔", "이화여자대학교",       "010-5132-8101", "노쇼"],
  ["bijumin@snu.ac.kr",       "김정민", "서울대학교",           "010-6470-3053", "지각&노쇼 (무응답)"],
  ["sykim713@snu.ac.kr",      "김수연", "서울대학교",           "010-9156-2762", "랜덤 응답 사후 적발"],
];

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

function last4(phoneRaw) {
  const d = String(phoneRaw ?? "").replace(/\D/g, "");
  return d.length >= 4 ? d.slice(-4) : d;
}
function normEmail(s) {
  return (s ?? "").trim().toLowerCase();
}

// ── resolve lab + admin ──
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

// ── existing participants (small table; load once) ──
const { data: existingAll } = await sb
  .from("participants")
  .select("id, name, phone, email");
const byEmail = new Map();
for (const p of existingAll ?? []) {
  const em = normEmail(p.email);
  if (em) byEmail.set(em, p);
}

// 이동연 may still be under the typo'd email row.
const TYPO_OLD = "dy9772@nave.com";
const TYPO_NEW = "dy9772@naver.com";

console.log(APPLY ? "MODE: APPLY" : "MODE: DRY-RUN");
console.log("");

// ── plan ──
const plan = [];
for (const [emailCorrected, name, affiliation, phoneRaw, reason] of ENTRIES) {
  const targetEmail = normEmail(emailCorrected);
  let match = byEmail.get(targetEmail);
  let renameFrom = null;
  if (!match && targetEmail === TYPO_NEW) {
    const old = byEmail.get(TYPO_OLD);
    if (old) {
      match = old;
      renameFrom = TYPO_OLD;
    }
  }
  if (!match) {
    console.warn(
      `  ! ${name} ${emailCorrected} — NOT in participants. Skipping (run blacklist-participants.mjs --apply first).`,
    );
    continue;
  }
  const desiredPhone = last4(phoneRaw);
  plan.push({
    id: match.id,
    name,
    emailCurrent: match.email,
    emailTarget: targetEmail,
    renameFrom,
    phoneCurrent: match.phone ?? "",
    phoneTarget: desiredPhone,
    reason: `${reason} · ${affiliation}`,
  });
}

console.log("── PLAN ──");
for (const p of plan) {
  const emailChange = p.renameFrom
    ? `  EMAIL: "${p.renameFrom}" → "${p.emailTarget}"`
    : "";
  const phoneChange =
    p.phoneCurrent !== p.phoneTarget
      ? `  PHONE: "${p.phoneCurrent}" → "${p.phoneTarget}"`
      : "  PHONE: (already " + p.phoneTarget + ")";
  console.log(
    `  ${p.id.slice(0, 8)} ${p.name.padEnd(8)}${emailChange}${phoneChange}`,
  );
  console.log(`           REASON: "${p.reason}"`);
}

if (!APPLY) {
  console.log(`\nDRY-RUN. Nothing written. Re-run with --apply.`);
  process.exit(0);
}

// ── apply ──
console.log(`\n--- APPLYING ---`);
let renamed = 0, phoned = 0, reasoned = 0, failed = 0;
for (const p of plan) {
  // (a) email rename (only for 이동연 typo case)
  if (p.renameFrom) {
    const { error } = await sb
      .from("participants")
      .update({ email: p.emailTarget })
      .eq("id", p.id);
    if (error) {
      failed += 1;
      console.error(`  ✗ rename email ${p.name}: ${error.message}`);
      continue;
    }
    renamed += 1;
    console.log(`  ✎ email ${p.id.slice(0, 8)} ${p.name}  ${p.renameFrom} → ${p.emailTarget}`);
  }

  // (b) phone last-4
  if (p.phoneCurrent !== p.phoneTarget) {
    const { error } = await sb
      .from("participants")
      .update({ phone: p.phoneTarget })
      .eq("id", p.id);
    if (error) {
      failed += 1;
      console.error(`  ✗ phone ${p.name}: ${error.message}`);
      continue;
    }
    phoned += 1;
    console.log(`  ☎ phone ${p.id.slice(0, 8)} ${p.name}  → "${p.phoneTarget}"`);
  }

  // (c) re-assign blacklist with the proper reason (append + audit)
  const { error: rpcErr } = await sb.rpc("assign_participant_class_manual", {
    p_participant_id: p.id,
    p_lab_id: lab.id,
    p_class: "blacklist",
    p_reason: p.reason,
    p_valid_until: null,
    p_assigned_by: admin.id,
  });
  if (rpcErr) {
    failed += 1;
    console.error(`  ✗ reason ${p.name}: ${rpcErr.message}`);
    continue;
  }
  reasoned += 1;
  console.log(`  ⚑ reason ${p.id.slice(0, 8)} ${p.name}`);
}

console.log(
  `\nDone. email-renamed=${renamed} phones-set=${phoned} reasons-applied=${reasoned} failed=${failed}`,
);
