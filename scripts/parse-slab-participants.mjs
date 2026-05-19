#!/usr/bin/env node
// Backfill participant identities (name + 연락처) from the SLab Google
// Calendar, 2024-03-01 → now.
//
// Goal (user request 2026-05-19): mine every Slab event description /
// title for 예약자(name) · 전화번호(phone) · 이메일(email), collapse
// the same person across many events into ONE participant id, and
// record/enrich them in Supabase `participants`.
//
// User rules (2026-05-19 follow-up):
//   * Color-labeled events (Google colorId set) are NEVER added —
//     they are skipped entirely before any extraction.
//   * The "time2dist" experiment === calendar project label
//     `timeexp1`. The calendar has no contact info for it, so its
//     participants are NOT auto-created; instead the script prints the
//     name list for the user to supply email/phone manually.
//   * Every other project → backfill from past data (this script).
//
// Dedup model — matches the schema's identity contract:
//   * participants has UNIQUE(phone, email) (migration 00002).
//   * A person is fingerprinted across calendar events by, in order:
//       1. normalized phone (digits only, 9-11 digits) → strongest
//       2. lowercased real email                        → next
//       3. NFC-normalized lowercased name               → fallback
//   * Against EXISTING rows we match by the same precedence so a
//     re-run is idempotent and the prior name-only SLab backfill
//     (phone="", email="{name}@-") gets ENRICHED with any real phone /
//     email recovered, instead of spawning a duplicate.
//
// Scope: participants ONLY. Bookings/experiments are owned by the
// dedicated import-*/backfill-* scripts and left untouched here.
//
// Safety: DRY-RUN by default — pure read of Calendar + Supabase, zero
// writes. `--apply` writes ONLY the non-timeexp1 plan. timeexp1 is
// always report-only here.
//
// Usage:
//   node scripts/parse-slab-participants.mjs            # dry-run report
//   node scripts/parse-slab-participants.mjs --apply    # write non-timeexp1
//   node scripts/parse-slab-participants.mjs --from 2024-03 --apply

import { readFile } from "node:fs/promises";
import { google } from "googleapis";
import { createClient } from "@supabase/supabase-js";
import {
  parseTitle,
  parseDescription,
  canonProject,
} from "./lib/calendar-parse.mjs";

// ── env ───────────────────────────────────────────────────────────────
const env = await readFile(".env.local", "utf8");
for (const l of env.split("\n")) {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
}

const APPLY = process.argv.includes("--apply");
const fromArgIdx = process.argv.indexOf("--from");
const FROM_MONTH = fromArgIdx !== -1 ? process.argv[fromArgIdx + 1] : "2024-03";
const START = `${FROM_MONTH}-01T00:00:00+09:00`;
const END = new Date().toISOString();

// "time2dist" experiment === this calendar project label. Its
// participants are held back for manual contact entry by the user.
const HOLD_PROJECT = "timeexp1";

const CAL_ID = process.env.GOOGLE_CALENDAR_ID;
if (!CAL_ID) {
  console.error("FATAL: GOOGLE_CALENDAR_ID (SLab calendar) not set");
  process.exit(1);
}

// ── clients ───────────────────────────────────────────────────────────
const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);
const auth = new google.auth.GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  },
});
const cal = google.calendar({ version: "v3", auth });

// ── normalization ─────────────────────────────────────────────────────
function normPhone(raw) {
  if (!raw) return "";
  let s = String(raw).replace(/\D/g, "");
  if (s.startsWith("82") && s.length >= 11) s = "0" + s.slice(2);
  return s.length >= 9 && s.length <= 11 ? s : "";
}
function isPlaceholderEmail(s) {
  if (!s) return true;
  const v = s.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) {
    return !/^[^@\s]+@[^@\s]+$/.test(v) || /@-$/.test(v);
  }
  return /@no-email\.local$|@imported\.invalid$|@example\.(com|test|org|net)$|@(.*\.)?test$|@-$/.test(
    v,
  );
}
function normEmail(raw) {
  if (!raw) return "";
  const v = String(raw).trim().toLowerCase();
  return isPlaceholderEmail(v) ? "" : v;
}
function normName(raw) {
  if (!raw || typeof raw !== "string") return null;
  let s = raw.normalize("NFC").replace(/[​‌‍⁠­﻿]/g, "");
  s = s.replace(/^[.·•‧]+/, "").split("/")[0].trim();
  if (!s) return null;
  if (/^[A-Za-z]{2,5}$/.test(s)) return null; // initial, not a person
  if (/^(미상|unknown|test|테스트)$/i.test(s)) return null;
  if (/[[\]{}]/.test(s)) return null;
  if (/(^|[\s_-])(test|e2e|conflict|exclude|dummy|sample|fixture)([\s_-]|\d|$)/i.test(s))
    return null;
  return s;
}

