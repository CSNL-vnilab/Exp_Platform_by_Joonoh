#!/usr/bin/env node
// One-shot importer that backfills the JOP/TimeExp1 cohort into the
// existing 시간 추정 실험 1 (TimeExp1) row.
//
// Scope (per user request 2026-04-27):
//   * Sbj5 김재성, Sbj6 임수, Sbj7 이보현, Sbj8 이효연, Sbj9 김서연 —
//     all of their JOP Exp1/TimeExp1 events go in as status='completed'.
//   * 김범진, 김수연 — early dropouts; their JOP Exp1/TimeExp1 events go
//     in as status='cancelled' for record-keeping.
//   * 이메일/전화는 없으면 없음 — placeholder PII for new participants
//     (existing rows like 이보현 are reused with their real PII).
//
// Idempotent: a booking already in DB with the same google_event_id is
// skipped. Re-running the script after a partial run is safe.
//
// Usage:
//   node scripts/import-jop-timeexp1-cohort.mjs                # dry-run
//   node scripts/import-jop-timeexp1-cohort.mjs --apply        # write

import { readFile } from "node:fs/promises";
import { google } from "googleapis";
import { createClient } from "@supabase/supabase-js";
import { parseTitle, parseDescription } from "./lib/calendar-parse.mjs";

// ── env ───────────────────────────────────────────────────────────────
const env = await readFile(".env.local", "utf8");
for (const l of env.split("\n")) {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
}

const APPLY = process.argv.includes("--apply");
const TARGET_PROJECT_NAME = "TimeExp1";

// Cohort definition. Order = Sbj number; null = dropout (cancelled).
const COHORT = [
  { name: "김재성", sbj: 5, status: "completed" },
  { name: "임수",   sbj: 6, status: "completed" },
  { name: "이보현", sbj: 7, status: "completed" },
  { name: "이효연", sbj: 8, status: "completed" },
  { name: "김서연", sbj: 9, status: "completed" },
  { name: "김범진", sbj: null, status: "cancelled" }, // early dropout
  { name: "김수연", sbj: null, status: "cancelled" }, // early dropout
];

const ALLOWED_PROJECTS = new Set(["Exp1", "TimeExp1"]);
const ALLOWED_INITIAL = "JOP";

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

// ── 1. fetch calendar events ──────────────────────────────────────────
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

console.log(APPLY ? "MODE: APPLY (will write)" : "MODE: DRY-RUN (no writes)");
const events = await listAllEvents();
console.log(`Fetched ${events.length} calendar events in 2026.`);

// ── 2. find target experiment ─────────────────────────────────────────
const { data: targetExp, error: expErr } = await sb
  .from("experiments")
  .select("id, title, project_name, start_date, end_date, created_by, status, session_type")
  .eq("project_name", TARGET_PROJECT_NAME)
  .maybeSingle();
if (expErr || !targetExp) {
  console.error("FATAL: TimeExp1 experiment not found:", expErr?.message);
  process.exit(1);
}
console.log(`Target experiment: [${targetExp.id.slice(0, 8)}] "${targetExp.title}" (project=${targetExp.project_name})`);

// ── 3. existing google_event_id index for idempotency ────────────────
const { data: existingBookings } = await sb
  .from("bookings")
  .select("id, google_event_id, slot_start, status, subject_number, session_number, participant_id, participants(name)")
  .eq("experiment_id", targetExp.id);
const existingByEventId = new Map();
for (const b of existingBookings ?? []) {
  if (b.google_event_id) existingByEventId.set(b.google_event_id, b);
}
console.log(`TimeExp1 currently has ${existingBookings?.length ?? 0} bookings (${existingByEventId.size} with google_event_id).`);

// ── 4. existing participants for this cohort ─────────────────────────
const cohortNames = COHORT.map((c) => c.name);
const { data: existingParticipants } = await sb
  .from("participants")
  .select("id, name, phone, email, birthdate, gender")
  .in("name", cohortNames);
const participantByName = new Map((existingParticipants ?? []).map((p) => [p.name, p]));

// ── 5. classify calendar events ──────────────────────────────────────
const planned = []; // { event, person, action: 'insert'|'skip-exists'|'skip-no-match' }
for (const e of events) {
  const t = parseTitle(e.summary);
  if (!t) continue;
  if (!t.initials.includes(ALLOWED_INITIAL)) continue;
  if (!ALLOWED_PROJECTS.has(t.project)) continue;

  // Match against cohort by name (in title participant slot OR raw summary).
  const desc = parseDescription(e.description);
  const summary = e.summary ?? "";
  let person = null;
  for (const c of COHORT) {
    if (
      summary.includes(c.name) ||
      (t.titleParticipant ?? "").includes(c.name) ||
      (desc.name ?? "").includes(c.name)
    ) {
      person = c;
      break;
    }
  }
  if (!person) continue;

  const startStr = e.start?.dateTime ?? null;
  const endStr = e.end?.dateTime ?? null;
  if (!startStr || !endStr) continue;

  const action = existingByEventId.has(e.id) ? "skip-exists" : "insert";
  planned.push({ event: e, person, action, t, desc, startStr, endStr });
}

