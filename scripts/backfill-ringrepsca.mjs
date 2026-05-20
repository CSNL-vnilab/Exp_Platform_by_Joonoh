#!/usr/bin/env node
// Backfill "RingRepSca" participants from the two recruitment xlsx.
//
// User directive 2026-05-20:
//   * Excel row color = "이미 처리됨/제외" 라벨 → SKIP those rows.
//     Detected fills in the source files: solid FFFF0000 (red),
//     FFB6D7A8 (green), FFFFFF00 (yellow). Any non-empty solid fill on
//     any cell of the row marks it labeled.
//   * Extract ONLY name + email (no phone/birthdate/gender this time).
//   * Tag everyone we backfill as 참여실험 = "RingRepSca" — i.e., link
//     them to an experiment titled exactly "RingRepSca" via a
//     status='completed' booking so the 참여자 관리 UI's "참여 실험"
//     column shows it.
//
// What this writes (only with --apply):
//   1. Ensures a single `experiments` row with title="RingRepSca",
//      status="completed", experiment_mode="offline" exists in the
//      CSNL lab (created if missing; reused if present).
//   2. For each un-colored row with a deliverable email + name:
//        a. Reuses the existing participants row matched by normalized
//           email, OR inserts a new one with phone="", placeholder
//           birthdate=1900-01-01 + gender='other'. Phone empty per the
//           standing policy.
//        b. Inserts a completed booking (slot_start = form timestamp,
//           +60min slot_end) UNLESS a completed booking for this
//           (participant, RingRepSca) already exists.
//
// Idempotent: re-running with --apply only inserts new rows it didn't
// see last time.
//
// DRY-RUN by default. --apply to write.

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import ExcelJS from "exceljs";
import { createClient } from "@supabase/supabase-js";

// ── env ───────────────────────────────────────────────────────────────
const env = await readFile(".env.local", "utf8");
for (const l of env.split("\n")) {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
}

const APPLY = process.argv.includes("--apply");
const FILES = process.argv
  .slice(2)
  .filter((a) => a !== "--apply" && !a.startsWith("--"));
if (FILES.length === 0) {
  FILES.push(
    "/Users/csnl/Downloads/외부 실험 참여자 모집 (Responses).xlsx",
    "/Users/csnl/Downloads/행동실험 참여신청 [4차] (Responses).xlsx",
  );
}

const EXPERIMENT_TITLE = "RingRepSca";
const LAB_CODE = "CSNL";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

// ── helpers ───────────────────────────────────────────────────────────
function cellText(v) {
  if (v == null) return "";
  if (typeof v === "object") {
    if ("text" in v) return String(v.text);
    if ("result" in v) return String(v.result);
    if ("richText" in v) return v.richText.map((t) => t.text).join("");
    if (v instanceof Date) return v.toISOString();
  }
  return String(v).trim();
}
function normEmail(raw) {
  const v = cellText(raw).trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return "";
  if (/@-$|@no-email\.local$|@imported\.invalid$|@example\.(com|test|org|net)$|@(.*\.)?test$/.test(v))
    return "";
  return v;
}
function normName(raw) {
  let s = cellText(raw).normalize("NFC").replace(/[​‌‍⁠­﻿]/g, "").trim();
  if (!s) return null;
  if (/^[A-Za-z]{2,5}$/.test(s)) return null;
  if (/^(미상|unknown|test|테스트)$/i.test(s)) return null;
  if (/[[\]{}]/.test(s)) return null;
  return s;
}
function detectColumns(headerRow) {
  const map = {};
  const vals = headerRow.values;
  for (let i = 1; i < vals.length; i++) {
    const h = cellText(vals[i]).toLowerCase();
    if (!h) continue;
    if (map.email == null && /email/.test(h)) map.email = i;
    else if (map.name == null && /성함|이름|name/.test(h)) map.name = i;
    else if (map.ts == null && /timestamp|타임스탬프/.test(h)) map.ts = i;
  }
  return map;
}

// A row is "labeled" if any of its cells carries a solid non-default
// fill (red / green / yellow per the source files). The default Google
// Sheets "no fill" still surfaces as `pattern|none` with empty colors,
// which we ignore.
function rowIsLabeled(row) {
  let labeled = false;
  row.eachCell({ includeEmpty: false }, (cell) => {
    if (labeled) return;
    const fill = cell.fill;
    if (!fill || fill.type !== "pattern" || fill.pattern !== "solid") return;
    const fg = fill.fgColor && (fill.fgColor.argb || "");
    if (!fg) return;
    if (/^FF?FFFFFFF?$/i.test(fg) || fg === "00000000") return; // pure white / transparent
    labeled = true;
  });
  return labeled;
}

