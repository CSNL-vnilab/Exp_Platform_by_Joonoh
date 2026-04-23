#!/usr/bin/env node
// Phase 2 of the 2026 calendar backfill: create Notion Projects & Chores
// pages for every project name observed in the calendar that doesn't
// already have a matching page.
//
// Reads .test-artifacts/calendar-consistency-report.json (produced by
// calendar-consistency-check.mjs). Acts on projects_map rows with
// status='MISS'. AMBIGUOUS-in-Notion rows are deliberately skipped — the
// researcher must dedupe the Notion DB manually before the backfill
// consumes them (see C3 in review of 2026-04-23: AMBIGUOUS rows used to
// silently fall through to null page_id).
//
// Dry-run by default. Pass --confirm to actually write.
//
// Also writes updated consistency notes back so subsequent backfill
// scripts can consume them.

import { readFile, writeFile } from "node:fs/promises";
import { canonProject } from "./lib/calendar-parse.mjs";

const envText = await readFile(".env.local", "utf8");
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
}

const PROJECTS_DB = "76e7c392-127e-47f3-8b7e-212610db9376";
const NOTION_TOKEN = process.env.NOTION_API_KEY;
const confirm = process.argv.includes("--confirm");

const reportText = await readFile(
  ".test-artifacts/calendar-consistency-report.json",
  "utf8",
).catch(() => null);
if (!reportText) {
  console.error(
    "Missing .test-artifacts/calendar-consistency-report.json — run scripts/calendar-consistency-check.mjs first.",
  );
  process.exit(1);
}
const report = JSON.parse(reportText);

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
      `notion ${method} ${path} ${r.status}: ${JSON.stringify(jbody).slice(0, 300)}`,
    );
  }
  return jbody;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Non-project markers — these come from meetings / admin events that
// happen to share the bracketed-initial shape, or from obvious typos.
// Skipped entirely — the upstream calendar event won't get a Notion
// booking page either (no project to link to).
const BLACKLIST = new Set(["meeting: SK", "Meeting: SK"]);

const CANONICAL_PICK = (variants) => {
  const sorted = [...variants].sort((a, b) => {
    const aTitle = /^[A-Z]/.test(a[0] ?? "");
    const bTitle = /^[A-Z]/.test(b[0] ?? "");
    if (aTitle !== bTitle) return aTitle ? -1 : 1;
    return a.length - b.length;
  });
  return sorted[0];
};

const missRaw = Object.entries(report.projects_map)
  .filter(([, v]) => v.status === "MISS")
  .map(([name]) => name);

// Group by canonical key so all variants (case, whitespace, dashes)
// collapse into a single Notion page creation.
const groups = new Map();
for (const name of missRaw) {
  if (BLACKLIST.has(name)) continue;
  const key = canonProject(name);
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(name);
}

const missing = [...groups.values()].map((vs) => ({
  canonical: CANONICAL_PICK(vs),
  variants: vs,
}));

console.log(`Unique missing projects after normalization: ${missing.length}`);
for (const m of missing) {
  console.log(
    `  · ${m.canonical}${
      m.variants.length > 1 ? `   (merges: ${m.variants.join(", ")})` : ""
    }`,
  );
}
const blacklisted = missRaw.filter((n) => BLACKLIST.has(n));
if (blacklisted.length > 0) {
  console.log(`\nBlacklisted (NOT created): ${blacklisted.join(", ")}`);
}

const ambiguousInNotion = Object.entries(report.projects_map)
  .filter(([, v]) => v.status === "AMBIGUOUS")
  .map(([name, v]) => ({ name, candidates: v.candidates }));
if (ambiguousInNotion.length > 0) {
  console.log(
    `\nAMBIGUOUS in Notion (${ambiguousInNotion.length}) — researcher must dedupe before linking:`,
  );
  for (const a of ambiguousInNotion) {
    console.log(
      `  · ${a.name}   ${a.candidates.map((c) => `"${c.title}" (${c.id.slice(0, 8)})`).join(" | ")}`,
    );
  }
}

if (!confirm) {
  console.log(`\n(dry-run — pass --confirm to actually create these ${missing.length} pages)`);
  process.exit(0);
}

console.log(`\nCreating ${missing.length} pages…`);
const created = [];
const failed = [];

for (let i = 0; i < missing.length; i++) {
  if (i > 0) await sleep(400); // Notion 3 rps
  const group = missing[i];
  try {
    const page = await notion("/pages", {
      parent: { database_id: PROJECTS_DB },
      properties: {
        항목명: { title: [{ text: { content: group.canonical } }] },
      },
    });
    created.push({ canonical: group.canonical, variants: group.variants, page_id: page.id });
    console.log(
      `  ✓ ${group.canonical}  ${page.id}${group.variants.length > 1 ? ` (covers ${group.variants.length} variants)` : ""}`,
    );
  } catch (err) {
    failed.push({ canonical: group.canonical, error: err.message });
    console.log(`  ✗ ${group.canonical}  ${err.message}`);
  }
}

console.log(`\nCreated ${created.length}, Failed ${failed.length}`);

// Update report: every variant name now points to the same canonical
// page_id so downstream booking backfill resolves correctly.
for (const c of created) {
  for (const variant of c.variants) {
    if (report.projects_map[variant]) {
      report.projects_map[variant] = {
        status: "MATCH",
        page_id: c.page_id,
        canonical_title: c.canonical,
        canon: canonProject(c.canonical),
        created_by_backfill: true,
      };
    }
  }
}
for (const name of blacklisted) {
  report.projects_map[name] = {
    status: "SKIP",
    reason: "blacklisted (non-project meeting/admin event)",
  };
}
await writeFile(
  ".test-artifacts/calendar-consistency-report.json",
  JSON.stringify(report, null, 2),
);
console.log("Report updated with new page ids.");
