#!/usr/bin/env node
// Backfill participant EMAILS from Google-Form recruitment-response
// spreadsheets into Supabase `participants`.
//
// User policy (2026-05-19):
//   * Phone numbers are NEVER recorded — every row is written/updated
//     with phone="". Only emails are salvaged ("이메일 살릴 수 있는
//     것들만 살릴 것"). Rows with no usable email are skipped, not
//     turned into name-only placeholders.
//   * This script never wipes phone on existing rows; it simply does
//     not populate the column. (Existing real phone data is left as-is.)
//   * 김서연 (time2dist / timeexp1) → kimseoyeon1145@gmail.com, no phone
//     — injected as a manual record so it flows through the same
//     dedup/enrich path (matches the calendar-backfilled "김서연@-" row).
//
// Column layouts differ per file, so columns are detected by header
// text (성함→name, "Email"→email, 생년월일→birthdate, 성별→gender,
// Timestamp→ts). Phone column is intentionally ignored.
//
// Dedup: same person across files/rows collapsed by email (lowercased)
// → else name. Matched against existing participants by email → name.
// Placeholder rows ("{name}@-" / empty email) get ENRICHED with the
// real email (+ birthdate/gender if those were placeholders too).
//
// Safety: DRY-RUN by default (pure read of xlsx + Supabase). `--apply`
// writes. participants.UNIQUE(phone,email) is respected (phone="" so
// uniqueness collapses to email).
//
// Usage:
//   node scripts/import-form-responses.mjs                       # dry-run, default 2 files
//   node scripts/import-form-responses.mjs --apply
//   node scripts/import-form-responses.mjs --apply "/path/a.xlsx" "/path/b.xlsx"

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
const fileArgs = process.argv
  .slice(2)
  .filter((a) => a !== "--apply" && !a.startsWith("--"));
const FILES =
  fileArgs.length > 0
    ? fileArgs
    : [
        "/Users/csnl/Downloads/외부 실험 참여자 모집 (Responses).xlsx",
        "/Users/csnl/Downloads/행동실험 참여신청 [4차] (Responses).xlsx",
      ];

// Manual contacts the calendar/forms don't carry. Flow through the same
// path so they dedup/enrich safely instead of blind-inserting.
const MANUAL_CONTACTS = [
  { name: "김서연", email: "kimseoyeon1145@gmail.com", ts: "9999-01-01" },
];

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

// ── normalization ─────────────────────────────────────────────────────
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
  if (/^(미상|unknown|test|테스트|n\/a|na|없음)$/i.test(s)) return null;
  return s;
}
function parseGender(raw) {
  const s = cellText(raw);
  if (/남|^m$|male/i.test(s)) return "male";
  if (/여|^f$|female/i.test(s)) return "female";
  return "other";
}
// 6-digit YYMMDD or 8-digit YYYYMMDD → "YYYY-MM-DD" (else placeholder).
function parseBirthdate(raw) {
  const digits = cellText(raw).replace(/\D/g, "");
  let y, mo, d;
  if (digits.length === 8) {
    y = +digits.slice(0, 4);
    mo = +digits.slice(4, 6);
    d = +digits.slice(6, 8);
  } else if (digits.length === 6) {
    const yy = +digits.slice(0, 2);
    // 2026 context, adults → born ≈ 1989-2006: yy 00-25 → 20xx, 26-99 → 19xx
    y = yy <= 25 ? 2000 + yy : 1900 + yy;
    mo = +digits.slice(2, 4);
    d = +digits.slice(4, 6);
  } else {
    return "1900-01-01";
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1900 || y > 2025)
    return "1900-01-01";
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function detectColumns(headerRow) {
  const map = {};
  const vals = headerRow.values;
  for (let i = 1; i < vals.length; i++) {
    const h = cellText(vals[i]).toLowerCase();
    if (!h) continue;
    if (map.email == null && /email/.test(h)) map.email = i;
    else if (map.name == null && /성함|이름|name/.test(h)) map.name = i;
    else if (map.birth == null && /생년월일|birth/.test(h)) map.birth = i;
    else if (map.gender == null && /성별|gender/.test(h)) map.gender = i;
    else if (map.ts == null && /timestamp|타임스탬프/.test(h)) map.ts = i;
  }
  return map;
}

// ── read all rows ─────────────────────────────────────────────────────
const rawPeople = [];
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
  let read = 0;
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const name = normName(row.getCell(cols.name ?? 0).value);
    const email = normEmail(row.getCell(cols.email ?? 0).value);
    if (!name && !email) continue;
    rawPeople.push({
      name: name ?? "(미상)",
      email,
      gender: parseGender(row.getCell(cols.gender ?? 0).value),
      birthdate: parseBirthdate(row.getCell(cols.birth ?? 0).value),
      ts: cellText(row.getCell(cols.ts ?? 0).value),
      src: f.split("/").pop(),
    });
    read += 1;
  }
  console.log(
    `Read ${read} rows from "${f.split("/").pop()}" cols=${JSON.stringify(cols)}`,
  );
}
for (const m of MANUAL_CONTACTS)
  rawPeople.push({
    name: m.name,
    email: normEmail(m.email),
    gender: "other",
    birthdate: "1900-01-01",
    ts: m.ts,
    src: "(manual)",
  });

