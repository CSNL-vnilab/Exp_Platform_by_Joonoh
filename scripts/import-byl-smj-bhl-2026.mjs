#!/usr/bin/env node
// Backfill BYL / SMJ / BHL 2026 calendar history into the lab-reservation
// platform: one new experiment row per (researcher, canonical project),
// plus a booking row per event, plus placeholder participant rows.
//
// Defaults applied where the calendar can't tell us:
//   * status='completed' (all events are in the past)
//   * session_type='single' (we don't have explicit Sbj numbers in titles)
//   * session_duration_minutes derived from event durations (mode)
//   * weekdays derived from observed event days
//   * daily_start_time / daily_end_time from earliest/latest observed
//   * max_participants_per_slot=1, participation_fee=0
//   * protocol_version=NULL — researcher must fill in
//   * description carries a "[백필] 정보 보완 필요" marker so the existing
//     metadata-reminders cron can prompt them.
//
// Participants: name-only rows, phone="" email="{name}@-" birthdate=1900-01-01,
// gender="other" — same convention as the JOP/TimeExp1 importer.
//
// Idempotent: a booking with the same google_event_id is skipped; an
// experiment whose owner+canonical project already exists is reused.
//
// Usage:
//   node scripts/import-byl-smj-bhl-2026.mjs            # dry-run
//   node scripts/import-byl-smj-bhl-2026.mjs --apply    # write

import { readFile } from "node:fs/promises";
import { google } from "googleapis";
import { createClient } from "@supabase/supabase-js";
import { parseTitle, parseDescription, canonProject } from "./lib/calendar-parse.mjs";

// ── env ───────────────────────────────────────────────────────────────
const env = await readFile(".env.local", "utf8");
for (const l of env.split("\n")) {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
}

const APPLY = process.argv.includes("--apply");
const TARGET_INITIALS = new Set(["BYL", "SMJ", "BHL"]);
const BACKFILL_TAG = "[백필]";
const DEFAULT_LAB_CODE = "CSNL";

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

// ── helpers ───────────────────────────────────────────────────────────

// Normalize a participant name extracted from a calendar event.
// Returns null if the value isn't a usable person name (e.g. it's an
// initial like "BYL" or pure whitespace after cleaning).
function normalizeParticipantName(raw) {
  if (!raw || typeof raw !== "string") return null;
  let s = raw.normalize("NFC");
  // strip zero-width chars + soft hyphen + BOM
  s = s.replace(/[​‌‍⁠­﻿]/g, "");
  // strip leading dots/punct
  s = s.replace(/^[.·•‧]+/, "");
  // drop "/ 학생 / ..." suffix and similar
  s = s.split("/")[0];
  s = s.trim();
  if (!s) return null;
  // 3-4 letter all-uppercase ASCII = researcher initial, NOT a participant.
  if (/^[A-Z]{2,5}$/.test(s)) return null;
  return s;
}

function pickMode(arr) {
  const counts = new Map();
  for (const v of arr) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}
function isoTimeKR(iso) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(iso)) + ":00";
}
function isoDateKR(iso) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(iso));
}

