#!/usr/bin/env node
// Read-only parser for 2026 events on the SLab Google Calendar.
//
// Fetches every event that starts in 2026-01-01 ~ 2026-12-31 KST, parses
// titles + descriptions via scripts/lib/calendar-parse.mjs, then prints
// aggregate stats. Pure read — doesn't touch Supabase/Notion.
//
// As of 2026-04-23 this script shares its parser with the consistency
// check (M1 consolidation). The single source of truth is scripts/lib.

import { readFile } from "node:fs/promises";
import { google } from "googleapis";
import { parseTitle, parseDescription } from "./lib/calendar-parse.mjs";

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

const events = await listAllEvents();
console.log(`Fetched ${events.length} events in [${START} .. ${END}]`);

const byInitial = new Map();
const byProject = new Map();
const byParticipant = new Map();
const byFormat = new Map();
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
    unparsed.push({ id: e.id, summary: e.summary ?? "(no title)", start });
    continue;
  }
  parsed.push({ event: e, titleParsed, descParsed });
  byFormat.set(titleParsed.format, (byFormat.get(titleParsed.format) ?? 0) + 1);
  for (const i of titleParsed.initials) byInitial.set(i, (byInitial.get(i) ?? 0) + 1);
  const projectKey = titleParsed.project;
  byProject.set(projectKey, (byProject.get(projectKey) ?? 0) + 1);
  const pName = descParsed.name ?? titleParsed.titleParticipant ?? null;
  if (pName) byParticipant.set(pName, (byParticipant.get(pName) ?? 0) + 1);
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

console.log(`\n── Formats ──`);
[...byFormat.entries()].forEach(([k, n]) => console.log(`  ${k.padEnd(14)} ${n}`));

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

console.log(`\n── For next phase ──`);
console.log(
  `${byInitial.size} unique initials, ${byProject.size} unique projects, ${byParticipant.size} unique participants.`,
);
