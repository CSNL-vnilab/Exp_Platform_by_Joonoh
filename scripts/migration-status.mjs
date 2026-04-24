#!/usr/bin/env node
// Lists every migration file in supabase/migrations/ and flags the
// ones that ops-playbook.md still marks as NOT applied (based on the
// "Last applied to prod" line + the explicit "NOT applied" block).
//
// Also warns when sidecar docs (improvement-roadmap.md, next-sprints.md)
// still refer to a migration as pending / not-yet-applied when the
// playbook's "Last applied" marker has already passed it. Humans
// grepping those docs otherwise get misled.
//
// Run this before a deploy to see which migrations the operator still
// needs to push via `node scripts/apply-migration-mgmt.mjs`.
//
// Usage: node scripts/migration-status.mjs
//
// Exit code:
//   0 — no pending migrations and no stale sidecar mentions
//   1 — pending migrations exist, OR sidecar docs have stale mentions
//   2 — doc couldn't be parsed

import { readdir, readFile } from "node:fs/promises";

const MIGRATIONS_DIR = "supabase/migrations";
const PLAYBOOK = "docs/ops-playbook.md";
const SIDECAR_DOCS = [
  "docs/improvement-roadmap.md",
  "docs/next-sprints.md",
  "docs/stream2-notes.md",
];
// Lines that claim a migration is pending. Kept narrow to avoid
// catching "pending-work" (the feature name).
const STALE_PHRASE_RE =
  /not yet applied|ready but not.*applied|pending migration apply|staged for next deploy|on disk but NOT applied/i;

function extractNumber(filename) {
  const m = filename.match(/^(\d{5})_/);
  return m ? parseInt(m[1], 10) : null;
}

const files = (await readdir(MIGRATIONS_DIR))
  .filter((f) => f.endsWith(".sql"))
  .sort();

if (files.length === 0) {
  console.error("No migrations found in", MIGRATIONS_DIR);
  process.exit(2);
}

let playbook;
try {
  playbook = await readFile(PLAYBOOK, "utf8");
} catch {
  console.error("Could not read", PLAYBOOK);
  process.exit(2);
}

// Parse "Last applied to prod: `00043_...sql` on 2026-04-23."
const lastAppliedMatch = playbook.match(
  /Last applied(?: to prod)?:\s*`(\d{5})_[^`]*\.sql`/,
);
const lastAppliedNum = lastAppliedMatch ? parseInt(lastAppliedMatch[1], 10) : null;

// Explicit "NOT applied" / "still on disk but NOT applied" filenames —
// parse anything referenced as a filename in a "NOT applied" context.
const notAppliedRefs = new Set();
for (const line of playbook.split("\n")) {
  if (/NOT applied|still on disk/i.test(line)) {
    const re = /`?(\d{5}_[a-z0-9_]+\.sql)`?/gi;
    let match;
    while ((match = re.exec(line)) !== null) {
      notAppliedRefs.add(match[1]);
    }
  }
}

console.log("Migration status (based on docs/ops-playbook.md)");
console.log(
  "  Disk has:",
  files.length,
  "migrations (highest:",
  files[files.length - 1] + ")",
);
console.log(
  "  Doc claims last applied:",
  lastAppliedMatch ? lastAppliedMatch[1] : "(parse failed)",
);
console.log("");

const pending = [];
const excluded = [];
for (const f of files) {
  const n = extractNumber(f);
  if (n == null) continue;
  if (lastAppliedNum != null && n > lastAppliedNum) {
    pending.push(f);
  } else if (notAppliedRefs.has(f)) {
    excluded.push(f);
  }
}

if (pending.length > 0) {
  console.log(`Pending apply to prod (${pending.length}):`);
  for (const f of pending) {
    const tag = notAppliedRefs.has(f) ? " [documented]" : "";
    console.log(`  · ${f}${tag}`);
  }
  console.log("");
  console.log("To apply:");
  for (const f of pending) {
    console.log(`  node scripts/apply-migration-mgmt.mjs ${MIGRATIONS_DIR}/${f}`);
  }
}

if (excluded.length > 0) {
  console.log(`\nOlder than 'last applied' but docs flag as NOT applied (${excluded.length}):`);
  for (const f of excluded) console.log(`  · ${f}`);
}

// Sidecar doc staleness scan. We emit warnings (and flip exit to 1)
// when a sidecar mentions "not yet applied" in a line that references
// a migration number ≤ lastAppliedNum, since that claim is now false.
const staleHits = [];
if (lastAppliedNum != null) {
  for (const docPath of SIDECAR_DOCS) {
    let text;
    try {
      text = await readFile(docPath, "utf8");
    } catch {
      continue; // sidecar doc is optional
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!STALE_PHRASE_RE.test(line)) continue;
      const nums = [...line.matchAll(/(\d{5})(?:_[a-z0-9_]+)?/gi)]
        .map((m) => parseInt(m[1], 10))
        .filter((n) => !Number.isNaN(n));
      for (const n of nums) {
        if (n <= lastAppliedNum && !notAppliedRefs.has(`${String(n).padStart(5, "0")}_`)) {
          staleHits.push({ doc: docPath, line: i + 1, n, text: line.trim() });
        }
      }
    }
  }
}

if (staleHits.length > 0) {
  console.log(`\nStale sidecar mentions (${staleHits.length}):`);
  for (const h of staleHits) {
    console.log(`  · ${h.doc}:${h.line} — refs ${h.n} but playbook says last applied is ${lastAppliedNum}`);
    console.log(`      "${h.text.slice(0, 110)}${h.text.length > 110 ? "…" : ""}"`);
  }
}

if (pending.length === 0 && excluded.length === 0 && staleHits.length === 0) {
  console.log("✓ All migrations on disk are applied (per docs/ops-playbook.md) and sidecar docs are in sync.");
  process.exit(0);
}

process.exit(1);
