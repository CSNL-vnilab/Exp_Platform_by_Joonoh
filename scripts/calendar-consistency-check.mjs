#!/usr/bin/env node
// Calendar ↔ Supabase ↔ Notion(Members/Projects/SLab) consistency check.
//
// Phase 1 of the backfill pipeline. Pure read, no writes. Produces
// .test-artifacts/calendar-consistency-report.json with:
//   * initials_map: observed initials → best-match Members page (or MISS)
//   * projects_map: observed projects → best-match Projects & Chores
//                   page (or MISS — needs creation)
//   * supabase_project_match: observed projects → Supabase experiments row
//                   (matched by project_name/title)
//   * participants_map: observed participant names → Supabase participants
//                   (matched by name + fuzzy)
//   * researcher_decisions[]: list of items the operator must resolve
//                   (dual initials, bracket-less events, name duplicates)
//
// After running this, scripts/backfill-* scripts consume the report to do
// the actual writes.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { google } from "googleapis";
import { createClient } from "@supabase/supabase-js";

const envText = await readFile(".env.local", "utf8");
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
}

const MEMBERS_DB = "94854705-c91d-4a35-a91e-803c5934745e";
const PROJECTS_DB = "76e7c392-127e-47f3-8b7e-212610db9376";

// ── Calendar parse (copy of calendar-parse-2026.mjs parsing logic) ──
// Bracketed initials, accepts single `[BYL]` or dual `[BYL SYJ]`.
// Dual-initial events are credited to the FIRST initial; the rest go
// into decision notes for the researcher.
const INITIAL_RE = /^\s*\[(?<initial>[A-Za-z]{2,6})(?:\s+[A-Za-z]{2,6})*\]\s*/;
// Bracket-less prefix: "BYL self pilot" / "JOP Pilot" / "JOP: Pilot".
// Only trigger when the leading 3-4 letter ALL-CAPS token is immediately
// followed by whitespace/colon and more text.
const BRACKETLESS_INITIAL_RE = /^(?<initial>[A-Z]{2,4})\s*[:\s]\s*(?<rest>.+)$/;
const SBJ_RE = /(?:Sbj|SBJ|sbj)\s*(\d+)/;
const DAY_RE = /(?:Day|DAY|day)\s*(\d+)/;
const PERIOD_RE = /기간\s*(\d+)/;
const PAREN_RE = /\(([^()]+)\)/;

function parseTitle(summary) {
  if (!summary) return null;
  const trimmed = summary.trim();
  // Try bracketed first (authoritative), then bracket-less fallback for
  // legacy entries that started with an initial prefix without brackets.
  let initial = null;
  let rest = "";
  const im = trimmed.match(INITIAL_RE);
  if (im) {
    initial = im.groups.initial.toUpperCase();
    rest = trimmed.slice(im[0].length).trim();
  } else {
    const bm = trimmed.match(BRACKETLESS_INITIAL_RE);
    if (bm) {
      initial = bm.groups.initial.toUpperCase();
      rest = bm.groups.rest.trim();
    }
  }
  if (!initial) return null;
  let titleParticipant = null;
  const pm = rest.match(PAREN_RE);
  if (pm) {
    titleParticipant = pm[1].trim();
    rest = (rest.slice(0, pm.index) + rest.slice(pm.index + pm[0].length))
      .replace(/\s+/g, " ")
      .trim();
  }
  let sbj = null, day = null, period = null;
  const sm = rest.match(SBJ_RE);
  if (sm) { sbj = Number.parseInt(sm[1], 10); rest = rest.replace(SBJ_RE, "").trim(); }
  const dm = rest.match(DAY_RE);
  if (dm) { day = Number.parseInt(dm[1], 10); rest = rest.replace(DAY_RE, "").trim(); }
  const perm = rest.match(PERIOD_RE);
  if (perm) { period = Number.parseInt(perm[1], 10); rest = rest.replace(PERIOD_RE, "").trim(); }
  if (!titleParticipant) {
    const segments = rest.split(/\s*\/\s*/);
    const last = segments[segments.length - 1]?.trim() ?? "";
    if (/^[가-힣]{2,4}$/.test(last)) {
      titleParticipant = last;
      segments.pop();
      rest = segments.join(" / ").trim();
    }
  }
  let project = rest.replace(/\s*\/\s*/g, " / ").replace(/\s+/g, " ").trim();
  while (project.endsWith("/") || project.endsWith("-")) {
    project = project.replace(/[-/\s]+$/, "").trim();
  }
  if (!project) return null;
  return { initial, project, sbj, day, period, titleParticipant };
}

