#!/usr/bin/env node
// Systematic Notion database setup / verification.
//
// docs/notion-db-template.md describes 18 required properties. This script:
//   1. Fetches the current database schema
//   2. Renames the title column to 실험명 if it isn't already
//   3. Idempotently PATCHes missing properties with the exact names and
//      types the template requires
//   4. Re-fetches and prints a human-readable diff
//
// Usage: NOTION_API_KEY=<token> NOTION_DATABASE_ID=<id> node scripts/notion-setup.mjs
// or just: node scripts/notion-setup.mjs (reads from .env.local)

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

async function fetchDb() {
  const r = await fetch(`https://api.notion.com/v1/databases/${DB_ID}`, {
    headers,
  });
  if (!r.ok) {
    console.error(`GET database failed: ${r.status}`, await r.text());
    process.exit(1);
  }
  return r.json();
}

// Target schema — names must match docs/notion-db-template.md EXACTLY.
// The title property has special semantics: Notion requires exactly one,
// and you can rename it but not add/remove it after creation.
const TITLE_NAME = "실험명";
const DESIRED = [
  { name: "프로젝트", type: "rich_text" },
  { name: "실험날짜", type: "date" },
  { name: "시간", type: "rich_text" },
  { name: "피험자 ID", type: "rich_text" },
  { name: "회차", type: "number" },
  { name: "참여자", type: "rich_text" },
  { name: "공개 ID", type: "rich_text" },
  {
    name: "상태",
    type: "select",
    options: ["확정", "취소", "완료", "no_show"],
  },
  { name: "Pre-Survey 완료", type: "checkbox" },
  { name: "Pre-Survey 정보", type: "rich_text" },
  { name: "Post-Survey 완료", type: "checkbox" },
  { name: "Post-Survey 정보", type: "rich_text" },
  { name: "특이사항", type: "rich_text" },
  { name: "Code Directory", type: "rich_text" },
  { name: "Data Directory", type: "rich_text" },
  { name: "Parameter", type: "rich_text" },
  { name: "Notes", type: "rich_text" },
];

function buildPropertyPayload(spec) {
  switch (spec.type) {
    case "rich_text":
      return { rich_text: {} };
    case "number":
      return { number: { format: "number" } };
    case "date":
      return { date: {} };
    case "checkbox":
      return { checkbox: {} };
    case "select":
      return {
        select: {
          options: (spec.options ?? []).map((name) => ({ name })),
        },
      };
    default:
      throw new Error(`Unhandled prop type: ${spec.type}`);
  }
}

async function patchDb(properties) {
  const r = await fetch(`https://api.notion.com/v1/databases/${DB_ID}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ properties }),
  });
  if (!r.ok) {
    console.error(`PATCH failed: ${r.status}`, await r.text());
    process.exit(1);
  }
  return r.json();
}

// ── Step 1: inspect
const before = await fetchDb();
const current = before.properties;
const currentNames = Object.keys(current);
console.log(`[Before] title='${before.title?.[0]?.plain_text ?? ""}' props=${currentNames.length}`);
for (const n of currentNames) console.log(`  · ${n} (${current[n].type})`);

// ── Step 2: rename title if needed
const titleName = currentNames.find((n) => current[n].type === "title");
if (titleName && titleName !== TITLE_NAME) {
  console.log(`\n[Rename title] '${titleName}' → '${TITLE_NAME}'`);
  await patchDb({
    [titleName]: { name: TITLE_NAME },
  });
}

// ── Step 3: add missing properties one-by-one so any single failure (wrong
//           type, etc.) doesn't block the rest.
const missing = DESIRED.filter((d) => !currentNames.includes(d.name));
const mismatched = DESIRED.filter(
  (d) => currentNames.includes(d.name) && current[d.name].type !== d.type,
);
if (mismatched.length > 0) {
  console.warn(
    `\n[Type mismatch] Existing columns whose type differs (not auto-fixed):`,
  );
  for (const m of mismatched) {
    console.warn(`  - ${m.name}: expected ${m.type}, found ${current[m.name].type}`);
  }
}

console.log(`\n[Add missing] ${missing.length} properties`);
for (const spec of missing) {
  const payload = { [spec.name]: buildPropertyPayload(spec) };
  const r = await fetch(`https://api.notion.com/v1/databases/${DB_ID}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ properties: payload }),
  });
  if (r.ok) {
    console.log(`  ✓ ${spec.name} (${spec.type})`);
  } else {
    const body = await r.text();
    console.log(`  ✗ ${spec.name} — ${r.status} ${body.slice(0, 200)}`);
  }
}

// ── Step 4: verify
const after = await fetchDb();
const afterProps = Object.keys(after.properties).sort();
console.log(`\n[After] ${afterProps.length} props`);
const desiredSet = new Set([TITLE_NAME, ...DESIRED.map((d) => d.name)]);
const have = afterProps.filter((n) => desiredSet.has(n));
const extra = afterProps.filter((n) => !desiredSet.has(n));
const stillMissing = [...desiredSet].filter((n) => !afterProps.includes(n));

console.log(`  present  : ${have.length}/${desiredSet.size}`);
console.log(`  missing  : ${stillMissing.join(", ") || "(none)"}`);
console.log(`  extra    : ${extra.join(", ") || "(none)"}`);
process.exit(stillMissing.length === 0 ? 0 : 1);
