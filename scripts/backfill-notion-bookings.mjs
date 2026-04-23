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
// Changes since 2026-04-23 strict review:
//   * Strict MATCH only for project page resolution (no more FUZZY /
//     AMBIGUOUS silent fall-through). (C2, C3)
//   * Writes ALL initials from dual-initial events as a Relation array
//     instead of only the first. (C4)
//   * Dedups against bookings.google_event_id → bookings.notion_page_id
//     via report.booking_by_event_id: if the runtime pipeline already
//     created a Notion row for this event, skip. Back-writes the newly
//     created page_id to bookings.notion_page_id when a matching row
//     exists so the runtime path doesn't double-create. (H1)
//   * Logs stale progress entries (events that used to exist but were
//     deleted from the calendar) so the researcher can archive orphan
//     Notion rows. (H2)
//   * Logs events that would land with NO 실험자 Relation (e.g. unknown
//     MJC initial, 22 rows) as researcher_decisions in the audit report.
//     (H3)
//
// Dry-run by default. Pass --confirm to execute.

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync, rmSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

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

const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const report = JSON.parse(
  await readFile(".test-artifacts/calendar-consistency-report.json", "utf8"),
);

const PROGRESS_FILE = ".test-artifacts/calendar-backfill-progress.json";
const LOCK_FILE = ".test-artifacts/.backfill.lock";

// M11 — prevent two concurrent backfill runs from double-writing.
if (existsSync(LOCK_FILE)) {
  const stale = JSON.parse(await readFile(LOCK_FILE, "utf8").catch(() => "{}"));
  console.error(
    `Lock file exists: ${LOCK_FILE}. Another backfill is running (pid=${stale.pid ?? "?"} started=${stale.started_at ?? "?"}). ` +
      `If that process is dead, delete the lock manually.`,
  );
  process.exit(2);
}
await mkdir(".test-artifacts", { recursive: true });
if (confirm) {
  await writeFile(
    LOCK_FILE,
    JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }, null, 2),
  );
  const releaseLock = async () => {
    try {
      await rm(LOCK_FILE);
    } catch {
      // ignore
    }
  };
  process.on("exit", () => {
    try {
      rmSync(LOCK_FILE, { force: true });
    } catch {
      // ignore
    }
  });
  process.on("SIGINT", async () => {
    await releaseLock();
    process.exit(130);
  });
  process.on("SIGTERM", async () => {
    await releaseLock();
    process.exit(143);
  });
}

let progress = { created: {}, failed: [], skipped_with_existing_booking: [], orphan_progress: [] };
if (existsSync(PROGRESS_FILE)) {
  const prev = JSON.parse(await readFile(PROGRESS_FILE, "utf8"));
  progress = {
    created: prev.created ?? {},
    failed: prev.failed ?? [],
    skipped_with_existing_booking: prev.skipped_with_existing_booking ?? [],
    orphan_progress: prev.orphan_progress ?? [],
  };
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
  const d = new Date(iso);
  const kst = new Date(d.getTime() + 9 * 3600e3);
  return kst.toISOString().slice(0, 10);
}

const events = report.parsed_events ?? [];
const bookingByEventId = report.booking_by_event_id ?? {};

// H2 — stale progress detector. Any event_id in progress.created that is
// no longer present in the current parsed_events list is an orphan —
// likely the calendar event was deleted. We don't auto-delete the Notion
// row (that would destroy history); we just log so the researcher can
// archive manually.
const liveEventIds = new Set(events.map((e) => e.event_id));
const orphanEntries = Object.entries(progress.created).filter(
  ([id]) => !liveEventIds.has(id),
);
if (orphanEntries.length > 0) {
  console.log(
    `\n⚠️  ${orphanEntries.length} orphan progress entries (event deleted from calendar, Notion row still present):`,
  );
  for (const [id, pageId] of orphanEntries.slice(0, 10)) {
    console.log(`     event_id=${id.slice(0, 16)}…  notion_page_id=${pageId}`);
  }
  progress.orphan_progress = orphanEntries.map(([event_id, notion_page_id]) => ({
    event_id,
    notion_page_id,
    detected_at: new Date().toISOString(),
  }));
}

console.log(
  `\nCandidates: ${events.length}, already created: ${Object.keys(progress.created).length}`,
);

// H1 — skip events whose booking already has a Notion page.
const alreadyInBookings = events.filter((e) => {
  const b = bookingByEventId[e.event_id];
  return b?.notion_page_id;
});
if (alreadyInBookings.length > 0) {
  console.log(
    `  ${alreadyInBookings.length} events already have bookings.notion_page_id — will skip to avoid duplicates`,
  );
}

const todo = events.filter((e) => {
  if (progress.created[e.event_id]) return false;
  const b = bookingByEventId[e.event_id];
  if (b?.notion_page_id) return false;
  return true;
});
console.log(`To process this run: ${todo.length}${isFinite(LIMIT) ? ` (limit=${LIMIT})` : ""}`);

// H3 — preview events that would land without any 실험자 Relation, so
// the researcher can approve/reject in advance.
const missingMember = todo.filter((e) => {
  const inits = e.initials ?? [e.initial];
  return !inits.some((i) => report.initials_map[i]?.status === "MATCH");
});
if (missingMember.length > 0) {
  console.log(
    `\n⚠️  ${missingMember.length} events would have NO 실험자 Relation (unknown initials: ${[
      ...new Set(missingMember.flatMap((e) => e.initials ?? [e.initial])),
    ].join(", ")})`,
  );
}