function parseDescription(desc) {
  if (!desc) return {};
  const out = {};
  for (const line of desc.split(/\r?\n/)) {
    const m = line.trim().match(/^(예약자|이메일|전화번호|회차)\s*[:：]\s*(.+)$/);
    if (!m) continue;
    out[
      m[1] === "예약자" ? "name"
      : m[1] === "이메일" ? "email"
      : m[1] === "전화번호" ? "phone"
      : "session"
    ] = m[2].trim();
  }
  return out;
}

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
  // Members DB title is initials (JHR, JSL, etc.). Case-insensitive compare.
  const key = t.toUpperCase().trim();
  if (key) membersByInitial.set(key, { id: p.id, raw_title: t });
}
console.log(`  ${memberPages.length} members`);

console.log("Fetching Notion Projects & Chores…");
const projectPages = await listAllDbRows(PROJECTS_DB);
const projectsByTitle = new Map();
for (const p of projectPages) {
  const t = titleOf(p);
  projectsByTitle.set(t, { id: p.id, raw_title: t });
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
  initialsSet.add(tp.initial);
  projectsSet.add(tp.project);
  const pname = dp.name ?? tp.titleParticipant;
  if (pname) participantsSet.add(pname);
  parsed.push({
    event_id: e.id,
    summary: e.summary,
    start: e.start?.dateTime ?? e.start?.date,
    end: e.end?.dateTime ?? e.end?.date,
    initial: tp.initial,
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

const projects_map = {};
for (const k of projectsSet) {
  // Exact match first, then substring.
  const exact = projectsByTitle.get(k);
  if (exact) {
    projects_map[k] = { status: "MATCH", page_id: exact.id };
    continue;
  }
  const lk = k.toLowerCase();
  const candidates = [...projectsByTitle.entries()]
    .filter(([title]) =>
      title.toLowerCase().includes(lk) || lk.includes(title.toLowerCase()),
    )
    .map(([title, v]) => ({ page_id: v.id, title }));
  projects_map[k] =
    candidates.length === 1
      ? { status: "FUZZY", page_id: candidates[0].page_id, match_title: candidates[0].title }
      : candidates.length === 0
        ? { status: "MISS" }
        : { status: "AMBIGUOUS", candidates };
}

const supabase_project_match = {};
for (const k of projectsSet) {
  const matches = (expRows ?? []).filter(
    (e) =>
      e.project_name?.toLowerCase() === k.toLowerCase() ||
      e.title?.toLowerCase() === k.toLowerCase() ||
      (e.project_name && k.toLowerCase().includes(e.project_name.toLowerCase())),
  );
  supabase_project_match[k] =
    matches.length === 1
      ? { status: "MATCH", experiment_id: matches[0].id, title: matches[0].title }
      : matches.length === 0
        ? { status: "MISS" }
        : {
            status: "AMBIGUOUS",
            candidates: matches.map((e) => ({ id: e.id, title: e.title, project_name: e.project_name })),
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

// Profile → initial mapping (by display_name first char of syllables? or by
// email prefix). We also collect profiles that HAVE notion_member_page_id
// so we know what's already linked.
const profiles_linked = (profRows ?? []).filter((p) => p.notion_member_page_id);
const experiments_linked = (expRows ?? []).filter((e) => e.notion_project_page_id);

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
      note: `Project '${k}' not in Projects & Chores — we'll create a page unless you say otherwise.`,
    });
  } else if (v.status === "AMBIGUOUS") {
    researcher_decisions.push({
      kind: "project_ambiguous",
      subject: k,
      candidates: v.candidates,
      note: `Multiple Projects & Chores pages match '${k}'. Pick one.`,
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
    note: "Event title didn't match any known format; skipped from backfill unless corrected.",
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
    profiles_already_linked: profiles_linked.length,
    experiments_already_linked: experiments_linked.length,
  },
  initials_map,
  projects_map,
  supabase_project_match,
  participants_map,
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
console.log(`  Initials: ${initialsSet.size} (${Object.values(initials_map).filter((v) => v.status === "MATCH").length} linked)`);
console.log(`  Projects: ${projectsSet.size}`);
console.log(`    Notion matches: ${Object.values(projects_map).filter((v) => v.status === "MATCH").length}`);
console.log(`    Notion fuzzy: ${Object.values(projects_map).filter((v) => v.status === "FUZZY").length}`);
console.log(`    Notion miss: ${Object.values(projects_map).filter((v) => v.status === "MISS").length}`);
console.log(`    Supabase matches: ${Object.values(supabase_project_match).filter((v) => v.status === "MATCH").length}`);
console.log(`  Participants observed: ${participantsSet.size}`);
console.log(`    Supabase matches: ${Object.values(participants_map).filter((v) => v.status === "MATCH").length}`);
console.log(`  Researcher decisions needed: ${researcher_decisions.length}`);
console.log(`\nReport: .test-artifacts/calendar-consistency-report.json`);
