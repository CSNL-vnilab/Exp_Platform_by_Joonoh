#!/usr/bin/env node
// Phase 6 (metadata fill): populate 담당자 / 기간 / 분류 / 상태 / 우선순위
// / 코드 디렉토리 / 참여자 수 on every Projects & Chores page.
//
// Driven by the user directive 2026-04-23: "Notion page에 기간, 담당자, 분류,
// 상태 등이 전혀 기록되지 않고 있음. 또한 코드 디렉토리, 참여자 수 등에
// 대한 정보도 업데이트되어야함."
//
// Source of truth for each field (objectively derived only — no agent
// defaults). Researcher-subjective fields like 우선순위 are left alone.
//
//   담당자     — union of SLab rows' 실험자 Relation linked to this project
//                (only if the relation has a concrete match).
//   기간       — min(실험날짜) .. max(실험날짜) across linked SLab rows.
//   분류       — "Research" ONLY when a Supabase experiments row is linked
//                to this page (notion_project_page_id matches). Pages
//                without a Supabase link leave 분류 blank for researcher
//                to classify (could be Lab Chore, Coursework, etc.).
//   상태       — "Done" if max(실험날짜) < today, else "In Progress".
//                "Not Started" is never written; absent SLab → leave blank.
//   우선순위   — NOT WRITTEN. Researcher's judgment call.
//   코드 디렉토리 — Supabase experiments.code_repo_url joined on the page_id
//                   (newline-separated if more than one experiment). Only
//                   when the source column is non-empty.
//   참여자 수  — count of distinct 참여자 rich_text values across linked
//                SLab rows. Only when > 0.
//
// Never overwrites a page's existing value (idempotent, safe to re-run).
// Only writes properties that are CURRENTLY empty.
//
// Dry-run by default. Pass --confirm to execute.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";

const envText = await readFile(".env.local", "utf8");
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
}

const NOTION_TOKEN = process.env.NOTION_API_KEY;
const PROJECTS_DB = "76e7c392-127e-47f3-8b7e-212610db9376";
const SLAB_DB_ID = process.env.NOTION_DATABASE_ID;
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

async function listAllDbRows(dbId, filter) {
  const out = [];
  let start_cursor;
  for (let p = 0; p < 50; p++) {
    const res = await notion(`/databases/${dbId}/query`, {
      page_size: 100,
      start_cursor,
      ...(filter ? { filter } : {}),
    });
    out.push(...(res.results ?? []));
    if (!res.has_more) break;
    start_cursor = res.next_cursor;
    await sleep(DELAY_MS);
  }
  return out;
}

function titleOf(page) {
  const entry = Object.entries(page.properties).find(([, p]) => p.type === "title");
  return entry?.[1].title?.map((t) => t.plain_text).join("") || "(untitled)";
}

const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

console.log("Fetching Notion Projects & Chores…");
const projectPages = await listAllDbRows(PROJECTS_DB);
console.log(`  ${projectPages.length} pages`);
await sleep(DELAY_MS);

console.log("Fetching Notion SLab rows…");
const slabPages = await listAllDbRows(SLAB_DB_ID);
console.log(`  ${slabPages.length} rows`);
await sleep(DELAY_MS);

console.log("Fetching Supabase experiments + bookings…");
const { data: experiments } = await supa
  .from("experiments")
  .select("id, title, project_name, code_repo_url, data_path, notion_project_page_id, created_by");
const { data: profiles } = await supa
  .from("profiles")
  .select("id, display_name, email, notion_member_page_id");
console.log(`  ${experiments?.length ?? 0} experiments, ${profiles?.length ?? 0} profiles`);

// Index: project page_id → list of SLab rows linked to it.
const slabByProject = new Map();
for (const row of slabPages) {
  const projRel = row.properties["프로젝트 (관련)"]?.relation ?? [];
  for (const r of projRel) {
    if (!slabByProject.has(r.id)) slabByProject.set(r.id, []);
    slabByProject.get(r.id).push(row);
  }
}

// Index: project page_id → list of Supabase experiments linked to it.
const expByProject = new Map();
for (const e of experiments ?? []) {
  if (!e.notion_project_page_id) continue;
  if (!expByProject.has(e.notion_project_page_id)) {
    expByProject.set(e.notion_project_page_id, []);
  }
  expByProject.get(e.notion_project_page_id).push(e);
}

const today = new Date().toISOString().slice(0, 10);
const TODAY = today;

