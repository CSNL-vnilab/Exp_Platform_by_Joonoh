import { createClient } from "@supabase/supabase-js";
import { readFile } from "node:fs/promises";
const env = await readFile(".env.local", "utf8");
for (const l of env.split("\n")) {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
}
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data: exps } = await s.from("experiments").select("id, title").ilike("title", "E2E-PAYMENT-TEST%");
console.log("E2E experiments:", exps);
for (const e of exps ?? []) {
  await s.from("participant_payment_info").delete().eq("experiment_id", e.id);
  await s.from("bookings").delete().eq("experiment_id", e.id);
  await s.from("experiments").delete().eq("id", e.id);
  console.log("deleted", e.id);
}
const { data: parts } = await s.from("participants").select("id, email").ilike("email", "e2e-%@test.invalid");
for (const p of parts ?? []) {
  await s.from("participants").delete().eq("id", p.id);
}
console.log(`purged ${parts?.length ?? 0} test participants`);
