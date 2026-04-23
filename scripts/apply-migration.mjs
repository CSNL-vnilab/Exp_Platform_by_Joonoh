#!/usr/bin/env node
// Apply a .sql migration to the live Supabase project by hitting the
// pg-meta query endpoint that Supabase Studio uses. Requires service role.
//
// Usage: node scripts/apply-migration.mjs supabase/migrations/00024_xxx.sql

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envText = await readFile(join(__dirname, "..", ".env.local"), "utf8");
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing env");
  process.exit(1);
}

const file = process.argv[2];
if (!file) {
  console.error("Usage: apply-migration.mjs <sql file>");
  process.exit(1);
}

const sql = await readFile(file, "utf8");
console.log(`Applying ${file} (${sql.length} bytes)`);

// Try the pg-meta endpoint first (Supabase Studio uses this).
const endpoints = [
  `${url}/pg-meta/default/query`,
  `${url}/pg/meta/default/query`,
];
let ok = false;
for (const ep of endpoints) {
  const res = await fetch(ep, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: sql }),
  });
  const body = await res.text();
  console.log(`${ep} → ${res.status}`);
  if (res.ok) {
    console.log(body.slice(0, 500));
    ok = true;
    break;
  } else {
    console.log(body.slice(0, 500));
  }
}

if (!ok) {
  console.error("\n❌ Could not apply migration via HTTP. Supabase CLI or SQL Editor is required.");
  process.exit(1);
}
console.log("✅ Applied");
