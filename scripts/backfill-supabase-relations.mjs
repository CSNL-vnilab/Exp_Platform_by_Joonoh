#!/usr/bin/env node
// Phase 3 of the 2026 calendar backfill: update Supabase rows so future
// Notion writes (via the Relation columns added in migration 00043)
// populate correctly.
//
// Two updates:
//   * experiments.notion_project_page_id — match by project_name (or
//     title) against the Notion Projects & Chores pages we just
//     created / that already existed.
//   * profiles.notion_member_page_id — match by the login email's
//     local part (e.g. jop@lab.local → JOP in Members DB). Case-
//     insensitive; skip profiles with no obvious initial signal.
//
// Dry-run by default; pass --confirm to write.

import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";

const envText = await readFile(".env.local", "utf8");
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
}

const reportText = await readFile(
  ".test-artifacts/calendar-consistency-report.json",
  "utf8",
);
const report = JSON.parse(reportText);
const confirm = process.argv.includes("--confirm");

const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

// ── experiments ↔ projects ──
const { data: expRows } = await supa
  .from("experiments")
  .select("id, title, project_name, notion_project_page_id");
console.log(`Supabase experiments: ${expRows?.length ?? 0}`);

const expLinkage = [];
for (const e of expRows ?? []) {
  if (e.notion_project_page_id) {
    expLinkage.push({
      experiment_id: e.id,
      title: e.title,
      project_name: e.project_name,
      action: "SKIP",
      reason: "already linked",
      existing: e.notion_project_page_id,
    });
    continue;
  }
  // Match by exact project_name first, then title.
  const canon = (s) => (s ?? "").trim().toLowerCase().replace(/[\s\-_]+/g, "-");
  const eCanon = canon(e.project_name) || canon(e.title);
  let target = null;
  for (const [pname, v] of Object.entries(report.projects_map)) {
    if (v.status !== "MATCH") continue;
    if (canon(pname) === eCanon) {
      target = { name: pname, page_id: v.page_id };
      break;
    }
  }
  if (target) {
    expLinkage.push({
      experiment_id: e.id,
      title: e.title,
      project_name: e.project_name,
      action: "LINK",
      project_name_match: target.name,
      notion_project_page_id: target.page_id,
    });
  } else {
    expLinkage.push({
      experiment_id: e.id,
      title: e.title,
      project_name: e.project_name,
      action: "SKIP",
      reason: "no matching Notion project",
    });
  }
}

console.log("\n── experiments → Notion Projects ──");
for (const l of expLinkage) {
  console.log(
    `  ${l.action.padEnd(4)} ${(l.title ?? "").slice(0, 30).padEnd(30)} project_name=${l.project_name ?? ""}${
      l.action === "LINK" ? ` → ${l.project_name_match}` : ` (${l.reason})`
    }`,
  );
}

// ── profiles ↔ members ──
const { data: profRows } = await supa
  .from("profiles")
  .select("id, email, display_name, notion_member_page_id");

// Build an initial → Notion page_id map from the report.
const initialsMap = {};
for (const [k, v] of Object.entries(report.initials_map)) {
  if (v.status === "MATCH") initialsMap[k] = v.page_id;
}

const profLinkage = [];
for (const p of profRows ?? []) {
  if (p.notion_member_page_id) {
    profLinkage.push({
      profile_id: p.id,
      email: p.email,
      action: "SKIP",
      reason: "already linked",
      existing: p.notion_member_page_id,
    });
    continue;
  }
  // Heuristic 1: email local part (upper).
  const local = (p.email ?? "").split("@")[0]?.toUpperCase();
  let hit = local && initialsMap[local] ? { initial: local, page_id: initialsMap[local] } : null;
  // Heuristic 2: display_name's Hangul first-letter initials? skip — we'd need
  // Korean romanization which is noisy. Defer to manual linking.

  if (hit) {
    profLinkage.push({
      profile_id: p.id,
      email: p.email,
      action: "LINK",
      initial: hit.initial,
      notion_member_page_id: hit.page_id,
    });
  } else {
    profLinkage.push({
      profile_id: p.id,
      email: p.email,
      display_name: p.display_name,
      action: "SKIP",
      reason: "no initial match from email local part",
    });
  }
}

console.log("\n── profiles → Notion Members ──");
for (const l of profLinkage) {
  console.log(
    `  ${l.action.padEnd(4)} ${(l.email ?? "").padEnd(30)} ${
      l.action === "LINK" ? `→ [${l.initial}] ${l.notion_member_page_id}` : `(${l.reason})`
    }`,
  );
}

const expToWrite = expLinkage.filter((l) => l.action === "LINK");
const profToWrite = profLinkage.filter((l) => l.action === "LINK");

console.log(
  `\nWill write: ${expToWrite.length} experiments, ${profToWrite.length} profiles.`,
);

if (!confirm) {
  console.log("(dry-run — pass --confirm to execute)");
  process.exit(0);
}

for (const l of expToWrite) {
  const { error } = await supa
    .from("experiments")
    .update({ notion_project_page_id: l.notion_project_page_id })
    .eq("id", l.experiment_id);
  console.log(
    `  ${error ? "✗" : "✓"} exp ${l.experiment_id.slice(0, 8)} → ${l.notion_project_page_id}${error ? ` ${error.message}` : ""}`,
  );
}

for (const l of profToWrite) {
  const { error } = await supa
    .from("profiles")
    .update({ notion_member_page_id: l.notion_member_page_id })
    .eq("id", l.profile_id);
  console.log(
    `  ${error ? "✗" : "✓"} profile ${l.profile_id.slice(0, 8)} → ${l.notion_member_page_id}${error ? ` ${error.message}` : ""}`,
  );
}

console.log("Done.");