// ── fetch calendar ────────────────────────────────────────────────────
async function listAllEvents() {
  const out = [];
  let pageToken;
  for (let p = 0; p < 200; p++) {
    const r = await cal.events.list({
      calendarId: CAL_ID,
      timeMin: START,
      timeMax: END,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 250,
      pageToken,
    });
    out.push(...(r.data.items ?? []));
    pageToken = r.data.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

console.log(APPLY ? "MODE: APPLY (writes non-timeexp1 only)" : "MODE: DRY-RUN (no writes)");
console.log(`Calendar: ${CAL_ID}`);
console.log(`Window:   ${START} .. ${END}`);
console.log(`Hold project (manual contact): "${HOLD_PROJECT}"`);
const events = await listAllEvents();
console.log(`Fetched ${events.length} events.\n`);

// ── extract people from events ────────────────────────────────────────
// fingerprint -> { name, phone, email, events, projects:Set, colored:bool }
const persons = new Map();
let coloredSkipped = 0;
let withName = 0, withPhone = 0, withEmail = 0, noIdentity = 0, unparsed = 0;

function fingerprint(phone, email, name) {
  if (phone) return `p:${phone}`;
  if (email) return `e:${email}`;
  if (name) return `n:${name.normalize("NFC").toLowerCase()}`;
  return null;
}

for (const e of events) {
  // Rule: color-labeled events are never added.
  if (e.colorId) {
    coloredSkipped += 1;
    continue;
  }
  const t = parseTitle(e.summary);
  const d = parseDescription(e.description);
  const rawName = d.name ?? t?.titleParticipant ?? null;
  const name = normName(rawName);
  const phone = normPhone(d.phone);
  const email = normEmail(d.email);
  const proj = t ? canonProject(t.project) : null;
  if (!t && !d.name) unparsed += 1;
  if (name) withName += 1;
  if (phone) withPhone += 1;
  if (email) withEmail += 1;

  const fp = fingerprint(phone, email, name);
  if (!fp) {
    noIdentity += 1;
    continue;
  }
  const cur = persons.get(fp) ?? {
    name: null,
    phone: "",
    email: "",
    events: 0,
    projects: new Set(),
  };
  cur.events += 1;
  if (proj) cur.projects.add(proj);
  if (name && (!cur.name || name.length > cur.name.length)) cur.name = name;
  if (phone && !cur.phone) cur.phone = phone;
  if (email && !cur.email) cur.email = email;
  persons.set(fp, cur);
}

console.log("── EXTRACTION (color-labeled events excluded) ──");
console.log(`  color-labeled events skipped: ${coloredSkipped}`);
console.log(`  events kept & parsed:         ${events.length - coloredSkipped - unparsed}`);
console.log(`  events w/ name:               ${withName}`);
console.log(`  events w/ phone:              ${withPhone}`);
console.log(`  events w/ email:              ${withEmail}`);
console.log(`  events w/ no identifiable id: ${noIdentity}`);
console.log(`  unique persons (deduped):     ${persons.size}\n`);

// ── load existing participants ────────────────────────────────────────
const { data: existing } = await sb
  .from("participants")
  .select("id, name, phone, email");
const byPhone = new Map();
const byEmail = new Map();
const byName = new Map();
for (const p of existing ?? []) {
  const ph = normPhone(p.phone);
  const em = normEmail(p.email);
  const nm = (p.name ?? "").normalize("NFC").toLowerCase().trim();
  if (ph && !byPhone.has(ph)) byPhone.set(ph, p);
  if (em && !byEmail.has(em)) byEmail.set(em, p);
  if (nm && !byName.has(nm)) byName.set(nm, p);
}
function matchExisting(ph, em, nm) {
  return (
    (ph && byPhone.get(ph)) ||
    (em && byEmail.get(em)) ||
    (nm && byName.get(nm)) ||
    null
  );
}

// ── split: timeexp1 (hold) vs others (backfill) ──────────────────────
const holdList = []; // timeexp1 persons needing manual contact
const plan = { reuse: [], enrich: [], create: [] };

for (const [, person] of persons) {
  const ph = person.phone;
  const em = person.email;
  const nm = person.name ? person.name.normalize("NFC").toLowerCase() : "";
  const match = matchExisting(ph, em, nm);
  const isHold = person.projects.has(HOLD_PROJECT);

  if (isHold) {
    // Does the matched DB row already have a deliverable contact?
    const exHasEmail = match && !!normEmail(match.email);
    const exHasPhone = match && !!normPhone(match.phone);
    holdList.push({
      name: person.name ?? "(미상)",
      events: person.events,
      otherProjects: [...person.projects].filter((p) => p !== HOLD_PROJECT),
      existingId: match?.id ?? null,
      hasContact: !!(exHasEmail || exHasPhone),
      knownPhone: ph || (match ? match.phone : "") || "",
      knownEmail: em || (match ? match.email : "") || "",
    });
    continue; // never auto-create / enrich timeexp1 here
  }

  if (match) {
    const wantPhone = ph && !normPhone(match.phone);
    const wantEmail = em && !normEmail(match.email);
    if (wantPhone || wantEmail) {
      plan.enrich.push({
        id: match.id,
        name: match.name,
        set: {
          ...(wantPhone ? { phone: ph } : {}),
          ...(wantEmail ? { email: em } : {}),
        },
        from: { phone: match.phone, email: match.email },
      });
    } else {
      plan.reuse.push({ id: match.id, name: match.name });
    }
  } else {
    plan.create.push({
      name: person.name ?? "(미상)",
      phone: ph || "",
      email: em || `${person.name ?? "unknown"}@-`,
      gender: "other",
      birthdate: "1900-01-01",
      events: person.events,
    });
  }
}

// UNIQUE(phone,email) guard on RAW write values (the "{name}@-"
// convention keeps name-only people distinct — do NOT normalize here).
const seenPE = new Set(
  (existing ?? []).map((p) => `${p.phone ?? ""}|${p.email ?? ""}`),
);
const creates = [];
let collapsed = 0;
for (const c of plan.create) {
  const key = `${c.phone}|${c.email}`;
  if (seenPE.has(key)) {
    collapsed += 1;
    continue;
  }
  seenPE.add(key);
  creates.push(c);
}
plan.create = creates;

// ── report ────────────────────────────────────────────────────────────
console.log(`── HOLD: "${HOLD_PROJECT}" (time2dist) — 연락처 사용자 입력 대상 ──`);
const holdNeed = holdList.filter((h) => !h.hasContact);
const holdHave = holdList.filter((h) => h.hasContact);
console.log(`  timeexp1 unique persons:     ${holdList.length}`);
console.log(`  already have DB contact:     ${holdHave.length}`);
console.log(`  NEED contact from user:      ${holdNeed.length}`);
console.log(`  (these are NOT auto-created)\n`);
console.log(`  ── 연락처 필요 명단 (이름 · 이벤트수 · 기존ID) ──`);
for (const h of holdNeed.sort((a, b) => b.events - a.events)) {
  console.log(
    `    ${String(h.name).padEnd(16)} ${String(h.events).padStart(2)}건  ` +
      `${h.existingId ? "기존 " + h.existingId.slice(0, 8) : "신규"}`,
  );
}

console.log(`\n── BACKFILL (non-timeexp1, non-colored) ──`);
console.log(`  existing rows:        ${(existing ?? []).length}`);
console.log(`  reuse (no change):    ${plan.reuse.length}`);
console.log(`  enrich (+phone/email):${plan.enrich.length}`);
console.log(`  create (new person):  ${plan.create.length}`);
if (collapsed) console.log(`  collapsed dup (phone,email): ${collapsed}`);
console.log(`\n  ── ENRICH sample (max 15) ──`);
for (const e of plan.enrich.slice(0, 15)) {
  const add = Object.entries(e.set).map(([k, v]) => `${k}=${v}`).join(" ");
  console.log(`    ~ ${String(e.name ?? "-").padEnd(14)} ${add}`);
}
console.log(`  ── CREATE sample (max 20) ──`);
for (const c of plan.create.slice(0, 20)) {
  console.log(`    + ${String(c.name ?? "-").padEnd(14)} (${c.events} ev)`);
}

if (!APPLY) {
  console.log(`\nDry-run complete. Nothing written. Re-run with --apply.`);
  process.exit(0);
}

// ── APPLY (non-timeexp1 only) ─────────────────────────────────────────
console.log(`\n--- APPLYING non-timeexp1 backfill ---`);
let enriched = 0, created = 0, failed = 0;

for (const e of plan.enrich) {
  const { error } = await sb.from("participants").update(e.set).eq("id", e.id);
  if (error) {
    failed += 1;
    console.error(`  ✗ enrich ${e.id.slice(0, 8)} (${e.name}): ${error.message}`);
  } else {
    enriched += 1;
    console.log(`  ~ ${e.id.slice(0, 8)} ${e.name}  ${JSON.stringify(e.set)}`);
  }
}
for (const c of plan.create) {
  const row = {
    name: c.name,
    phone: c.phone,
    email: c.email,
    gender: c.gender,
    birthdate: c.birthdate,
  };
  const { data, error } = await sb
    .from("participants")
    .insert(row)
    .select("id, name")
    .single();
  if (error) {
    const { data: again } = await sb
      .from("participants")
      .select("id")
      .eq("phone", c.phone)
      .eq("email", c.email)
      .maybeSingle();
    if (again) {
      console.log(`  = ${again.id.slice(0, 8)} ${c.name} (already existed)`);
    } else {
      failed += 1;
      console.error(`  ✗ create ${c.name}: ${error.message}`);
    }
  } else {
    created += 1;
    console.log(`  + ${data.id.slice(0, 8)} ${data.name}`);
  }
}

console.log(`\nDone. enriched=${enriched}, created=${created}, failed=${failed}.`);
console.log(
  `timeexp1 (time2dist) was NOT written — ${holdNeed.length} people await ` +
    `user-supplied email/phone. public_code is backfilled lazily by the ` +
    `booking pipeline / identity service.`,
);
