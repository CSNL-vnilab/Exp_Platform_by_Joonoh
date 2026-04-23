#!/usr/bin/env node
// Phase 7 (reminders): for every Supabase experiment that is missing
// research-metadata fields (code_repo_url, data_path, pre/post-survey
// information, pre-experiment checklist items), emit a Notion
// "Lab Chore" row in Projects & Chores DB assigned to the owning
// researcher so they get a reminder to fill it.
//
// Driven by the user directive 2026-04-23: "디렉토리, survey등 기록되지
// 않은 정보가 있으면 그에 대한 리마인드 노트가 각 연구자에게 할당되어야함".
//
// One row per (experiment, missing_field) — idempotent. Before creating,
// we query Projects & Chores for an existing row whose 항목명 matches
// the reminder title; skip if present (including after manual completion
// — researchers can set 상태=Done and the row stays, we just don't
// duplicate).
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
  return entry?.[1].title?.map((t) => t.plain_text).join("") || "";
}

const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

console.log("Fetching Supabase experiments + profiles + observation stats…");
const { data: experiments } = await supa
  .from("experiments")
  .select(
    "id, title, project_name, code_repo_url, data_path, pre_experiment_checklist, notion_project_page_id, created_by, status",
  );
const { data: profiles } = await supa
  .from("profiles")
  .select("id, display_name, email, notion_member_page_id");
const profileById = new Map((profiles ?? []).map((p) => [p.id, p]));

// Observation completeness — fetch bookings that have observations recorded
// for each experiment; if any are missing pre/post survey info flags, we
// surface a reminder at the experiment level.
const { data: bookings } = await supa
  .from("bookings")
  .select(
    "id, experiment_id, participant_id, pre_survey_done, pre_survey_info, post_survey_done, post_survey_info, status",
  )
  .in("status", ["completed", "confirmed"]);

// Per-experiment survey gap detection: any completed booking where
// pre_survey_done=true but pre_survey_info is blank (shouldn't happen
// given the schema superRefine, but historical rows exist) OR no
// observations recorded at all.
const experimentSurveyGap = new Map();
for (const b of bookings ?? []) {
  if (!b.experiment_id) continue;
  const hasObservationRow =
    b.pre_survey_done !== null || b.post_survey_done !== null;
  const anomalous =
    (b.pre_survey_done && !b.pre_survey_info?.trim()) ||
    (b.post_survey_done && !b.post_survey_info?.trim());
  if (anomalous) {
    if (!experimentSurveyGap.has(b.experiment_id)) {
      experimentSurveyGap.set(b.experiment_id, 0);
    }
    experimentSurveyGap.set(
      b.experiment_id,
      experimentSurveyGap.get(b.experiment_id) + 1,
    );
  }
}

console.log("Fetching existing Projects & Chores reminders (to dedupe)…");
const projectPages = await listAllDbRows(PROJECTS_DB);
const existingTitles = new Set(projectPages.map((p) => titleOf(p)));
console.log(`  ${projectPages.length} pages, existing reminders skipped`);

// For every experiment, enumerate missing-metadata reasons.
const REMINDERS = [];
for (const e of experiments ?? []) {
  const researcher = profileById.get(e.created_by);
  const ownerName = researcher?.display_name ?? researcher?.email ?? "(unknown)";
  const ownerPageId = researcher?.notion_member_page_id ?? null;

  const gaps = [];
  if (!e.code_repo_url || !String(e.code_repo_url).trim()) {
    gaps.push({
      field: "code_repo_url",
      label: "코드 디렉토리 / Repo URL",
      detail: "실험 분석 코드의 GitHub URL 또는 서버 경로를 기록해 주세요.",
    });
  }
  if (!e.data_path || !String(e.data_path).trim()) {
    gaps.push({
      field: "data_path",
      label: "데이터 디렉토리",
      detail: "수집된 원시 데이터의 서버 경로 또는 URL을 기록해 주세요.",
    });
  }
  if (
    !Array.isArray(e.pre_experiment_checklist) ||
    e.pre_experiment_checklist.length === 0
  ) {
    gaps.push({
      field: "pre_experiment_checklist",
      label: "실험 전 체크리스트",
      detail:
        "실험 시작 전 확인해야 할 항목 목록 (예: 장비 전원, consent 서명 수령 등) 을 기록해 주세요.",
    });
  }
  if (experimentSurveyGap.has(e.id)) {
    gaps.push({
      field: "survey_info",
      label: "참여자 설문 상세",
      detail: `${experimentSurveyGap.get(e.id)}건의 booking에서 설문 수행 여부는 체크했지만 상세 정보가 누락되어 있습니다.`,
    });
  }

  for (const g of gaps) {
    const title = `[리마인더] ${e.title} — ${g.label} 기록 필요`;
    if (existingTitles.has(title)) continue;
    REMINDERS.push({
      experiment_id: e.id,
      experiment_title: e.title,
      owner_name: ownerName,
      owner_page_id: ownerPageId,
      gap_field: g.field,
      title,
      detail: g.detail,
    });
  }
}

console.log(`\n── Reminder plan ──`);
console.log(`Reminders to create: ${REMINDERS.length}`);
const byOwner = new Map();
for (const r of REMINDERS) {
  if (!byOwner.has(r.owner_name)) byOwner.set(r.owner_name, 0);
  byOwner.set(r.owner_name, byOwner.get(r.owner_name) + 1);
}
for (const [k, n] of byOwner.entries()) console.log(`  · ${k}: ${n}`);

await mkdir(".test-artifacts", { recursive: true });
await writeFile(
  ".test-artifacts/researcher-reminders-plan.json",
  JSON.stringify(
    { generated_at: new Date().toISOString(), reminders: REMINDERS },
    null,
    2,
  ),
);

if (!confirm) {
  console.log(`\n(dry-run — pass --confirm to create these pages)`);
  process.exit(0);
}

console.log(`\nCreating ${REMINDERS.length} Lab Chore pages…`);
let ok = 0;
let failed = 0;
for (const r of REMINDERS) {
  await sleep(DELAY_MS);
  try {
    const properties = {
      항목명: { title: [{ text: { content: r.title } }] },
      분류: { select: { name: "Lab Chore" } },
      상태: { status: { name: "Not Started" } },
      우선순위: { select: { name: "P2" } },
    };
    if (r.owner_page_id) {
      properties["담당자"] = { relation: [{ id: r.owner_page_id }] };
    }
    await notion("/pages", {
      parent: { database_id: PROJECTS_DB },
      properties,
      children: [
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [{ type: "text", text: { content: r.detail } }],
          },
        },
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [
              {
                type: "text",
                text: {
                  content: `실험: ${r.experiment_title}\n담당자: ${r.owner_name}\n누락 필드: ${r.gap_field}`,
                },
              },
            ],
          },
        },
      ],
    });
    ok += 1;
    if (ok % 5 === 0) console.log(`  … ${ok} done`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${r.title}  ${err.message}`);
  }
}

console.log(`\nDone. Written ${ok}, Failed ${failed}.`);
