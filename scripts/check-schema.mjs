import { createClient } from "@supabase/supabase-js";
import { readFile } from "node:fs/promises";
const envText = await readFile(".env.local", "utf8");
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
}
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);
const checks = [
  "participant_payment_info",
  "payment_exports",
  "payment_claims",
  "experiment_run_progress",
  "experiments",
  "bookings",
];
for (const table of checks) {
  const { error } = await supabase.from(table).select("*").limit(1);
  console.log(`${table}: ${error ? "MISSING (" + error.message + ")" : "OK"}`);
}