// ── 1. read both files, filter to un-colored rows ────────────────────
console.log(APPLY ? "MODE: APPLY" : "MODE: DRY-RUN");
const collected = [];
let totalRows = 0, labeledSkipped = 0, badRowSkipped = 0;
for (const f of FILES) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(f);
  const ws =
    wb.getWorksheet("Form Responses 1") ?? wb.worksheets.find((s) => s.rowCount > 1);
  if (!ws) {
    console.warn(`  (no usable sheet in ${f})`);
    continue;
  }
  const cols = detectColumns(ws.getRow(1));
  let kept = 0, fileLabeled = 0;
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    if (row.values.every((v) => v == null || cellText(v) === "")) continue;
    totalRows += 1;
    if (rowIsLabeled(row)) {
      labeledSkipped += 1;
      fileLabeled += 1;
      continue;
    }
    const name = normName(row.getCell(cols.name ?? 0).value);
    const email = normEmail(row.getCell(cols.email ?? 0).value);
    if (!name || !email) {
      badRowSkipped += 1;
      continue;
    }
    const tsRaw = cellText(row.getCell(cols.ts ?? 0).value);
    const ts = tsRaw && !Number.isNaN(Date.parse(tsRaw)) ? tsRaw : null;
    collected.push({ name, email, ts, src: f.split("/").pop() });
    kept += 1;
  }
  console.log(
    `Read "${f.split("/").pop()}" cols=${JSON.stringify(cols)} kept=${kept} labeled-skip=${fileLabeled}`,
  );
}
console.log(
  `\nTotal data rows: ${totalRows}  labeled-skipped: ${labeledSkipped}  bad(no email/name): ${badRowSkipped}  kept: ${collected.length}`,
);

// dedup within input by email; keep earliest timestamp
const byEmail = new Map();
for (const r of collected) {
  const cur = byEmail.get(r.email);
  if (!cur || (r.ts && (!cur.ts || r.ts < cur.ts))) byEmail.set(r.email, r);
}
const people = [...byEmail.values()];
console.log(`Unique persons (by email): ${people.length}\n`);

// ── 2. resolve lab + admin profile + existing participants ───────────
const { data: lab } = await sb
  .from("labs")
  .select("id, code")
  .eq("code", LAB_CODE)
  .maybeSingle();
