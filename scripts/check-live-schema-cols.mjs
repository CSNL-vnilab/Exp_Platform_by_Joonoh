#!/usr/bin/env node
import { createClient } from "@supabase/supabase-js";
import { readFile } from "node:fs/promises";

const env = await readFile(".env.local", "utf8");
for (const l of env.split("\n")) {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
}
const s = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

async function sample(table) {
  const { data, error } = await s.from(table).select("*").limit(1);
  if (error) {
    console.log(`${table}: ERROR ${error.message}`);
    return;
  }
  if (!data || data.length === 0) {
    console.log(`${table}: empty`);
    return;
  }
  console.log(`${table}: keys = ${Object.keys(data[0]).join(", ")}`);
}

for (const t of ["experiments", "participants", "bookings", "labs", "profiles", "participant_payment_info"]) {
  await sample(t);
}
