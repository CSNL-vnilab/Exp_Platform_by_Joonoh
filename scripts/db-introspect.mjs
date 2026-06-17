// Read-only prod schema introspection via the Supabase management API.
// Usage:  node --env-file=.env.local scripts/db-introspect.mjs "SELECT ..."
//
// Built for migration-drift detection: the prod migration ledger
// (supabase_migrations.schema_migrations) is unreliable because some
// migrations were applied out-of-band via the management API (never recorded)
// and at least one renumber collision left a ledger row whose DDL never ran
// (00065 → see migration 00076). So "is this object actually IN prod?" must be
// answered by introspecting information_schema / pg_catalog directly, not by
// trusting the ledger.
//
// SAFETY: refuses anything that isn't a single read-only SELECT/WITH/EXPLAIN /
// SHOW / TABLE statement. No INSERT/UPDATE/DELETE/ALTER/CREATE/DROP/TRUNCATE/
// GRANT/COMMENT/NOTIFY — this script is for INSPECTION only, so it can be run
// freely by audit agents without risk of a prod mutation.
import { readFile } from "node:fs/promises";

const sql = process.argv.slice(2).join(" ").trim();
if (!sql) {
  console.error('usage: node --env-file=.env.local scripts/db-introspect.mjs "SELECT ..."');
  process.exit(1);
}

// Reject multi-statement and non-read-only input.
const withoutStrings = sql.replace(/'(?:[^']|'')*'/g, "''").replace(/--.*$/gm, "");
const stmts = withoutStrings.split(";").map((s) => s.trim()).filter(Boolean);
if (stmts.length > 1) {
  console.error("Refusing: only a single statement is allowed (no ';'-separated batches).");
  process.exit(2);
}
if (!/^(select|with|explain|show|table)\b/i.test(stmts[0])) {
  console.error(`Refusing: read-only only. Statement starts with "${stmts[0].split(/\s+/)[0]}".`);
  process.exit(2);
}
if (/\b(insert|update|delete|alter|create|drop|truncate|grant|revoke|comment|notify|call|do|merge)\b/i.test(stmts[0])) {
  console.error("Refusing: a write/DDL keyword appears in the statement.");
  process.exit(2);
}

const env = await readFile(new URL("../.env.local", import.meta.url), "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
}
const token = process.env.SUPABASE_ACCESS_TOKEN;
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
if (!token || !url) {
  console.error("Missing SUPABASE_ACCESS_TOKEN or NEXT_PUBLIC_SUPABASE_URL in .env.local");
  process.exit(1);
}
const ref = url.match(/https?:\/\/([a-z0-9]+)\.supabase\.co/i)?.[1];
if (!ref) {
  console.error("Could not extract project ref from NEXT_PUBLIC_SUPABASE_URL");
  process.exit(1);
}

const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: sql }),
});
const body = await res.text();
if (!res.ok) {
  console.error(`HTTP ${res.status}: ${body.slice(0, 1000)}`);
  process.exit(1);
}
// Pretty-print rows as JSON for easy consumption by audit tooling/agents.
try {
  console.log(JSON.stringify(JSON.parse(body), null, 2));
} catch {
  console.log(body);
}
