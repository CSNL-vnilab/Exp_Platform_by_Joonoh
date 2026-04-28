#!/usr/bin/env node
// Auto-evolution loop — read-only orchestrator.
//
// Periodically runs the existing audit / consistency checks, gathers
// operational signals from the DB, and writes one priority-ranked
// markdown report at docs/auto-evolution/AE-{date}.md.
//
// Read-only by design. Auto-applying schema/UI changes is too risky for
// this codebase right now; the goal of this script is to make "what
// should we improve next?" cheap to answer, not to act on its own.
//
// Run:   node scripts/auto-evolution.mjs
// Out:   docs/auto-evolution/AE-{YYYY-MM-DD}.md
//        + console summary

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

// ── env ───────────────────────────────────────────────────────────────
const env = await readFile(".env.local", "utf8").catch(() => "");
for (const l of env.split("\n")) {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
}

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const TODAY = new Date().toISOString().slice(0, 10);
const OUT_DIR = "docs/auto-evolution";
const OUT_FILE = `${OUT_DIR}/AE-${TODAY}.md`;

// ── child process helper ──────────────────────────────────────────────
function runScript(name, args = []) {
  return new Promise((resolve) => {
    let stdout = "", stderr = "";
    const proc = spawn("node", [`scripts/${name}`, ...args], { env: process.env });
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    proc.on("error", (err) => resolve({ code: -1, stdout, stderr: String(err) }));
  });
}

// ── 1. DB metrics ─────────────────────────────────────────────────────
async function gatherMetrics() {
  const m = {};
  const { data: exps } = await sb.from("experiments").select("id, status, protocol_version, location_id, participation_fee, description, created_at");
  m.experiments_total = exps?.length ?? 0;
  m.experiments_by_status = {};
  m.experiments_backfill = 0;
  m.experiments_missing_protocol_version = 0;
  m.experiments_missing_location = 0;
  m.experiments_zero_fee = 0;
  for (const e of exps ?? []) {
    m.experiments_by_status[e.status] = (m.experiments_by_status[e.status] ?? 0) + 1;
    if (e.description?.startsWith("[백필]")) m.experiments_backfill += 1;
    if (!e.protocol_version) m.experiments_missing_protocol_version += 1;
    if (!e.location_id) m.experiments_missing_location += 1;
    if (e.participation_fee == null || e.participation_fee === 0) m.experiments_zero_fee += 1;
  }

  const { data: bks } = await sb.from("bookings").select("id, status, google_event_id");
  m.bookings_total = bks?.length ?? 0;
  m.bookings_by_status = {};
  m.bookings_no_event_id = 0;
  for (const b of bks ?? []) {
    m.bookings_by_status[b.status] = (m.bookings_by_status[b.status] ?? 0) + 1;
    if (!b.google_event_id) m.bookings_no_event_id += 1;
  }

  const { data: parts } = await sb.from("participants").select("id, name, phone, email");
  m.participants_total = parts?.length ?? 0;
  m.participants_blank_phone = (parts ?? []).filter((p) => !p.phone || p.phone === "").length;
  m.participants_placeholder_email = (parts ?? []).filter((p) => /@-$|@no-email\.local$/.test(p.email ?? "")).length;
  // Detect potentially-duplicated rows: same Korean-name normalized.
  const norm = (s) => (s ?? "").normalize("NFC").replace(/[​‌‍⁠­﻿]/g, "").trim().toLowerCase();
  const groups = new Map();
  for (const p of parts ?? []) {
    const k = norm(p.name);
    if (!k) continue;
    const list = groups.get(k) ?? [];
    list.push(p);
    groups.set(k, list);
  }
  m.participants_dup_groups = [];
  for (const [k, list] of groups) {
    if (list.length > 1) m.participants_dup_groups.push({ key: k, ids: list.map((p) => p.id), count: list.length });
  }

  return m;
}

