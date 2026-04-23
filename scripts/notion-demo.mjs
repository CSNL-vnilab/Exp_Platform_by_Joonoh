#!/usr/bin/env node
// End-to-end Notion demo — mirrors src/lib/notion/client.ts payload shapes
// 1:1 so what we write here is byte-equivalent to what production writes.
// Keeping it self-contained (no TS import) so it's a drop-in verification
// script that any researcher can run.
//
// Exercises all three write paths:
//   Phase 1 — createExperimentPage  (draft→active 실험 마스터 행)
//   Phase 2 — createBookingPage     (세션 행 · 공개 ID 포함)
//   Phase 3 — upsertObservationPage (PATCH with Pre/Post Survey + 특이사항)
//
// Run: node scripts/notion-demo.mjs

import { readFile } from "node:fs/promises";

const envText = await readFile(".env.local", "utf8").catch(() => "");
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
}
const TOKEN = process.env.NOTION_API_KEY;
const DB_ID = process.env.NOTION_DATABASE_ID;
if (!TOKEN || !DB_ID) {
  console.error("Missing NOTION_API_KEY or NOTION_DATABASE_ID");
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  "Notion-Version": "2022-06-28",
  "Content-Type": "application/json",
};

async function createPage(properties) {
  const r = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers,
    body: JSON.stringify({
      parent: { database_id: DB_ID.trim() },
      properties,
    }),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(body).slice(0, 400)}`);
  return body.id;
}

async function patchPage(pageId, properties) {
  const r = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ properties }),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(body).slice(0, 400)}`);
  return body.id;
}

function t(s) { return [{ text: { content: s ?? "" } }]; }
function title(s) { return { title: t(s) }; }
function rt(s) { return { rich_text: t(s) }; }

function formatTime(iso) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

const now = new Date();
const demoDate = now.toISOString().slice(0, 10);
const slotStart = new Date(now.getTime() + 60 * 60 * 1000);
const slotEnd = new Date(now.getTime() + 2 * 60 * 60 * 1000);
const slotStartIso = slotStart.toISOString();
const slotEndIso = slotEnd.toISOString();

// ── Phase 1 ──
console.log("── Phase 1: createExperimentPage (실험 마스터 행) ──");
let expPageId = null;
try {
  const paramSchema = [
    { key: "stim_contrast", type: "number", default: 0.8 },
    { key: "modality", type: "enum", options: ["visual", "auditory", "tactile"] },
    { key: "session_tag", type: "string" },
  ];
  const paramSummary = paramSchema
    .map((p) => {
      const opts = p.type === "enum" && p.options?.length ? ` [${p.options.join("|")}]` : "";
      const def = p.default != null && p.default !== "" ? ` = ${p.default}` : "";
      return `${p.key}: ${p.type}${opts}${def}`;
    })
    .join("\n");
  const checklist = [
    { item: "장비 캘리브레이션 확인", required: true },
    { item: "IRB 동의서 준비", required: true },
    { item: "리마인더 이메일 수신 확인", required: false },
  ];
  const checklistSummary = checklist.map((c) => `${c.required ? "[R]" : "[ ]"} ${c.item}`).join("\n");
  const endDate = new Date(now.getTime() + 14 * 86400e3).toISOString().slice(0, 10);

  expPageId = await createPage({
    실험명: title("[실험] DEMO · Notion 연동 검증 실험"),
    프로젝트: rt("NotionDemo"),
    실험날짜: { date: { start: demoDate, end: endDate } },
    시간: rt(`${demoDate} ~ ${endDate}`),
    "피험자 ID": rt("실험 마스터"),
    회차: { number: 0 },
    참여자: rt("CSNL Demo Researcher"),
    상태: { select: { name: "확정" } },
    "Code Directory": rt("https://github.com/CSNL-vnilab/Exp_Platform_by_Joonoh"),
    "Data Directory": rt("/data/csnl/notion-demo/raw"),
    Parameter: rt(paramSummary),
    Notes: rt(`체크리스트:\n${checklistSummary}`),
  });
  console.log(`  ✓ page_id = ${expPageId}`);
} catch (err) {
  console.error(`  ✗ ${err.message}`);
}

// ── Phase 2 ──
console.log("\n── Phase 2: createBookingPage (세션 행 · 공개 ID 포함) ──");
let bookingPageId = null;
try {
  const kstDate = slotStartIso.slice(0, 10);
  const timeRange = `${formatTime(slotStartIso)} - ${formatTime(slotEndIso)}`;
  bookingPageId = await createPage({
    실험명: title("DEMO · Notion 연동 검증 실험"),
    프로젝트: rt("NotionDemo"),
    실험날짜: { date: { start: kstDate } },
    시간: rt(timeRange),
    "피험자 ID": rt("Sbj1"),
    회차: { number: 1 },
    참여자: rt("홍길동(DEMO)"),
    "공개 ID": rt("CSNL-DEMO01"),
    상태: { select: { name: "확정" } },
  });
  console.log(`  ✓ page_id = ${bookingPageId}`);
} catch (err) {
  console.error(`  ✗ ${err.message}`);
}

// ── Phase 3 ──
console.log("\n── Phase 3: upsertObservationPage (Pre/Post Survey + 특이사항 PATCH) ──");
if (bookingPageId) {
  try {
    await patchPage(bookingPageId, {
      "Pre-Survey 완료": { checkbox: true },
      "Pre-Survey 정보": rt("색각 이상 없음, 안경 착용 중, 최근 24h 내 알코올 섭취 없음."),
      "Post-Survey 완료": { checkbox: true },
      "Post-Survey 정보": rt("실험 자극에 대한 피로도 보통. 3회차 블록에서 집중력 저하 보고."),
      특이사항: rt("B17 trial 도중 프로젝터 동기화 1회 드리프트, 즉시 재정렬."),
      "공개 ID": rt("CSNL-DEMO01"),
      상태: { select: { name: "완료" } },
    });
    console.log(`  ✓ PATCH ok — same page_id`);
  } catch (err) {
    console.error(`  ✗ ${err.message}`);
  }
} else {
  console.log("  (skipped: Phase 2 produced no booking page)");
}

console.log("\n── Summary ──");
console.log(`Experiment master page : ${expPageId ?? "FAIL"}`);
console.log(`Booking session page   : ${bookingPageId ?? "FAIL"}`);
console.log(`Database URL           : https://www.notion.so/${DB_ID.replace(/-/g, "")}`);
