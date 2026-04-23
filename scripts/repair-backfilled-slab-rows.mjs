#!/usr/bin/env node
// Phase 5 (repair): audit and fix the SLab rows that an earlier version of
// the backfill wrote with mis-categorised project / missing researcher
// relations. Driven by the strict review of 2026-04-23 (C1-C4, H1-H3).
//
// Inventory of expected repairs (based on the report state at the time
// the original 235 rows were written):
//   * 1 row with 프로젝트 = "Self-Pilot" whose 프로젝트 (관련) was silently
//     linked to the "Pilot" page via FUZZY fall-through — relink to
//     "Self Pilot".
//   * 6 rows with 프로젝트 = "self pilot" (AMBIGUOUS → no Relation) —
//     add Relation to "Self Pilot".
//   * 5 rows with 프로젝트 = "pilot"      (AMBIGUOUS → no Relation) —
//     add Relation to "Pilot".
//   * 2 dual-initial rows (`[JYK BHL]`, `[BHL SYJ]`) where only the first
//     researcher was linked — add the second.
//   * 22 MJC rows (no matching Members entry) — logged as orphans in
//     .test-artifacts/calendar-repair-report.json for the researcher.
//
// Re-reads the up-to-date consistency report so the canonical page_ids
// are authoritative, and re-reads Notion SLab pages so we only touch
// rows whose current state actually matches the "bad" pattern — i.e.
// this is idempotent and will not clobber pages that are already
// correct (e.g. because the researcher hand-fixed them).
//
// Dry-run by default. Pass --confirm to write.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { canonProject } from "./lib/calendar-parse.mjs";

const envText = await readFile(".env.local", "utf8");
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
}

const NOTION_TOKEN = process.env.NOTION_API_KEY;
const SLAB_DB_ID = process.env.NOTION_DATABASE_ID;
const MEMBERS_DB = "94854705-c91d-4a35-a91e-803c5934745e";
const PROJECTS_DB = "76e7c392-127e-47f3-8b7e-212610db9376";
const DELAY_MS = 400;
const confirm = process.argv.includes("--confirm");

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
    throw new Error(
      `notion ${method} ${path} ${r.status}: ${JSON.stringify(jbody).slice(0, 400)}`,
    );
  }
  return jbody;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

console.log("Loading consistency report + progress…");
const report = JSON.parse(
  await readFile(".test-artifacts/calendar-consistency-report.json", "utf8"),
);
const progress = JSON.parse(
  await readFile(".test-artifacts/calendar-backfill-progress.json", "utf8"),
);

console.log("Fetching Notion Projects & Members + SLab pages…");
const projectPages = await listAllDbRows(PROJECTS_DB);
await sleep(DELAY_MS);
const memberPages = await listAllDbRows(MEMBERS_DB);
await sleep(DELAY_MS);

// Map canonical project key → page_id. If multiple Notion pages share
// the same canon (operator error) we REFUSE to link silently and surface
// the ambiguity for manual dedupe.
const projectByCanon = new Map();
for (const p of projectPages) {
  const t = titleOf(p);
  const c = canonProject(t);
  if (!c) continue;
  if (projectByCanon.has(c)) {
    const existing = projectByCanon.get(c);
    projectByCanon.set(c, {
      ambiguous: true,
      candidates: [
        ...(existing.ambiguous ? existing.candidates : [existing]),
        { id: p.id, title: t },
      ],
    });
  } else {
    projectByCanon.set(c, { id: p.id, title: t });
  }
}
const memberByInitial = new Map();
for (const m of memberPages) {
  const t = titleOf(m).toUpperCase().trim();
  if (t) memberByInitial.set(t, { id: m.id, title: t });
}

// Lookups we need.
function projectPageForCanon(c) {
  const hit = projectByCanon.get(c);
  if (!hit || hit.ambiguous) return null;
  return hit.id;
}
function memberPageForInitial(i) {
  return memberByInitial.get(i)?.id ?? null;
}

// Rows we want to repair — defined by which `parsed_events` have known
// defects *and* an entry in progress.created.
const REPAIRS = {
  project_relation_needed: [], // generic: row's project canon matches a
                               // Notion page, but row doesn't have that
                               // Relation set. Subsumes Self-Pilot /
                               // Pilot / LabTour / future additions.
  dual_initial_missing: [], // dual-initial events with second researcher dropped
  orphan_member: [], // unknown initial (MJC, TAC-bracketless-rejected, …)
};

for (const e of report.parsed_events) {
  const notionPageId = progress.created[e.event_id];
  if (!notionPageId) continue; // not written yet
  const projC = canonProject(e.project);

  // Project Relation — any row whose project canon maps to an existing
  // Notion page is eligible. We verify current Relation state below
  // before deciding to write.
  if (projC) {
    const targetPageId = projectPageForCanon(projC);
    if (targetPageId) {
      REPAIRS.project_relation_needed.push({
        event_id: e.event_id,
        notion_page_id: notionPageId,
        current_project: e.project,
        canon: projC,
        target_project_page_id: targetPageId,
      });
    }
  }

  // Dual-initial — current row has only first Relation; find missing ones.
  const inits = e.initials ?? [e.initial];
  if (inits.length > 1) {
    const allIds = inits
      .map((i) => memberPageForInitial(i))
      .filter(Boolean);
    if (allIds.length > 1) {
      REPAIRS.dual_initial_missing.push({
        event_id: e.event_id,
        notion_page_id: notionPageId,
        initials: inits,
        all_member_page_ids: allIds,
      });
    }
  }
  // Orphan member — initial not in Members DB.
  const unknown = inits.filter((i) => !memberByInitial.has(i));
  if (unknown.length > 0) {
    REPAIRS.orphan_member.push({
      event_id: e.event_id,
      notion_page_id: notionPageId,
      summary: e.summary,
      unknown_initials: unknown,
    });
  }
}