// ── dedup within the input ────────────────────────────────────────────
const persons = new Map(); // key -> person (latest ts wins for bd/gender)
let noEmail = 0;
for (const p of rawPeople) {
  if (!p.email) {
    noEmail += 1;
    // "only salvage emails" — keep for the name-fallback dedup so we can
    // still ENRICH an existing row if one matches by name, but never
    // CREATE a new no-email row.
  }
  const key = p.email || `name:${p.name.normalize("NFC").toLowerCase()}`;
  const cur = persons.get(key);
  if (!cur) {
    persons.set(key, { ...p });
  } else {
    if (p.ts > cur.ts) {
      cur.ts = p.ts;
      if (p.birthdate !== "1900-01-01") cur.birthdate = p.birthdate;
      if (p.gender !== "other") cur.gender = p.gender;
    }
    if (!cur.email && p.email) cur.email = p.email;
    if (cur.name === "(미상)" && p.name !== "(미상)") cur.name = p.name;
  }
}

console.log(
  `\nInput rows: ${rawPeople.length}  no-email rows: ${noEmail}  unique persons: ${persons.size}`,
);

// ── existing participants ─────────────────────────────────────────────
const { data: existing } = await sb
  .from("participants")
  .select("id, name, phone, email, gender, birthdate");
const byEmail = new Map();
const byName = new Map();
for (const p of existing ?? []) {
  const em = normEmail(p.email);
  const nm = (p.name ?? "").normalize("NFC").toLowerCase().trim();
  if (em && !byEmail.has(em)) byEmail.set(em, p);
  if (nm && !byName.has(nm)) byName.set(nm, p);
}
// Raw (phone,email) pairs already in the table — phone is always "" for
// our writes so this collapses to "|<email>".
const seenPE = new Set((existing ?? []).map((p) => `${p.phone ?? ""}|${p.email ?? ""}`));

// ── plan ──────────────────────────────────────────────────────────────
const plan = { reuse: [], enrich: [], create: [], conflict: [], skip: [] };