// Also surface events with non-MATCH project — they'd land without the
// 프로젝트 (관련) Relation, but still with the rich_text 프로젝트 fallback.
const missingProject = todo.filter((e) => report.projects_map[e.project]?.status !== "MATCH");
if (missingProject.length > 0) {
  console.log(
    `⚠️  ${missingProject.length} events would have NO 프로젝트 (관련) Relation (non-MATCH projects: ${[
      ...new Set(missingProject.map((e) => e.project)),
    ]
      .slice(0, 10)
      .join(", ")})`,
  );
}

if (!confirm) {
  console.log("\n(dry-run — pass --confirm to execute. Examples of first 3:)");
  for (const e of todo.slice(0, 3)) {
    console.log(
      `  ${e.start?.slice(0, 16)}  [${(e.initials ?? [e.initial]).join(" ")}] ${e.project} · ${e.participant_name ?? "-"}`,
    );
  }
  // Persist orphan detection even on dry-run so operators can review it.
  await mkdir(".test-artifacts", { recursive: true });
  await writeFile(PROGRESS_FILE, JSON.stringify(progress, null, 2));
  process.exit(0);
}

let done = 0;
let failed = 0;
let skipped = 0;
let backWrittenToBookings = 0;

for (const e of todo) {
  if (done + failed >= LIMIT) break;
  if (done + failed > 0) await sleep(DELAY_MS);

  const projectMap = report.projects_map[e.project];

  if (projectMap?.status === "SKIP") {
    skipped += 1;
    console.log(`  skip  ${e.start?.slice(0, 10)}  ${e.summary}  (blacklisted project)`);
    continue;
  }

  // C4 — gather ALL researcher page_ids from the initials array.
  const initArr = e.initials ?? [e.initial];
  const memberPageIds = initArr
    .map((i) => report.initials_map[i])
    .filter((m) => m?.status === "MATCH")
    .map((m) => m.page_id);
  const uniqueMemberIds = [...new Set(memberPageIds)];

  // C2/C3 — strict MATCH only. FUZZY / AMBIGUOUS → null, row lands with
  // rich_text fallback but no Relation.
  const projectPageId = projectMap?.status === "MATCH" ? projectMap.page_id : null;

  const props = {
    실험명: {
      title: [
        {
          text: {
            content:
              e.summary ??
              `[${initArr.join(" ")}] ${e.project}${e.participant_name ? ` · ${e.participant_name}` : ""}`,
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
  if (uniqueMemberIds.length > 0) {
    props["실험자"] = { relation: uniqueMemberIds.map((id) => ({ id })) };
  }
  if (projectPageId) {
    props["프로젝트 (관련)"] = { relation: [{ id: projectPageId }] };
  }

  // H6 — bookingByEventId is frozen at report-gen time. Re-query inside
  // the loop so a booking created by the runtime pipeline between report
  // generation and this iteration (the real race window) can't produce a
  // duplicate Notion row.
  const { data: liveBooking } = await supa
    .from("bookings")
    .select("id, notion_page_id")
    .eq("google_event_id", e.event_id)
    .maybeSingle();
  if (liveBooking?.notion_page_id) {
    console.log(
      `  ⊘ race-skip ${e.start?.slice(0, 10)}  ${e.summary}  (runtime created notion_page_id between report + run)`,
    );
    progress.created[e.event_id] = liveBooking.notion_page_id;
    skipped += 1;
    continue;
  }

  try {
    const page = await notion("/pages", {
      parent: { database_id: SLAB_DB_ID },
      properties: props,
    });
    progress.created[e.event_id] = page.id;
    done += 1;

    // H1 — if this event has a Supabase booking, back-write notion_page_id
    // so runtime runNotion will treat it as already done.
    if (liveBooking?.id) {
      const { error } = await supa
        .from("bookings")
        .update({ notion_page_id: page.id })
        .eq("id", liveBooking.id)
        .is("notion_page_id", null); // only if still null (race guard)
      if (error) {
        console.log(
          `  ⚠️  back-write notion_page_id to booking ${liveBooking.id.slice(0, 8)} failed: ${error.message}`,
        );
      } else {
        backWrittenToBookings += 1;
      }
    }

    if (done % 10 === 0) {
      console.log(
        `  … ${done} done (last: ${e.start?.slice(0, 10)} ${initArr.join("/")}/${e.project})`,
      );
    }
  } catch (err) {
    failed += 1;
    progress.failed.push({
      event_id: e.event_id,
      summary: e.summary,
      error: err.message,
      at: new Date().toISOString(),
    });
    console.log(`  ✗ ${e.start?.slice(0, 10)}  ${e.summary}  ${err.message}`);
    if (err.status === 429) {
      const wait = Math.min(Number.parseInt(err.retryAfter, 10) || 30, 60);
      console.log(`  Notion 429 — waiting ${wait}s then stopping so next sweep picks up`);
      await sleep(wait * 1000);
      break;
    }
  }
  if (done % 10 === 0) {
    await mkdir(".test-artifacts", { recursive: true });
    await writeFile(PROGRESS_FILE, JSON.stringify(progress, null, 2));
  }
}

await mkdir(".test-artifacts", { recursive: true });
await writeFile(PROGRESS_FILE, JSON.stringify(progress, null, 2));
console.log(
  `\nDone this run: ${done}, Skipped: ${skipped}, Failed: ${failed}, Back-written to bookings: ${backWrittenToBookings}`,
);
console.log(
  `Total created so far: ${Object.keys(progress.created).length}/${events.length}`,
);
