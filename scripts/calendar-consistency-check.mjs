#!/usr/bin/env node
// Calendar ↔ Supabase ↔ Notion(Members/Projects/SLab) consistency check.
//
// Phase 1 of the backfill pipeline. Pure read, no writes. Produces
// .test-artifacts/calendar-consistency-report.json with:
//   * initials_map: observed initials → best-match Members page (or MISS)
//   * projects_map: observed projects → strict canonical match against
//                   Projects & Chores pages, else MISS. No FUZZY.
//   * supabase_project_match: observed projects → Supabase experiments row
//                   matched by canon(project_name) equality (not substring).
//   * participants_map: observed participant names → Supabase participants
//                   (matched by name + fuzzy)
//   * researcher_decisions[]: items the operator must resolve (unknown
//                   initials, unmatched projects, ambiguous names, etc.)
//
// Changes since 2026-04-23 strict review:
//   * Bracketless-prefix initials are only accepted if the token exists
//     in Notion Members DB. "GPU 회의" / "NEW EVENT" no longer mint
//     phantom initials. (C1)
//   * Project match is pure canonical equality. `Self-Pilot` ≠ `Pilot`
//     and does NOT silently fuzzy-collapse. (C2)
//   * `self pilot` / `SELF-PILOT` / `Self Pilot` all canon to the same
//     key and map to the single existing page. (C3)
//   * Dual-initial events keep ALL initials in `parsed_events[].initials`.
//     Downstream backfill writes all researcher relations. (C4)
//   * Supabase project match uses canon() equality, not substring. (H4)

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { google } from "googleapis";
import { createClient } from "@supabase/supabase-js";
import { parseTitle, parseDescription, canonProject } from "./lib/calendar-parse.mjs";

const envText = await readFile(".env.local", "utf8");
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
}

const MEMBERS_DB = "94854705-c91d-4a35-a91e-803c5934745e";
const PROJECTS_DB = "76e7c392-127e-47f3-8b7e-212610db9376";

// ── Google Calendar fetch ──
const auth = new google.auth.GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  },
});
const calendar = google.calendar({ version: "v3", auth });

async function listAllEvents() {
  const events = [];
  let pageToken;
  for (let p = 0; p < 50; p++) {
    const res = await calendar.events.list({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      timeMin: "2026-01-01T00:00:00+09:00",
      timeMax: "2026-12-31T23:59:59+09:00",
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 250,
      pageToken,
    });
    events.push(...(res.data.items ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
    if (!pageToken) break;
  }
  return events;
}

// ── Notion helpers ──
async function notion(path, body, method = "POST") {
  const r = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.NOTION_API_KEY}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`notion ${method} ${path} → ${r.status}: ${await r.text()}`);
  return r.json();
}

async function listAllDbRows(dbId) {
  const out = [];
  let start_cursor;
  for (let p = 0; p < 50; p++) {
    const res = await notion(`/databases/${dbId}/query`, {
      page_size: 100,
      start_cursor,
    });
    out.push(...(res.results ?? []));
    if (!res.has_more) break;
    start_cursor = res.next_cursor;
  }
  return out;
}

function titleOf(page) {
  const entry = Object.entries(page.properties).find(([, p]) => p.type === "title");
  if (!entry) return "(untitled)";
  return entry[1].title?.map((t) => t.plain_text).join("") || "(untitled)";
}

// ── Run ──
console.log("Fetching calendar events…");
const events = await listAllEvents();
console.log(`  ${events.length} events`);

console.log("Fetching Notion Members…");
const memberPages = await listAllDbRows(MEMBERS_DB);
const membersByInitial = new Map(); // "JOP" → page_id
for (const p of memberPages) {
  const t = titleOf(p);
  const key = t.toUpperCase().trim();
  if (key) membersByInitial.set(key, { id: p.id, raw_title: t });
}
console.log(`  ${memberPages.length} members`);

console.log("Fetching Notion Projects & Chores…");
const projectPages = await listAllDbRows(PROJECTS_DB);
// Keep original title indexing AND a canonical → page_id index for
// strict-equality matching (C2/C3 fix).
const projectsByTitle = new Map();
const projectsByCanon = new Map();
for (const p of projectPages) {
  const t = titleOf(p);
  projectsByTitle.set(t, { id: p.id, raw_title: t });
  const c = canonProject(t);
  if (c) {
    // If multiple Notion pages canon to the same key, flag as ambiguous so
    // backfill doesn't silently pick one. Researcher must dedupe manually.
    if (projectsByCanon.has(c)) {
      const existing = projectsByCanon.get(c);
      projectsByCanon.set(c, {
        status: "AMBIGUOUS",
        candidates: [
          ...(existing.status === "AMBIGUOUS"
            ? existing.candidates
            : [{ id: existing.id, title: existing.raw_title }]),
          { id: p.id, title: t },
        ],
      });
    } else {
      projectsByCanon.set(c, { id: p.id, raw_title: t });
    }
  }
}
console.log(`  ${projectPages.length} projects`);