console.log(`\nPlanned actions for ${planned.length} matched events:`);
const counts = { insert: 0, "skip-exists": 0 };
for (const p of planned) counts[p.action] = (counts[p.action] ?? 0) + 1;
for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v}`);

// ── 6. participants: figure out new vs existing ──────────────────────
const requiredCohort = new Set();
for (const p of planned) {
  if (p.action === "insert") requiredCohort.add(p.person.name);
}
const newParticipants = [];
for (const name of requiredCohort) {
  if (participantByName.has(name)) continue;
  // Placeholder PII per user policy: 이메일/전화 "없음".
  // Use a deterministic unique slug so re-runs reuse the same row instead
  // of inserting duplicates (UNIQUE on phone+email).
  const slug = `import-${TARGET_PROJECT_NAME.toLowerCase()}-${name}`;
  newParticipants.push({
    name,
    phone: `없음(${slug})`,
    email: `${slug}@no-email.local`,
    birthdate: "1900-01-01", // sentinel for "unknown"
    gender: "other",
  });
}
console.log(`\nNew participants to create: ${newParticipants.length}`);
for (const p of newParticipants) console.log(`  + ${p.name}  (${p.email})`);

console.log(`\nReusing existing participants (real PII): ${[...requiredCohort].filter((n) => participantByName.has(n)).length}`);
for (const name of requiredCohort) {
  const ex = participantByName.get(name);
  if (ex) console.log(`  = ${name}  ${ex.id.slice(0, 8)}  ${ex.email}`);
}

// ── 7. preview the booking inserts ───────────────────────────────────
console.log(`\nPlanned bookings (insert only):`);
for (const p of planned.filter((x) => x.action === "insert")) {
  console.log(
    `  ${p.startStr}  sbj=${String(p.person.sbj ?? "-").padStart(2)} day=${p.t.day ?? "-"}  ${p.person.status.padEnd(9)}  ${p.person.name}  | ${p.event.summary}`,
  );
}
const skipped = planned.filter((x) => x.action === "skip-exists");
if (skipped.length > 0) {
  console.log(`\nSkipped (google_event_id already in DB): ${skipped.length}`);
  for (const p of skipped) console.log(`  ${p.startStr}  ${p.person.name}  ev=${p.event.id}`);
}

// ── 8. apply ─────────────────────────────────────────────────────────
if (!APPLY) {
  console.log(`\nDry-run complete. Re-run with --apply to commit.`);
  process.exit(0);
}

console.log(`\n--- APPLYING ---`);

// 8a. extend experiment date window if needed.
// Several backfilled bookings predate the original 2026-04-23 start_date;
// widen the window to cover the earliest planned booking so the dashboard
// timeline stays consistent.
const earliestStart = planned
  .filter((p) => p.action === "insert")
  .reduce((acc, p) => (acc && acc < p.startStr ? acc : p.startStr), null);
const latestEnd = planned
  .filter((p) => p.action === "insert")
  .reduce((acc, p) => (acc && acc > p.endStr ? acc : p.endStr), null);
if (earliestStart || latestEnd) {
  const earliestDate = earliestStart?.slice(0, 10);
  const latestDate = latestEnd?.slice(0, 10);
  const newStart = earliestDate && earliestDate < targetExp.start_date ? earliestDate : targetExp.start_date;
  const newEnd = latestDate && latestDate > targetExp.end_date ? latestDate : targetExp.end_date;
  if (newStart !== targetExp.start_date || newEnd !== targetExp.end_date) {
    console.log(
      `  ~ extending experiment window: ${targetExp.start_date}→${newStart}, ${targetExp.end_date}→${newEnd}`,
    );
    const { error } = await sb
      .from("experiments")
      .update({ start_date: newStart, end_date: newEnd })
      .eq("id", targetExp.id);
    if (error) {
      console.error(`  ✗ experiment date update failed:`, error.message);
      process.exit(1);
    }
  }
}

// 8b. insert new participants
for (const p of newParticipants) {
  const { data, error } = await sb.from("participants").insert(p).select("id, name").single();
  if (error) {
    console.error(`  ✗ participant insert failed for ${p.name}:`, error.message);
    process.exit(1);
  }
  participantByName.set(data.name, { id: data.id, name: data.name });
  console.log(`  + participant ${data.name}  ${data.id.slice(0, 8)}`);
}

// 8c. insert bookings
const bookingGroupByPerson = new Map();
for (const p of planned.filter((x) => x.action === "insert")) {
  // One booking_group_id per (person, multi-session sequence). Reusing the
  // person's group means the multi-day sessions are linked the same way the
  // book_slot RPC links them at runtime.
  let groupId = bookingGroupByPerson.get(p.person.name);
  if (!groupId) {
    groupId = crypto.randomUUID();
    bookingGroupByPerson.set(p.person.name, groupId);
  }
  const participant = participantByName.get(p.person.name);
  if (!participant) {
    console.error(`  ✗ no participant id for ${p.person.name}`);
    process.exit(1);
  }
  const row = {
    experiment_id: targetExp.id,
    participant_id: participant.id,
    slot_start: new Date(p.startStr).toISOString(),
    slot_end: new Date(p.endStr).toISOString(),
    status: p.person.status,
    google_event_id: p.event.id,
    subject_number: p.person.sbj,
    session_number: p.t.day ?? 1,
    booking_group_id: groupId,
  };
  const { data, error } = await sb.from("bookings").insert(row).select("id").single();
  if (error) {
    console.error(`  ✗ booking insert failed for ${p.person.name} day=${p.t.day}:`, error.message);
    process.exit(1);
  }
  console.log(`  + booking ${data.id.slice(0, 8)}  ${p.person.name} sbj=${p.person.sbj} day=${p.t.day} ${p.person.status}`);
}

console.log(`\nDone. Inserted ${counts.insert} bookings, ${newParticipants.length} new participants.`);