function earliestDate(rows) {
  const dates = rows
    .map((r) => r.properties["실험날짜"]?.date?.start)
    .filter(Boolean)
    .sort();
  return dates[0] ?? null;
}
function latestDate(rows) {
  const dates = rows
    .map((r) => r.properties["실험날짜"]?.date?.start)
    .filter(Boolean)
    .sort();
  return dates[dates.length - 1] ?? null;
}
function uniqueMembers(rows) {
  const s = new Set();
  for (const r of rows) {
    const rel = r.properties["실험자"]?.relation ?? [];
    for (const m of rel) s.add(m.id);
  }
  return [...s];
}
function uniqueParticipants(rows) {
  const s = new Set();
  for (const r of rows) {
    const raw = r.properties["참여자"]?.rich_text?.map((t) => t.plain_text).join("").trim();
    if (raw) s.add(raw);
  }
  return s.size;
}

const plans = [];
for (const page of projectPages) {
  const pageId = page.id;
  const title = titleOf(page);
  const linkedSlab = slabByProject.get(pageId) ?? [];
  const linkedExp = expByProject.get(pageId) ?? [];

  const existing = page.properties;
  const missing = {
    담당자: (existing["담당자"]?.relation ?? []).length === 0,
    기간: existing["기간"]?.date == null,
    분류: existing["분류"]?.select == null,
    상태: existing["상태"]?.status == null,
    우선순위: existing["우선순위"]?.select == null,
    "코드 디렉토리":
      (existing["코드 디렉토리"]?.rich_text ?? []).length === 0 ||
      !existing["코드 디렉토리"]?.rich_text?.map((t) => t.plain_text).join("").trim(),
    "참여자 수": existing["참여자 수"]?.number == null,
  };

  const plan = { pageId, title, linked_slab_count: linkedSlab.length, linked_exp_count: linkedExp.length, updates: {} };

  if (missing["담당자"]) {
    const owners = uniqueMembers(linkedSlab);
    if (owners.length > 0) plan.updates["담당자"] = { relation: owners.map((id) => ({ id })) };
  }
  if (missing["기간"]) {
    const start = earliestDate(linkedSlab);
    const end = latestDate(linkedSlab);
    if (start) plan.updates["기간"] = { date: end && end !== start ? { start, end } : { start } };
  }
  // 분류 ONLY when a Supabase experiment row is linked — evidence of
  // research-mode usage. Pages without the link are left for the
  // researcher to classify (Lab Chore / Coursework / Research).
  if (missing["분류"] && linkedExp.length > 0) {
    plan.updates["분류"] = { select: { name: "Research" } };
  }
  // 상태 only emitted when we actually have dated SLab rows to reason
  // about; empty pages are left alone (no "Not Started" default).
  if (missing["상태"] && linkedSlab.length > 0) {
    const end = latestDate(linkedSlab);
    const statusName = end && end < TODAY ? "Done" : "In Progress";
    plan.updates["상태"] = { status: { name: statusName } };
  }
  // 우선순위 is a researcher-judgment field — never auto-assign.
  if (missing["코드 디렉토리"]) {
    const dirs = linkedExp
      .map((e) => e.code_repo_url)
      .filter((s) => s && String(s).trim().length > 0);
    if (dirs.length > 0) {
      plan.updates["코드 디렉토리"] = {
        rich_text: [{ text: { content: dirs.join("\n").slice(0, 1800) } }],
      };
    }
  }
  if (missing["참여자 수"]) {
    const n = uniqueParticipants(linkedSlab);
    if (n > 0) plan.updates["참여자 수"] = { number: n };
  }

  plans.push(plan);
}

const actionable = plans.filter((p) => Object.keys(p.updates).length > 0);
const noop = plans.length - actionable.length;

console.log(`\n── Plan ──`);
console.log(`Projects pages: ${projectPages.length} total, ${actionable.length} need updates, ${noop} already fully populated.`);
for (const p of actionable) {
  const keys = Object.keys(p.updates);
  console.log(`  · ${p.title.padEnd(30)} slab=${p.linked_slab_count} exp=${p.linked_exp_count}   → ${keys.join(", ")}`);
}

await mkdir(".test-artifacts", { recursive: true });
await writeFile(
  ".test-artifacts/projects-metadata-plan.json",
  JSON.stringify({ generated_at: new Date().toISOString(), plans }, null, 2),
);

if (!confirm) {
  console.log("\n(dry-run — pass --confirm to execute)");
  process.exit(0);
}

console.log("\nExecuting…");
let ok = 0;
let failed = 0;
for (const p of actionable) {
  await sleep(DELAY_MS);
  try {
    await notion(`/pages/${p.pageId}`, { properties: p.updates }, "PATCH");
    ok += 1;
    console.log(`  ✓ ${p.title}  (${Object.keys(p.updates).join(",")})`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${p.title}  ${err.message}`);
  }
}

console.log(`\nDone. Written ${ok}, Failed ${failed}. Already-complete pages untouched: ${noop}.`);