// ── 1. fetch calendar ─────────────────────────────────────────────────
async function listAllEvents() {
  const out = [];
  let pageToken;
  for (let p = 0; p < 50; p++) {
    const r = await cal.events.list({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      timeMin: "2026-01-01T00:00:00+09:00",
      timeMax: "2026-12-31T23:59:59+09:00",
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

console.log(APPLY ? "MODE: APPLY (will write)" : "MODE: DRY-RUN");
const events = await listAllEvents();
console.log(`Fetched ${events.length} calendar events.`);

// ── 2. lab + profiles ────────────────────────────────────────────────
const { data: lab } = await sb.from("labs").select("id, code").eq("code", DEFAULT_LAB_CODE).single();
if (!lab?.id) { console.error(`FATAL: no lab with code ${DEFAULT_LAB_CODE}`); process.exit(1); }
const LAB_ID = lab.id;

const { data: profiles } = await sb.from("profiles").select("id, email, display_name, contact_email, role");
const profileByInitial = new Map();
for (const p of profiles ?? []) {
  const local = (p.email ?? "").split("@")[0].toUpperCase();
  if (TARGET_INITIALS.has(local)) profileByInitial.set(local, p);
}
for (const init of TARGET_INITIALS) {
  if (!profileByInitial.has(init)) {
    console.error(`FATAL: no profile for ${init}`);
    process.exit(1);
  }
}

// ── 3. group events by (initial, canonical project) ─────────────────
// owner -> canon -> { displayName, events[] }
const byOwner = new Map();
for (const e of events) {
  const t = parseTitle(e.summary);
  if (!t) continue;
  const start = e.start?.dateTime;
  const end = e.end?.dateTime;
  if (!start || !end) continue;
  for (const init of t.initials) {
    if (!TARGET_INITIALS.has(init)) continue;
    if (!byOwner.has(init)) byOwner.set(init, new Map());
    const projects = byOwner.get(init);
    const canon = canonProject(t.project);
    if (!projects.has(canon)) projects.set(canon, { displayName: t.project, events: [] });
    projects.get(canon).events.push({
      id: e.id, summary: e.summary, start, end,
      parsed: t, desc: parseDescription(e.description),
    });
  }
}

// ── 4. existing experiments + bookings index ────────────────────────
const ownerIds = [...profileByInitial.values()].map((p) => p.id);
const { data: existingExps } = await sb
  .from("experiments")
  .select("id, title, project_name, created_by, start_date, end_date, status")
  .in("created_by", ownerIds);
// Lookup key: ${created_by}::${canonProject(project_name||title)}
const existingExpKey = new Map();
for (const e of existingExps ?? []) {
  const canon = canonProject(e.project_name ?? e.title);
  existingExpKey.set(`${e.created_by}::${canon}`, e);
}

const { data: existingBks } = await sb
  .from("bookings")
  .select("id, google_event_id, experiment_id")
  .not("google_event_id", "is", null);
const existingByEventId = new Set((existingBks ?? []).map((b) => b.google_event_id));

// ── 5. plan ────────────────────────────────────────────────────────
const plannedExperiments = []; // {init, profile, canon, displayName, events, action, existingId}
const plannedBookings = [];    // {expKey, event, person}
const plannedParticipants = new Set(); // names

for (const [init, projects] of byOwner) {
  const profile = profileByInitial.get(init);
  for (const [canon, info] of projects) {
    const evs = info.events;
    const minStart = evs.reduce((a, e) => (a < e.start ? a : e.start), evs[0].start);
    const maxStart = evs.reduce((a, e) => (a > e.start ? a : e.start), evs[0].start);
    const minEnd = evs.reduce((a, e) => (a < e.end ? a : e.end), evs[0].end);
    const maxEnd = evs.reduce((a, e) => (a > e.end ? a : e.end), evs[0].end);
    const durations = evs.map((e) => Math.round((new Date(e.end).getTime() - new Date(e.start).getTime()) / 60000));
    const sessionDur = pickMode(durations) ?? 60;
    const weekdays = [...new Set(evs.map((e) => new Date(e.start).getDay()))].sort();
    const startTimes = evs.map((e) => isoTimeKR(e.start));
    const endTimes = evs.map((e) => isoTimeKR(e.end));
    const dailyStart = startTimes.sort()[0];
    const dailyEnd = endTimes.sort()[endTimes.length - 1];

    const existing = existingExpKey.get(`${profile.id}::${canon}`);
    const expRecord = {
      init, profile, canon,
      displayName: info.displayName,
      events: evs,
      action: existing ? "reuse" : "create",
      existingId: existing?.id ?? null,
      payload: {
        title: info.displayName, // keep original calendar label (Korean OK)
        project_name: info.displayName,
        created_by: profile.id,
        lab_id: LAB_ID,
        status: "completed",
        experiment_mode: "offline",
        session_type: "single", // sbj numbers absent from titles
        session_duration_minutes: sessionDur,
        daily_start_time: dailyStart,
        daily_end_time: dailyEnd,
        weekdays,
        start_date: isoDateKR(minStart),
        end_date: isoDateKR(maxEnd),
        max_participants_per_slot: 1,
        participation_fee: 0,
        description: `${BACKFILL_TAG} ${info.displayName} - 캘린더 백필 (${evs.length}건). 보완 필요: protocol_version, location_id, participation_fee, precautions.`,
      },
    };
    plannedExperiments.push(expRecord);

    for (const ev of evs) {
      const rawName = ev.parsed.titleParticipant ?? ev.desc.name ?? null;
      const personName = normalizeParticipantName(rawName);
      const action = existingByEventId.has(ev.id) ? "skip-exists" : "insert";
      if (action === "insert" && personName) plannedParticipants.add(personName);
      plannedBookings.push({
        expKey: `${profile.id}::${canon}`,
        event: ev,
        rawName,
        personName,
        action,
      });
    }
  }
}

// ── 6. existing participants for the planned set ──────────────────
const partNames = [...plannedParticipants];
const existingPart = partNames.length
  ? (await sb.from("participants").select("id, name, phone, email").in("name", partNames)).data ?? []
  : [];
const partByName = new Map(existingPart.map((p) => [p.name, p]));
const newParticipants = partNames.filter((n) => !partByName.has(n));

// ── 7. report ─────────────────────────────────────────────────────
console.log(`\n── EXPERIMENTS (${plannedExperiments.length}) ──`);
for (const x of plannedExperiments) {
  const tag = x.action === "create" ? "+" : "=";
  console.log(`  ${tag} [${x.init}] ${x.displayName.padEnd(22)}  ${x.payload.start_date}~${x.payload.end_date}  ${x.events.length}건  weekdays=${x.payload.weekdays}  dur=${x.payload.session_duration_minutes}m  ${x.payload.daily_start_time}-${x.payload.daily_end_time}`);
}

console.log(`\n── BOOKINGS ──`);
const bookingCounts = { insert: 0, "skip-exists": 0, "no-participant": 0 };
for (const b of plannedBookings) {
  if (!b.personName) bookingCounts["no-participant"] += 1;
  else bookingCounts[b.action] = (bookingCounts[b.action] ?? 0) + 1;
}
for (const [k, v] of Object.entries(bookingCounts)) console.log(`  ${k}: ${v}`);
const noPartialEvents = plannedBookings.filter((b) => !b.personName).length;
if (noPartialEvents) {
  console.log(`  (${noPartialEvents} events have no recoverable participant name; will create a synthetic 'unknown' participant per experiment)`);
}

console.log(`\n── PARTICIPANTS ──`);
console.log(`  total unique names: ${partNames.length}`);
console.log(`  reuse (existing PII): ${partNames.length - newParticipants.length}`);
console.log(`  new placeholder rows: ${newParticipants.length}`);
if (newParticipants.length) console.log(`    names: ${newParticipants.join(", ")}`);

if (!APPLY) {
  console.log(`\nDry-run complete. Re-run with --apply.`);
  process.exit(0);
}

// ── 8. APPLY ───────────────────────────────────────────────────────
console.log(`\n--- APPLYING ---`);

// 8a. participants (name → id, idempotent: existing rows reused)
async function ensureParticipant(name) {
  if (partByName.has(name)) return partByName.get(name).id;
  const placeholder = {
    name, phone: "", email: `${name}@-`,
    birthdate: "1900-01-01", gender: "other",
  };
  // Race-safe upsert via select-then-insert. Ignore unique-violation if a
  // concurrent run wins the insert.
  const { data, error } = await sb.from("participants").insert(placeholder).select("id, name").single();
  if (error) {
    // Maybe already exists from the cohort import — try lookup again.
    const { data: again } = await sb.from("participants").select("id, name").eq("name", name).maybeSingle();
    if (again) {
      partByName.set(name, again);
      return again.id;
    }
    throw new Error(`participant insert failed for ${name}: ${error.message}`);
  }
  partByName.set(name, data);
  console.log(`  + participant ${data.name}  ${data.id.slice(0, 8)}`);
  return data.id;
}

// Synthetic 'unknown' participant per experiment, lazy-created
async function ensureUnknownForExp(initial, canon) {
  const name = `미상 (${initial}/${canon})`;
  return ensureParticipant(name);
}

// 8b. experiments (create or reuse)
const expIdByKey = new Map();
for (const x of plannedExperiments) {
  const key = `${x.profile.id}::${x.canon}`;
  if (x.action === "reuse") {
    expIdByKey.set(key, x.existingId);
    console.log(`  = exp ${x.existingId.slice(0, 8)}  [${x.init}] ${x.displayName}  (reused)`);
    continue;
  }
  const { data, error } = await sb.from("experiments").insert(x.payload).select("id, title").single();
  if (error) {
    console.error(`  ✗ exp insert failed for ${x.init}/${x.displayName}:`, error.message);
    process.exit(1);
  }
  expIdByKey.set(key, data.id);
  console.log(`  + exp ${data.id.slice(0, 8)}  [${x.init}] ${data.title}`);
}

// 8c. bookings
const groupByExpAndPerson = new Map();
let inserted = 0, skipped = 0;
for (const b of plannedBookings) {
  if (b.action === "skip-exists") { skipped += 1; continue; }
  const expId = expIdByKey.get(b.expKey);
  if (!expId) { console.error(`  ✗ no exp id for key ${b.expKey}`); process.exit(1); }
  const [initial, canon] = b.expKey.split("::").length === 2
    ? [plannedExperiments.find((x) => `${x.profile.id}::${x.canon}` === b.expKey)?.init,
       plannedExperiments.find((x) => `${x.profile.id}::${x.canon}` === b.expKey)?.canon]
    : [null, null];
  const personId = b.personName
    ? await ensureParticipant(b.personName)
    : await ensureUnknownForExp(initial, canon);
  const groupKey = `${expId}::${b.personName ?? "(unknown)"}`;
  let groupId = groupByExpAndPerson.get(groupKey);
  if (!groupId) { groupId = crypto.randomUUID(); groupByExpAndPerson.set(groupKey, groupId); }
  const row = {
    experiment_id: expId,
    participant_id: personId,
    slot_start: new Date(b.event.start).toISOString(),
    slot_end: new Date(b.event.end).toISOString(),
    status: "completed",
    google_event_id: b.event.id,
    subject_number: b.event.parsed.sbj ?? null,
    session_number: b.event.parsed.day ?? 1,
    booking_group_id: groupId,
  };
  const { error } = await sb.from("bookings").insert(row);
  if (error) {
    console.error(`  ✗ booking insert failed (event=${b.event.id}):`, error.message);
    process.exit(1);
  }
  inserted += 1;
}
console.log(`\nDone. exp creates=${plannedExperiments.filter(x=>x.action==="create").length}, bookings inserted=${inserted}, bookings skipped=${skipped}.`);