if (!lab?.id) {
  console.error(`FATAL: no lab with code ${LAB_CODE}`);
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

// 2a. ensure the experiment exists (idempotent by title)
let { data: experiment } = await sb
  .from("experiments")
  .select("id, title, status, experiment_mode")
  .eq("title", EXPERIMENT_TITLE)
  .maybeSingle();
if (experiment) {
  console.log(
    `Experiment "${EXPERIMENT_TITLE}" already exists (${experiment.id.slice(0, 8)}, status=${experiment.status}, mode=${experiment.experiment_mode})`,
  );
} else {
  console.log(`Experiment "${EXPERIMENT_TITLE}" will be CREATED (status=completed, offline).`);
}

// 2b. existing participants by normalized email
const { data: existing } = await sb
  .from("participants")
  .select("id, name, email");
const existingByEmail = new Map();
for (const p of existing ?? []) {
  const em = normEmail(p.email);
  if (em && !existingByEmail.has(em)) existingByEmail.set(em, p);
}

// ── 3. plan ──────────────────────────────────────────────────────────
const plan = { reusePart: 0, createPart: [], bookingNeeded: [] };

// We can't enumerate existing bookings on RingRepSca yet (experiment may
// not exist). When apply runs, after we ensure the experiment id, we
// query bookings keyed on (experiment_id, participant_id IN [...]) to
// dedup. For dry-run we just count people.
for (const p of people) {
  const match = existingByEmail.get(p.email);
  if (match) plan.reusePart += 1;
  else plan.createPart.push(p);
  plan.bookingNeeded.push(p);
}

console.log(`── PLAN ──`);
console.log(`  participants reuse:                 ${plan.reusePart}`);
console.log(`  participants create (new):          ${plan.createPart.length}`);
console.log(`  bookings to ensure on RingRepSca:   ${plan.bookingNeeded.length}`);

console.log(`\n── CREATE samples (max 20) ──`);
for (const p of plan.createPart.slice(0, 20)) {
  console.log(`  + ${String(p.name).padEnd(14)} ${p.email}  ${p.ts ?? ""}`);
}

if (!APPLY) {
  console.log(`\nDRY-RUN. Nothing written. Re-run with --apply.`);
  process.exit(0);
}

// ── 4. apply ─────────────────────────────────────────────────────────
console.log(`\n--- APPLYING ---`);

// 4a. experiment
let expId = experiment?.id ?? null;
if (!expId) {
  // Derive date window from collected timestamps; fallback wide.
  const tsList = people.map((p) => p.ts).filter(Boolean).sort();
  const startDate = (tsList[0] ?? "2024-01-01").slice(0, 10);
  const endDate = (tsList[tsList.length - 1] ?? new Date().toISOString()).slice(0, 10);
  const { data: insExp, error: expErr } = await sb
    .from("experiments")
    .insert({
      title: EXPERIMENT_TITLE,
      project_name: EXPERIMENT_TITLE,
      lab_id: lab.id,
      created_by: admin.id,
      status: "completed",
      experiment_mode: "offline",
      session_type: "single",
      session_duration_minutes: 60,
      required_sessions: 1,
      participation_fee: 0,
      daily_start_time: "10:00:00",
      daily_end_time: "18:00:00",
      weekdays: [1, 2, 3, 4, 5],
      start_date: startDate,
      end_date: endDate,
      max_participants_per_slot: 1,
      description:
        "[백필] RingRepSca — 외부 실험 참여자 모집 + 행동실험 [4차] 응답에서 라벨 미표시 행 통합. 2026-05-20.",
    })
    .select("id, title")
    .single();
  if (expErr) {
    console.error(`  ✗ experiment create failed: ${expErr.message}`);
    process.exit(1);
  }
  expId = insExp.id;
  console.log(`  + experiment ${expId.slice(0, 8)} ${insExp.title}`);
}

// 4b. participants
let partCreated = 0, partReused = 0, partFailed = 0;
const personIdByEmail = new Map();
for (const p of people) {
  const ex = existingByEmail.get(p.email);
  if (ex) {
    personIdByEmail.set(p.email, ex.id);
    partReused += 1;
    continue;
  }
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
    // race: someone else inserted same (phone,email) — look up
    const { data: again } = await sb
      .from("participants")
      .select("id")
      .eq("phone", "")
      .eq("email", p.email)
      .maybeSingle();
    if (again) {
      personIdByEmail.set(p.email, again.id);
      partReused += 1;
    } else {
      partFailed += 1;
      console.error(`  ✗ participant ${p.email}: ${error.message}`);
    }
    continue;
  }
  personIdByEmail.set(p.email, ins.id);
  partCreated += 1;
}

// 4c. bookings — dedup against existing on this experiment.
const personIds = [...personIdByEmail.values()];
const { data: priorBookings } = await sb
  .from("bookings")
  .select("participant_id")
  .eq("experiment_id", expId)
  .in("participant_id", personIds);
const haveBooking = new Set(
  ((priorBookings ?? [])).map((b) => b.participant_id),
);

let bkCreated = 0, bkSkipped = 0, bkFailed = 0;
for (const p of people) {
  const pid = personIdByEmail.get(p.email);
  if (!pid) continue;
  if (haveBooking.has(pid)) {
    bkSkipped += 1;
    continue;
  }
  const slotStart = p.ts ? new Date(p.ts) : new Date("2024-06-01T10:00:00+09:00");
  const slotEnd = new Date(slotStart.getTime() + 60 * 60 * 1000);
  const { error } = await sb.from("bookings").insert({
    experiment_id: expId,
    participant_id: pid,
    slot_start: slotStart.toISOString(),
    slot_end: slotEnd.toISOString(),
    status: "completed",
    session_number: 1,
    booking_group_id: randomUUID(),
  });
  if (error) {
    bkFailed += 1;
    console.error(`  ✗ booking ${p.email}: ${error.message}`);
    continue;
  }
  bkCreated += 1;
}

console.log(
  `\nDone. experiment=${expId.slice(0, 8)} | participants created=${partCreated} reused=${partReused} failed=${partFailed} | bookings created=${bkCreated} skipped=${bkSkipped} failed=${bkFailed}.`,
);
