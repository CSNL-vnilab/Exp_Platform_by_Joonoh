#!/usr/bin/env node
// Read-only parser for 2026 events on the SLab Google Calendar.
//
// Fetches every event that starts in 2026-01-01 ~ 2026-12-31 KST, parses
// titles (`[INITIAL] PROJECT/Sbj N/Day D`) + descriptions (예약자/이메일/
// 전화번호/회차), then prints aggregate stats:
//   * unique (initial, count) pairs
//   * unique (project_name, count) pairs
//   * unique (participant_name, count) pairs — for dedup sanity
//   * events that failed to parse (for manual review)
//   * min/max dates observed
//
// Pure read — doesn't touch Supabase, Notion, or anything else.
// Intended as the first step before we decide what to backfill.

import { readFile } from "node:fs/promises";
import { google } from "googleapis";

const envText = await readFile(".env.local", "utf8");
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
}

const CAL_ID = process.env.GOOGLE_CALENDAR_ID;
if (!CAL_ID) {
  console.error("Missing GOOGLE_CALENDAR_ID");
  process.exit(1);
}

const auth = new google.auth.GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(
      /\\n/g,
      "\n",
    ),
  },
});
const calendar = google.calendar({ version: "v3", auth });

// Year window (KST). Google Calendar API expects RFC3339 timestamps.
const START = "2026-01-01T00:00:00+09:00";
const END = "2026-12-31T23:59:59+09:00";