// ── 2. derive findings + recommendations ─────────────────────────────
function deriveFindings(m, dbAudit, calCheck) {
  const findings = [];
  // priority 1 — data integrity
  if (m.bookings_no_event_id > 0) {
    findings.push({ priority: 1, area: "data-integrity",
      title: `${m.bookings_no_event_id} bookings have no google_event_id`,
      detail: "Most pre-dashboard rows pre-date GCal sync; fine for historical, but new bookings should always carry one.",
      action: "Audit any UI flow that inserts a booking without firing the GCal create + reading the returned id." });
  }
  if (dbAudit?.code !== 0) {
    findings.push({ priority: 1, area: "schema",
      title: "db-audit reported failures",
      detail: dbAudit?.stdout?.split("\n").filter((l) => /CRITICAL|FAIL|✗|❌/.test(l)).slice(0, 5).join("\n") || "(see scripts/db-audit.mjs output)",
      action: "Fix the CRITICAL findings first. Re-run `npm run db-audit` until exit 0." });
  }
  // priority 2 — backfill / metadata coverage
  if (m.experiments_missing_protocol_version > 0) {
    findings.push({ priority: 2, area: "metadata",
      title: `${m.experiments_missing_protocol_version}/${m.experiments_total} experiments lack protocol_version`,
      detail: "Critical for downstream analysis reproducibility.",
      action: "Trigger /api/cron/metadata-reminders (auto for draft/active) + scripts/notify-backfill-researchers.mjs (for completed backfill)." });
  }
  if (m.experiments_backfill > 0 && m.experiments_missing_location > 0) {
    findings.push({ priority: 2, area: "metadata",
      title: `${m.experiments_missing_location} experiments missing location_id`,
      detail: "Backfill-imported experiments don't have a calendar location field; researchers must pick after-the-fact.",
      action: "Add a `[백필]` filter + bulk-edit affordance in /admin/experiments." });
  }
  // priority 3 — participant cleanup
  if (m.participants_dup_groups.length > 0) {
    const top = m.participants_dup_groups.slice(0, 5).map((g) => `${g.key}(×${g.count})`).join(", ");
    findings.push({ priority: 3, area: "participants",
      title: `${m.participants_dup_groups.length} duplicate participant name groups`,
      detail: `Top: ${top}. Common cause: same person listed in Korean + English transliteration (e.g. 이보현 vs bohyun lee).`,
      action: "Resolve via the participant detail page → 병합 버튼 (admin only). Endpoint: POST /api/participants/{sourceId}/merge {targetId}." });
  }
  if (m.participants_placeholder_email > 0) {
    findings.push({ priority: 3, area: "participants",
      title: `${m.participants_placeholder_email} participants have placeholder emails`,
      detail: "These are backfill rows with no real contact info. UI should display these as '연락처 없음' rather than the raw slug.",
      action: "In components/participant-detail.tsx, detect '/@-$|@no-email\\.local$/' and render an empty state." });
  }
  // priority 4 — calendar drift
  if (calCheck?.report?.researcher_decisions?.length > 0) {
    findings.push({ priority: 4, area: "calendar-sync",
      title: `${calCheck.report.researcher_decisions.length} unresolved calendar-DB mappings`,
      detail: "Items in researcher_decisions[] need a human call (unknown initial, unmatched project, etc.).",
      action: "Open .test-artifacts/calendar-consistency-report.json and resolve each entry." });
  }
  return findings.sort((a, b) => a.priority - b.priority);
}

// ── 3. suggested rules / UX hints (curated, evolving over time) ──────
function curatedSuggestions(m) {
  const rules = [
    "**Backfill marker invariant**: every experiment whose `description` starts with `[백필]` MUST eventually get a `protocol_version`. Add a CHECK constraint or a soft warning in the dashboard.",
    "**Participant name canonicalisation**: enforce NFC + zero-width strip on `participants.name` at write time (DB trigger or Zod schema).",
    "**Booking → calendar invariant**: a booking with status='confirmed'|'completed' SHOULD have a non-null google_event_id once GCal is healthy. Surface violations in the dashboard.",
    "**Draft staleness rule**: experiments stuck in `status='draft'` for >30 days get a weekly reminder (extend metadata-reminders cron).",
  ];
  const ux = [
    "Dashboard: badge `[백필]` experiments distinctly so researchers immediately see what needs review.",
    "Participants page: collapse name-duplicate groups visually + offer a 'merge' action.",
    "Experiment detail: when a field is in the placeholder zone (e.g. `participation_fee=0` on a completed experiment), highlight it amber, not as if it were a real value.",
    "Calendar-import UI: a one-shot wizard that runs the same logic as scripts/import-byl-smj-bhl-2026.mjs but with researcher-driven approval per row.",
  ];
  return { rules, ux };
}