console.log("Fetching Supabase experiments…");
const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);
const { data: expRows } = await supa
  .from("experiments")
  .select("id, title, project_name, notion_project_page_id");
console.log(`  ${expRows?.length ?? 0} experiments`);

const { data: partRows } = await supa
  .from("participants")
  .select("id, name, phone, email");
console.log(`  ${partRows?.length ?? 0} participants`);

const { data: profRows } = await supa
  .from("profiles")
  .select("id, email, display_name, notion_member_page_id");
console.log(`  ${profRows?.length ?? 0} profiles`);

// Pull bookings in 2026 window for H1 dedup check (see backfill-notion-
// bookings.mjs). We surface this so the booking backfill can cross-check
// google_event_id → notion_page_id without a second round-trip.
const { data: bookingRows } = await supa
  .from("bookings")
  .select("id, google_event_id, notion_page_id, slot_start, status")
  .gte("slot_start", "2026-01-01T00:00:00Z")
  .lte("slot_start", "2026-12-31T23:59:59Z");
console.log(`  ${bookingRows?.length ?? 0} bookings in 2026 window`);

// ── Aggregate calendar state ──
const initialsSet = new Set();
const projectsSet = new Set();
const participantsSet = new Set();
const parsed = [];
const unparsed = [];
for (const e of events) {
  const tp = parseTitle(e.summary);
  const dp = parseDescription(e.description);
  if (!tp) {
    unparsed.push({ id: e.id, summary: e.summary, start: e.start?.dateTime ?? e.start?.date });
    continue;
  }
  // C1 — bracketless initial whitelist. If the parser fell back to the
  // bracketless shape and the inferred token is not an actual Members-DB
  // entry, refuse to treat it as an initial. The event lands in
  // `unparsed` and gets surfaced to the researcher instead of minting a
  // phantom member.
  if (tp.bracketless && !membersByInitial.has(tp.initial)) {
    unparsed.push({
      id: e.id,
      summary: e.summary,
      start: e.start?.dateTime ?? e.start?.date,
      note: `bracketless-initial '${tp.initial}' not in Members DB — rejected as phantom`,
    });
    continue;
  }
  for (const init of tp.initials) initialsSet.add(init);
  projectsSet.add(tp.project);
  const pname = dp.name ?? tp.titleParticipant;
  if (pname) participantsSet.add(pname);
  parsed.push({
    event_id: e.id,
    summary: e.summary,
    start: e.start?.dateTime ?? e.start?.date,
    end: e.end?.dateTime ?? e.end?.date,
    initial: tp.initial, // first / primary (back-compat)
    initials: tp.initials, // all (for dual-initial relation writes)
    bracketless: tp.bracketless,
    project: tp.project,
    sbj: tp.sbj,
    day: tp.day,
    period: tp.period,
    participant_name: pname,
    participant_phone: dp.phone ?? null,
    participant_email: dp.email ?? null,
  });
}

// ── Cross-check each dimension ──
const initials_map = {};
for (const k of initialsSet) {
  const hit = membersByInitial.get(k);
  initials_map[k] = hit
    ? { status: "MATCH", page_id: hit.id, member_title: hit.raw_title }
    : { status: "MISS", candidates: [...membersByInitial.keys()] };
}

// C2/C3 — Strict canonical-equality match. No more FUZZY substring slop.
const projects_map = {};
for (const k of projectsSet) {
  const c = canonProject(k);
  if (!c) {
    projects_map[k] = { status: "MISS" };
    continue;
  }
  const hit = projectsByCanon.get(c);
  if (!hit) {
    projects_map[k] = { status: "MISS", canon: c };
  } else if (hit.status === "AMBIGUOUS") {
    projects_map[k] = {
      status: "AMBIGUOUS",
      canon: c,
      candidates: hit.candidates,
    };
  } else {
    projects_map[k] = {
      status: "MATCH",
      page_id: hit.id,
      canonical_title: hit.raw_title,
      canon: c,
    };
  }
}

// H4 — supabase_project_match via canon equality on project_name OR title.
// No substring matching; `'pilot'` never collides with `'Pilot with Interns'`.
const supabase_project_match = {};
for (const k of projectsSet) {
  const c = canonProject(k);
  const matches = (expRows ?? []).filter(
    (e) =>
      (e.project_name && canonProject(e.project_name) === c) ||
      (e.title && canonProject(e.title) === c),
  );
  supabase_project_match[k] =
    matches.length === 1
      ? { status: "MATCH", experiment_id: matches[0].id, title: matches[0].title }
      : matches.length === 0
        ? { status: "MISS" }
        : {
            status: "AMBIGUOUS",
            candidates: matches.map((e) => ({
              id: e.id,
              title: e.title,
              project_name: e.project_name,
            })),
          };
}