async function listAllEvents() {
  const events = [];
  let pageToken = undefined;
  for (let page = 0; page < 50; page++) {
    const res = await calendar.events.list({
      calendarId: CAL_ID,
      timeMin: START,
      timeMax: END,
      singleEvents: true, // expand recurring
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

// Calendar titles on the SLab calendar use four observed shapes. We parse
// to a common structured record: {initial, project, sbj?, day?, period?,
// titleParticipant?}.
//
// Shape A — Platform-generated: `[INIT] PROJECT/Sbj N/Day D`
// Shape B — Legacy w/ participant: `[INIT] project_name (participant)`
// Shape C — Multi-segment Korean: `[INIT] Exp1 / Day N / 기간 M / 이름`
// Shape D — Mixed Sbj: `[INIT] Exp1 Sbj9 (김서연) Day1`
//
// Approach: strip the `[INIT]` prefix, then extract Sbj / Day / 기간 /
// participant from anywhere in the remaining string. Whatever's left is
// the project.

const INITIAL_RE = /^\s*\[([A-Za-z]{2,6})\]\s*/;
const SBJ_RE = /(?:Sbj|SBJ|sbj)\s*(\d+)/;
const DAY_RE = /(?:Day|DAY|day)\s*(\d+)/;
const PERIOD_RE = /기간\s*(\d+)/;
// Korean-name heuristic: 2-4 CJK characters in a row, optionally allowed
// to have trailing spaces or at end of string. Loose — gets false
// positives we'll filter below.
const KOREAN_NAME_RE = /([가-힣]{2,4})/;
const PAREN_RE = /\(([^()]+)\)/;

function parseTitle(summary) {
  if (!summary) return null;
  const s0 = summary.trim();
  const im = s0.match(INITIAL_RE);
  if (!im) return null;
  const initial = im[1].toUpperCase();
  let rest = s0.slice(im[0].length).trim();

  // 1. Parenthesised name (if any) → participant.
  let titleParticipant = null;
  const pm = rest.match(PAREN_RE);
  if (pm) {
    titleParticipant = pm[1].trim();
    rest = (rest.slice(0, pm.index) + rest.slice(pm.index + pm[0].length))
      .replace(/\s+/g, " ")
      .trim();
  }

  // 2. Sbj / Day / 기간 numeric tags.
  let sbj = null, day = null, period = null;
  const sm = rest.match(SBJ_RE);
  if (sm) {
    sbj = Number.parseInt(sm[1], 10);
    rest = rest.replace(SBJ_RE, "").trim();
  }
  const dm = rest.match(DAY_RE);
  if (dm) {
    day = Number.parseInt(dm[1], 10);
    rest = rest.replace(DAY_RE, "").trim();
  }
  const permatch = rest.match(PERIOD_RE);
  if (permatch) {
    period = Number.parseInt(permatch[1], 10);
    rest = rest.replace(PERIOD_RE, "").trim();
  }

  // 3. Trailing Korean name (if participant not yet found).
  if (!titleParticipant) {
    // Look at the LAST `/`-separated segment for a Korean name.
    const segments = rest.split(/\s*\/\s*/);
    const last = segments[segments.length - 1]?.trim() ?? "";
    const km = last.match(/^[가-힣]{2,4}$/);
    if (km) {
      titleParticipant = km[0];
      segments.pop();
      rest = segments.join(" / ").trim();
    }
  }

  // 4. Clean up slashes, collapse whitespace. Remaining text = project.
  let project = rest
    .replace(/\s*\/\s*/g, " / ")
    .replace(/\s+/g, " ")
    .trim();
  // Strip leading/trailing separators aggressively.
  while (
    project.startsWith("/") ||
    project.startsWith("-") ||
    project.endsWith("/") ||
    project.endsWith("-")
  ) {
    project = project.replace(/^[-/\s]+/, "").replace(/[-/\s]+$/, "");
  }

  if (!project) return null;

  // Classify format for reporting.
  const format =
    sbj != null && day != null && !titleParticipant
      ? "platform"
      : titleParticipant && sbj == null && day == null
        ? "legacy-paren"
        : "legacy-tags";

  return {
    format,
    initial,
    project,
    sbj,
    day,
    period,
    titleParticipant,
  };
}

function parseDescription(desc) {
  if (!desc) return {};
  const lines = desc.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out = {};
  for (const line of lines) {
    const m = line.match(/^(예약자|이메일|전화번호|회차)\s*[:：]\s*(.+)$/);
    if (!m) continue;
    const key =
      m[1] === "예약자"
        ? "name"
        : m[1] === "이메일"
          ? "email"
          : m[1] === "전화번호"
            ? "phone"
            : "session";
    out[key] = m[2].trim();
  }
  return out;
}

const events = await listAllEvents();
console.log(`Fetched ${events.length} events in [${START} .. ${END}]`);

const byInitial = new Map();
const byProject = new Map();
const byParticipant = new Map();
const unparsed = [];
const parsed = [];
let minStart = null;
let maxStart = null;

for (const e of events) {
  const start = e.start?.dateTime ?? e.start?.date ?? null;
  if (start) {
    if (!minStart || start < minStart) minStart = start;
    if (!maxStart || start > maxStart) maxStart = start;
  }
  const titleParsed = parseTitle(e.summary);
  const descParsed = parseDescription(e.description);
  if (!titleParsed) {
    unparsed.push({
      id: e.id,
      summary: e.summary ?? "(no title)",
      start,
    });
    continue;
  }
  parsed.push({ event: e, titleParsed, descParsed });
  const initialKey = titleParsed.initial;
  byInitial.set(initialKey, (byInitial.get(initialKey) ?? 0) + 1);
  const projectKey = titleParsed.project;
  byProject.set(projectKey, (byProject.get(projectKey) ?? 0) + 1);
  // Participant: description takes precedence; fall back to title's
  // parenthesised name for legacy events.
  const pName = descParsed.name ?? titleParsed.titleParticipant ?? null;
  if (pName) {
    byParticipant.set(pName, (byParticipant.get(pName) ?? 0) + 1);
  }
}

console.log(`\nParsed: ${parsed.length}  Unparsed: ${unparsed.length}`);
console.log(`Date range: ${minStart ?? "-"} ~ ${maxStart ?? "-"}`);

console.log(`\n── Initials (실험자) ──`);
[...byInitial.entries()]
  .sort((a, b) => b[1] - a[1])
  .forEach(([k, n]) => console.log(`  ${k.padEnd(8)} ${n}`));

console.log(`\n── Projects ──`);
[...byProject.entries()]
  .sort((a, b) => b[1] - a[1])
  .forEach(([k, n]) => console.log(`  ${k.padEnd(30)} ${n}`));

console.log(`\n── Participants (top 20) ──`);
[...byParticipant.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 20)
  .forEach(([k, n]) => console.log(`  ${k.padEnd(16)} ${n}`));

if (unparsed.length > 0) {
  console.log(`\n── Unparsed event titles (${unparsed.length}) ──`);
  unparsed.slice(0, 20).forEach((u) =>
    console.log(`  ${u.start?.slice(0, 16) ?? "-"}  ${u.summary}`),
  );
  if (unparsed.length > 20) {
    console.log(`  … and ${unparsed.length - 20} more`);
  }
}

// Also dump a CSV-ish summary for the next phase to consume.
console.log(`\n── For next phase ──`);
console.log(
  `${byInitial.size} unique initials, ${byProject.size} unique projects, ${byParticipant.size} unique participants.`,
);
