#!/usr/bin/env node
// Apply a .sql migration to the hosted Supabase project via the Management
// API (api.supabase.com/v1/projects/{ref}/database/query). The self-hosted
// pg-meta endpoint used by apply-migration.mjs is not exposed on Supabase
// Cloud, so this script takes its place for prod.
//
// Requires SUPABASE_ACCESS_TOKEN (personal access token from
// https://supabase.com/dashboard/account/tokens) and NEXT_PUBLIC_SUPABASE_URL
// (project ref is extracted from the hostname).
//
// Usage: node scripts/apply-migration-mgmt.mjs supabase/migrations/XXXX.sql

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envText = await readFile(join(__dirname, "..", ".env.local"), "utf8");
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
}

const token = process.env.SUPABASE_ACCESS_TOKEN;
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
if (!token || !url) {
  console.error("Missing SUPABASE_ACCESS_TOKEN or NEXT_PUBLIC_SUPABASE_URL");
  process.exit(1);
}

const refMatch = url.match(/https?:\/\/([a-z0-9]+)\.supabase\.co/i);
if (!refMatch) {
  console.error("Could not extract project ref from NEXT_PUBLIC_SUPABASE_URL");
  process.exit(1);
}
const ref = refMatch[1];

const file = process.argv[2];
if (!file) {
  console.error("Usage: apply-migration-mgmt.mjs <sql file>");
  process.exit(1);
}

const sql = await readFile(file, "utf8");
console.log(`Applying ${file} (${sql.length} bytes) → ${ref}`);

const endpoint = `https://api.supabase.com/v1/projects/${ref}/database/query`;
const res = await fetch(endpoint, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ query: sql }),
});

const body = await res.text();
console.log(`HTTP ${res.status}`);
if (res.ok) {
  // Body is usually "[]" for DDL-only migrations, or a JSON array of rows.
  console.log(body.slice(0, 2000));
  console.log("✅ Applied");
  process.exit(0);
}

console.error(body.slice(0, 2000));
process.exit(1);