for (const [, person] of persons) {
  const nm = person.name.normalize("NFC").toLowerCase();
  const match =
    (person.email && byEmail.get(person.email)) || byName.get(nm) || null;

  if (match) {
    const exEmailReal = !!normEmail(match.email);
    const set = {};
    if (person.email && !exEmailReal) {
      // collision guard: another existing row already owns ("",email)?
      const owner = byEmail.get(person.email);
      if (owner && owner.id !== match.id) {
        plan.conflict.push({
          name: person.name,
          email: person.email,
          a: match.id,
          b: owner.id,
        });
        continue;
      }
      set.email = person.email;
    }
    if (
      person.birthdate !== "1900-01-01" &&
      (!match.birthdate || match.birthdate === "1900-01-01")
    )
      set.birthdate = person.birthdate;
    if (person.gender !== "other" && (!match.gender || match.gender === "other"))
      set.gender = person.gender;

    if (Object.keys(set).length > 0) {
      plan.enrich.push({
        id: match.id,
        name: match.name,
        set,
        from: { email: match.email, birthdate: match.birthdate, gender: match.gender },
      });
    } else {
      plan.reuse.push({ id: match.id, name: match.name });
    }
  } else if (person.email) {
    const key = `|${person.email}`;
    if (seenPE.has(key)) {
      plan.skip.push({ name: person.name, why: "dup (phone,email)" });
      continue;
    }
    seenPE.add(key);
    plan.create.push({
      name: person.name,
      phone: "", // never recorded
      email: person.email,
      gender: person.gender,
      birthdate: person.birthdate,
    });
  } else {
    // no email, no existing match → not salvageable per policy
    plan.skip.push({ name: person.name, why: "no email, no match" });
  }
}

// ── report ────────────────────────────────────────────────────────────
console.log(`\n── PLAN (phone always ""; email-only salvage) ──`);
console.log(`  existing participant rows: ${(existing ?? []).length}`);
console.log(`  reuse (no change):         ${plan.reuse.length}`);
console.log(`  enrich (+email/bd/gender): ${plan.enrich.length}`);
console.log(`  create (new, has email):   ${plan.create.length}`);
console.log(`  skip (no email / dup):     ${plan.skip.length}`);
console.log(`  conflict (manual review):  ${plan.conflict.length}`);

console.log(`\n  ── ENRICH (max 40) ──`);
for (const e of plan.enrich.slice(0, 40)) {
  console.log(
    `    ~ ${String(e.name).padEnd(14)} ${JSON.stringify(e.set)}  ` +
      `(was email="${e.from.email}")`,
  );
}
console.log(`\n  ── CREATE (max 40) ──`);
for (const c of plan.create.slice(0, 40)) {
  console.log(
    `    + ${String(c.name).padEnd(14)} ${c.email}  ${c.birthdate} ${c.gender}`,
  );
}
if (plan.conflict.length) {
  console.log(`\n  ── CONFLICT (same email, two rows) ──`);
  for (const c of plan.conflict)
    console.log(`    ! ${c.name} ${c.email}  rows ${c.a.slice(0, 8)} / ${c.b.slice(0, 8)}`);
}

if (!APPLY) {
  console.log(`\nDRY-RUN. Nothing written. Re-run with --apply to commit.`);
  process.exit(0);
}

// ── apply ─────────────────────────────────────────────────────────────
console.log(`\n--- APPLYING ---`);
let enriched = 0, created = 0, failed = 0;
for (const e of plan.enrich) {
  const { error } = await sb.from("participants").update(e.set).eq("id", e.id);
  if (error) {
    failed += 1;
    console.error(`  ✗ enrich ${e.id.slice(0, 8)} ${e.name}: ${error.message}`);
  } else {
    enriched += 1;
    console.log(`  ~ ${e.id.slice(0, 8)} ${e.name} ${JSON.stringify(e.set)}`);
  }
}
for (const c of plan.create) {
  const { data, error } = await sb
    .from("participants")
    .insert({
      name: c.name,
      phone: c.phone,
      email: c.email,
      gender: c.gender,
      birthdate: c.birthdate,
    })
    .select("id, name")
    .single();
  if (error) {
    const { data: again } = await sb
      .from("participants")
      .select("id")
      .eq("phone", c.phone)
      .eq("email", c.email)
      .maybeSingle();
    if (again) console.log(`  = ${again.id.slice(0, 8)} ${c.name} (existed)`);
    else {
      failed += 1;
      console.error(`  ✗ create ${c.name}: ${error.message}`);
    }
  } else {
    created += 1;
    console.log(`  + ${data.id.slice(0, 8)} ${data.name}`);
  }
}
console.log(`\nDone. enriched=${enriched}, created=${created}, failed=${failed}.`);
console.log(`Phone column left empty for every write (per policy).`);