// ── 4. write the report ──────────────────────────────────────────────
async function writeReport(metrics, findings, suggestions, dbAudit, calCheck, prevDate) {
  await mkdir(OUT_DIR, { recursive: true });
  const lines = [];
  lines.push(`# Auto-Evolution Report — ${TODAY}`);
  lines.push("");
  lines.push("Read-only health snapshot + priority-ranked next actions.");
  lines.push(`Generated: ${new Date().toISOString()}`);
  if (prevDate) lines.push(`Prior report: \`AE-${prevDate}.md\`. Compare deltas manually.`);
  lines.push("");
  lines.push("## 1. State");
  lines.push("");
  lines.push(`- Experiments: **${metrics.experiments_total}** (${Object.entries(metrics.experiments_by_status).map(([k,v])=>`${k}=${v}`).join(", ")})`);
  lines.push(`- Bookings: **${metrics.bookings_total}** (${Object.entries(metrics.bookings_by_status).map(([k,v])=>`${k}=${v}`).join(", ")})`);
  lines.push(`- Participants: **${metrics.participants_total}** (placeholder email: ${metrics.participants_placeholder_email}, blank phone: ${metrics.participants_blank_phone})`);
  lines.push(`- Backfilled experiments (\`[백필]\` prefix): **${metrics.experiments_backfill}**`);
  lines.push(`- Coverage gaps: protocol_version=null in **${metrics.experiments_missing_protocol_version}** of ${metrics.experiments_total}; location=null in ${metrics.experiments_missing_location}; fee=0 in ${metrics.experiments_zero_fee}`);
  lines.push(`- Bookings without google_event_id: ${metrics.bookings_no_event_id}`);
  lines.push(`- Duplicate participant name groups: ${metrics.participants_dup_groups.length}`);
  lines.push("");
  lines.push("## 2. Audit script results");
  lines.push("");
  lines.push(`- \`db-audit.mjs\`: exit ${dbAudit.code} ${dbAudit.code === 0 ? "✓" : "✗"}`);
  lines.push(`- \`calendar-consistency-check.mjs\`: exit ${calCheck.code} ${calCheck.code === 0 ? "✓" : "✗"}`);
  if (calCheck.report) {
    lines.push(`  - parsed_events: ${calCheck.report.parsed_events?.length ?? "?"}`);
    lines.push(`  - researcher_decisions to resolve: ${calCheck.report.researcher_decisions?.length ?? "?"}`);
  }
  lines.push("");
  lines.push("## 3. Findings (priority-ranked)");
  lines.push("");
  if (findings.length === 0) {
    lines.push("_No findings beyond the curated suggestions below._");
  } else {
    for (const f of findings) {
      lines.push(`### P${f.priority} · ${f.area} · ${f.title}`);
      lines.push("");
      lines.push(`- **Detail**: ${f.detail}`);
      lines.push(`- **Action**: ${f.action}`);
      lines.push("");
    }
  }
  lines.push("## 4. Suggested rules (DB / invariants)");
  lines.push("");
  for (const r of suggestions.rules) lines.push(`- ${r}`);
  lines.push("");
  lines.push("## 5. Suggested UI/UX improvements");
  lines.push("");
  for (const u of suggestions.ux) lines.push(`- ${u}`);
  lines.push("");
  lines.push("## 6. Duplicate participant name groups (raw)");
  lines.push("");
  if (metrics.participants_dup_groups.length === 0) {
    lines.push("_(none)_");
  } else {
    lines.push("| name (normalized) | count | row IDs (first 8 chars) |");
    lines.push("|---|---|---|");
    for (const g of metrics.participants_dup_groups.slice(0, 30)) {
      lines.push(`| ${g.key} | ${g.count} | ${g.ids.map((i)=>i.slice(0,8)).join(", ")} |`);
    }
    if (metrics.participants_dup_groups.length > 30) {
      lines.push(`| _… ${metrics.participants_dup_groups.length - 30} more_ | | |`);
    }
  }
  lines.push("");
  lines.push("---");
  lines.push("Generated by `scripts/auto-evolution.mjs` — read-only.");
  await writeFile(OUT_FILE, lines.join("\n"), "utf8");
}

// ── main ─────────────────────────────────────────────────────────────
console.log(`Auto-evolution sweep — ${TODAY}`);
console.log("─".repeat(60));

console.log("• gathering DB metrics …");
const metrics = await gatherMetrics();
console.log(`  ${metrics.experiments_total} exps / ${metrics.bookings_total} bookings / ${metrics.participants_total} participants`);

console.log("• running db-audit …");
const dbAudit = await runScript("db-audit.mjs");
console.log(`  exit ${dbAudit.code}`);

console.log("• running calendar-consistency-check …");
const calCheck = await runScript("calendar-consistency-check.mjs");
let calReport = null;
const reportPath = ".test-artifacts/calendar-consistency-report.json";
if (existsSync(reportPath)) {
  try { calReport = JSON.parse(await readFile(reportPath, "utf8")); }
  catch { /* ignore */ }
}
console.log(`  exit ${calCheck.code}, report ${calReport ? "loaded" : "absent"}`);

const findings = deriveFindings(metrics, dbAudit, { ...calCheck, report: calReport });
const suggestions = curatedSuggestions(metrics);

// Find prior report (most recent dated file in OUT_DIR)
let prevDate = null;
try {
  const { readdir } = await import("node:fs/promises");
  if (existsSync(OUT_DIR)) {
    const files = (await readdir(OUT_DIR)).filter((f) => /^AE-\d{4}-\d{2}-\d{2}\.md$/.test(f) && f !== `AE-${TODAY}.md`).sort();
    if (files.length > 0) prevDate = files[files.length - 1].slice(3, 13);
  }
} catch { /* ignore */ }

await writeReport(metrics, findings, suggestions, dbAudit, { ...calCheck, report: calReport }, prevDate);
console.log(`\n✓ report written → ${OUT_FILE}`);
console.log(`  findings: ${findings.length}  suggested rules: ${suggestions.rules.length}  UI/UX hints: ${suggestions.ux.length}`);
