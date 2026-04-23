import { createClient } from "@supabase/supabase-js";
import { readFile } from "node:fs/promises";
const env = await readFile(".env.local", "utf8");
for (const l of env.split("\n")) {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
}
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
// Probe each table that migrations add
const tables = [
  ["00022", "experiments", "code_repo_url"],          // add column
  ["00023", "experiment_run_progress", "id"],         // create table
  ["00024", "participant_payment_info", "id"],        // create table
  ["00024", "payment_claims", "id"],
  ["00025", "labs", "id"],
  ["00026", "booking_observations", "id"],
];
for (const [mig, table, col] of tables) {
  const { data, error } = await s.from(table).select(col).limit(1);
  console.log(`${mig} ${table}.${col}: ${error ? "MISSING — " + error.message.slice(0,80) : "OK"}`);
}