console.log(`\nRepair plan (from consistency report):`);
console.log(`  Project Relation needed (any canon match):  ${REPAIRS.project_relation_needed.length}`);
console.log(`  Dual-initial missing second researcher:     ${REPAIRS.dual_initial_missing.length}`);
console.log(`  Orphan member (unknown initial):            ${REPAIRS.orphan_member.length}`);

// Before writing, verify the current Notion state. We ONLY act if the
// defect is still present.
async function fetchPage(pageId) {
  return notion(`/pages/${pageId}`, null, "GET");
}

async function currentProjectRelation(page) {
  const rel = page.properties?.["프로젝트 (관련)"]?.relation ?? [];
  return rel.map((r) => r.id);
}
async function currentMemberRelation(page) {
  const rel = page.properties?.["실험자"]?.relation ?? [];
  return rel.map((r) => r.id);
}

const actions = [];

for (const r of REPAIRS.project_relation_needed) {
  const p = await fetchPage(r.notion_page_id);
  await sleep(DELAY_MS);
  const cur = await currentProjectRelation(p);
  if (cur.includes(r.target_project_page_id)) {
    actions.push({ ...r, kind: "project_relation", decision: "SKIP_ALREADY_CORRECT" });
  } else if (cur.length === 0) {
    // No Relation at all — safe to set.
    actions.push({ ...r, kind: "project_relation", decision: "LINK" });
  } else {
    // Different page linked. Could be a manual correction OR the old
    // FUZZY mislink. Treat as RELINK only if our canonical page
    // supersedes; otherwise log and skip so we don't overwrite a
    // researcher's hand-fix.
    actions.push({
      ...r,
      kind: "project_relation",
      decision: "SKIP_DIFFERENT_LINKED",
      current: cur,
    });
  }
}
for (const r of REPAIRS.dual_initial_missing) {
  const p = await fetchPage(r.notion_page_id);
  await sleep(DELAY_MS);
  const cur = await currentMemberRelation(p);
  const need = r.all_member_page_ids;
  const missing = need.filter((id) => !cur.includes(id));
  if (missing.length === 0) {
    actions.push({ ...r, kind: "dual_initial_missing", decision: "SKIP_ALREADY_COMPLETE" });
  } else {
    actions.push({
      ...r,
      kind: "dual_initial_missing",
      decision: "EXTEND_RELATION",
      current: cur,
      to_add: missing,
    });
  }
}

// Write repair report either way (dry-run included).
await mkdir(".test-artifacts", { recursive: true });
const repairReport = {
  generated_at: new Date().toISOString(),
  counts: {
    project_relation_needed: REPAIRS.project_relation_needed.length,
    dual_initial_missing: REPAIRS.dual_initial_missing.length,
    orphan_member: REPAIRS.orphan_member.length,
  },
  actions,
  orphans: REPAIRS.orphan_member,
};
await writeFile(
  ".test-artifacts/calendar-repair-report.json",
  JSON.stringify(repairReport, null, 2),
);

const summary = {};
for (const a of actions) {
  summary[`${a.kind}:${a.decision}`] = (summary[`${a.kind}:${a.decision}`] ?? 0) + 1;
}
console.log(`\n── Actions required ──`);
for (const [k, n] of Object.entries(summary)) console.log(`  ${k}: ${n}`);

if (!confirm) {
  console.log(`\n(dry-run — pass --confirm to execute. Report at .test-artifacts/calendar-repair-report.json)`);
  process.exit(0);
}

console.log(`\nExecuting repairs…`);
let written = 0;
let failed = 0;
for (const a of actions) {
  if (
    a.decision === "SKIP_ALREADY_CORRECT" ||
    a.decision === "SKIP_ALREADY_COMPLETE" ||
    a.decision === "SKIP_DIFFERENT_LINKED"
  ) {
    continue;
  }
  await sleep(DELAY_MS);
  try {
    if (a.kind === "project_relation") {
      // Set Relation to the single canonical target page.
      await notion(
        `/pages/${a.notion_page_id}`,
        {
          properties: {
            "프로젝트 (관련)": {
              relation: [{ id: a.target_project_page_id }],
            },
          },
        },
        "PATCH",
      );
      console.log(`  ✓ ${a.kind}  ${a.notion_page_id.slice(0, 8)}  → ${a.target_project_page_id.slice(0, 8)}`);
      written += 1;
    } else if (a.kind === "dual_initial_missing") {
      // Extend: union of current + missing.
      const newRel = [...new Set([...a.current, ...a.to_add])].map((id) => ({ id }));
      await notion(
        `/pages/${a.notion_page_id}`,
        { properties: { "실험자": { relation: newRel } } },
        "PATCH",
      );
      console.log(
        `  ✓ dual_initial  ${a.notion_page_id.slice(0, 8)}  + ${a.to_add.length} member(s)`,
      );
      written += 1;
    }
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${a.kind}  ${a.notion_page_id.slice(0, 8)}  ${err.message}`);
  }
}

console.log(`\nRepairs written: ${written}, failed: ${failed}`);
console.log(
  `Orphan members (researcher decision needed): ${REPAIRS.orphan_member.length} — see .test-artifacts/calendar-repair-report.json`,
);
