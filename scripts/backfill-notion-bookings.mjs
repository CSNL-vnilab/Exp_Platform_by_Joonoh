#!/usr/bin/env node
// Phase 4: create Notion SLab DB booking rows for every parsed 2026
// calendar event. Consumes .test-artifacts/calendar-consistency-report.json
// for the page_id mappings (Members + Projects) produced by the earlier
// phases.
//
// Safe re-runs: every create records its new page_id in
// .test-artifacts/calendar-backfill-progress.json; the next run skips
// events that already have a page. Stops on any Notion 429 and records
// the failure point so the next invocation picks up.
//
// Dry-run by default.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";

const envText = await readFile(".env.local", "utf8");
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
}

const NOTION_TOKEN = process.env.NOTION_API_KEY;
const SLAB_DB_ID = process.env.NOTION_DATABASE_ID;
const DELAY_MS = 400; // Notion 3 rps sustained → stay under
const confirm = process.argv.includes("--confirm");
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? Number.parseInt(limitArg.split("=")[1], 10) : Infinity;

const report = JSON.parse(
  await readFile(".test-artifacts/calendar-consistency-report.json", "utf8"),
);

const PROGRESS_FILE = ".test-artifacts/calendar-backfill-progress.json";
let progress = { created: {}, failed: [] };
if (existsSync(PROGRESS_FILE)) {
  progress = JSON.parse(await readFile(PROGRESS_FILE, "utf8"));
}

async function notion(path, body, method = "POST") {
  const r = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const jbody = await r.json().catch(() => null);
  if (!r.ok) {
    const err = new Error(
      `notion ${method} ${path} ${r.status}: ${JSON.stringify(jbody).slice(0, 300)}`,
    );
    err.status = r.status;
    err.retryAfter = r.headers.get("retry-after");
    throw err;
  }
  return jbody;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtKstTime(iso) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

function kstDate(iso) {
  // Just strip to YYYY-MM-DD in KST
  const d = new Date(iso);
  const kst = new Date(d.getTime() + 9 * 3600e3);
  return kst.toISOString().slice(0, 10);
}

const events = report.parsed_events ?? [];
console.log(`Candidates: ${events.length}, already created: ${Object.keys(progress.created).length}`);

const todo = events.filter((e) => !progress.created[e.event_id]);
console.log(`To process this run: ${todo.length}${isFinite(LIMIT) ? ` (limit=${LIMIT})` : ""}`);

if (!confirm) {
  console.log("(dry-run — pass --confirm to execute. Examples of first 3:)");
  for (const e of todo.slice(0, 3)) {
    console.log(
      `  ${e.start?.slice(0, 16)}  [${e.initial}] ${e.project} · ${e.participant_name ?? "-"}`,
    );
  }
  process.exit(0);
}

let done = 0;
let failed = 0;
let skipped = 0;

for (const e of todo) {
  if (done + failed >= LIMIT) break;
  if (done + failed > 0) await sleep(DELAY_MS);

  const initialMap = report.initials_map[e.initial];
  const projectMap = report.projects_map[e.project];

  // Skip blacklisted projects entirely — they're not research events.
  if (projectMap?.status === "SKIP") {
    skipped += 1;
    console.log(`  skip  ${e.start?.slice(0, 10)}  ${e.summary}  (blacklisted project)`);
    continue;
  }

  const memberPageId =
    initialMap?.status === "MATCH" ? initialMap.page_id : null;
  const projectPageId =
    projectMap?.status === "MATCH" ? projectMap.page_id : null;

  const props = {
    실험명: {
      title: [
        {
          text: {
            content:
              e.summary ??
              `[${e.initial}] ${e.project}${e.participant_name ? ` · ${e.participant_name}` : ""}`,
          },
        },
      ],
    },
    프로젝트: { rich_text: [{ text: { content: e.project } }] },
    실험날짜: { date: { start: kstDate(e.start) } },
    시간: {
      rich_text: [
        {
          text: {
            content: `${fmtKstTime(e.start)} - ${fmtKstTime(e.end ?? e.start)}`,
          },
        },
      ],
    },
    "피험자 ID": {
      rich_text: [
        {
          text: {
            content: e.sbj != null ? `Sbj${e.sbj}` : "",
          },
        },
      ],
    },
    회차: { number: e.day ?? 1 },
    참여자: {
      rich_text: [{ text: { content: e.participant_name ?? "" } }],
    },
    상태: { select: { name: "완료" } }, // backfill = past event = completed
    "공개 ID": { rich_text: [{ text: { content: "" } }] },
    "버전넘버": { rich_text: [{ text: { content: "" } }] },
  };
  if (memberPageId) {
    props["실험자"] = { relation: [{ id: memberPageId }] };
  }
  if (projectPageId) {
    props["프로젝트 (관련)"] = { relation: [{ id: projectPageId }] };
  }

  try {
    const page = await notion("/pages", {
      parent: { database_id: SLAB_DB_ID },
      properties: props,
    });
    progress.created[e.event_id] = page.id;
    done += 1;
    if (done % 10 === 0) {
      console.log(`  … ${done} done (last: ${e.start?.slice(0, 10)} ${e.initial}/${e.project})`);
    }
  } catch (err) {
    failed += 1;
    progress.failed.push({ event_id: e.event_id, summary: e.summary, error: err.message, at: new Date().toISOString() });
    console.log(`  ✗ ${e.start?.slice(0, 10)}  ${e.summary}  ${err.message}`);
    if (err.status === 429) {
      const wait = Math.min((Number.parseInt(err.retryAfter, 10) || 30), 60);
      console.log(`  Notion 429 — waiting ${wait}s then stopping so next sweep picks up`);
      await sleep(wait * 1000);
      break;
    }
  }
  // Persist progress every 10 writes so a crash doesn't lose state.
  if (done % 10 === 0) {
    await mkdir(".test-artifacts", { recursive: true });
    await writeFile(PROGRESS_FILE, JSON.stringify(progress, null, 2));
  }
}

await mkdir(".test-artifacts", { recursive: true });
await writeFile(PROGRESS_FILE, JSON.stringify(progress, null, 2));
console.log(`\nDone this run: ${done}, Skipped: ${skipped}, Failed: ${failed}`);
console.log(`Total created so far: ${Object.keys(progress.created).length}/${events.length}`);