const participants_map = {};
for (const k of participantsSet) {
  const matches = (partRows ?? []).filter(
    (p) =>
      p.name === k ||
      p.name.toLowerCase() === k.toLowerCase() ||
      p.name.replace(/\s+/g, "") === k.replace(/\s+/g, ""),
  );
  participants_map[k] =
    matches.length === 1
      ? { status: "MATCH", id: matches[0].id }
      : matches.length === 0
        ? { status: "MISS" }
        : { status: "AMBIGUOUS", candidates: matches.map((p) => ({ id: p.id, name: p.name })) };
}

const profiles_linked = (profRows ?? []).filter((p) => p.notion_member_page_id);
const experiments_linked = (expRows ?? []).filter((e) => e.notion_project_page_id);

// H1 — map google_event_id → existing notion_page_id so the booking-
// backfill can skip events whose booking already has a Notion row.
const booking_by_event_id = {};
for (const b of bookingRows ?? []) {
  if (b.google_event_id) {
    booking_by_event_id[b.google_event_id] = {
      booking_id: b.id,
      notion_page_id: b.notion_page_id,
      status: b.status,
    };
  }
}

const researcher_decisions = [];
for (const [k, v] of Object.entries(initials_map)) {
  if (v.status !== "MATCH") {
    researcher_decisions.push({
      kind: "initial_no_member",
      subject: k,
      note: `Initial '${k}' appears in calendar but no matching Members row.`,
    });
  }
}
for (const [k, v] of Object.entries(projects_map)) {
  if (v.status === "MISS") {
    researcher_decisions.push({
      kind: "project_missing",
      subject: k,
      canon: v.canon,
      note: `Project '${k}' not in Projects & Chores — backfill will create a single canonical page.`,
    });
  } else if (v.status === "AMBIGUOUS") {
    researcher_decisions.push({
      kind: "project_ambiguous_in_notion",
      subject: k,
      candidates: v.candidates,
      note: `Multiple Notion pages share canonical form '${v.canon}'. Dedupe manually.`,
    });
  }
}
for (const [k, v] of Object.entries(participants_map)) {
  if (v.status === "AMBIGUOUS") {
    researcher_decisions.push({
      kind: "participant_ambiguous",
      subject: k,
      candidates: v.candidates,
      note: `Multiple Supabase participants match calendar name '${k}'.`,
    });
  }
}
for (const u of unparsed) {
  researcher_decisions.push({
    kind: "event_unparsed",
    subject: u.summary,
    start: u.start,
    note:
      u.note ??
      "Event title didn't match any known format; skipped from backfill unless corrected.",
  });
}

const report = {
  generated_at: new Date().toISOString(),
  window: { start: "2026-01-01", end: "2026-12-31", timezone: "Asia/Seoul" },
  counts: {
    events_total: events.length,
    events_parsed: parsed.length,
    events_unparsed: unparsed.length,
    initials: initialsSet.size,
    projects: projectsSet.size,
    participants: participantsSet.size,
    notion_members_known: membersByInitial.size,
    notion_projects_known: projectsByTitle.size,
    supabase_experiments: expRows?.length ?? 0,
    supabase_participants: partRows?.length ?? 0,
    supabase_bookings_in_window: bookingRows?.length ?? 0,
    profiles_already_linked: profiles_linked.length,
    experiments_already_linked: experiments_linked.length,
  },
  initials_map,
  projects_map,
  supabase_project_match,
  participants_map,
  booking_by_event_id,
  researcher_decisions_count: researcher_decisions.length,
  researcher_decisions,
  parsed_events: parsed,
  unparsed_events: unparsed,
};

await mkdir(".test-artifacts", { recursive: true });
await writeFile(
  ".test-artifacts/calendar-consistency-report.json",
  JSON.stringify(report, null, 2),
);

console.log(`\n── Summary ──`);
console.log(`  Events parsed: ${parsed.length}/${events.length}`);
console.log(
  `  Initials: ${initialsSet.size} (${Object.values(initials_map).filter((v) => v.status === "MATCH").length} linked)`,
);
console.log(`  Projects: ${projectsSet.size}`);
console.log(
  `    Notion matches: ${Object.values(projects_map).filter((v) => v.status === "MATCH").length}`,
);
console.log(
  `    Notion ambiguous: ${Object.values(projects_map).filter((v) => v.status === "AMBIGUOUS").length}`,
);
console.log(
  `    Notion miss: ${Object.values(projects_map).filter((v) => v.status === "MISS").length}`,
);
console.log(
  `    Supabase matches: ${Object.values(supabase_project_match).filter((v) => v.status === "MATCH").length}`,
);
console.log(`  Participants observed: ${participantsSet.size}`);
console.log(
  `    Supabase matches: ${Object.values(participants_map).filter((v) => v.status === "MATCH").length}`,
);
console.log(
  `  Supabase 2026-window bookings with google_event_id: ${Object.keys(booking_by_event_id).length}`,
);
console.log(`  Researcher decisions needed: ${researcher_decisions.length}`);
console.log(`\nReport: .test-artifacts/calendar-consistency-report.json`);
