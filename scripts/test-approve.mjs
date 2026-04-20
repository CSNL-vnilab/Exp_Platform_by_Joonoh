#!/usr/bin/env node
// One-shot verification: approve the oldest pending registration request
// without going through the HTTP layer. Mirrors the logic of
// POST /api/registration-requests/[id]/approve exactly.

import { createClient } from "@supabase/supabase-js";
import { createDecipheriv, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dirname, "..", ".env.local");

async function loadEnv() {
  const text = await readFile(ENV_PATH, "utf8").catch(() => "");
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    if (!process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
}

function getKey() {
  const source = process.env.REGISTRATION_SECRET ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  return createHash("sha256").update(source).digest();
}

function decrypt({ cipher, iv, tag }) {
  const d = createDecipheriv("aes-256-gcm", getKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(cipher), d.final()]).toString("utf8");
}

await loadEnv();
const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const { data: req, error } = await admin
  .from("registration_requests")
  .select("*")
  .eq("status", "pending")
  .order("requested_at", { ascending: true })
  .limit(1)
  .maybeSingle();

if (error || !req) {
  console.error("No pending request found:", error?.message);
  process.exit(1);
}

const plaintext = decrypt({
  cipher: Buffer.from(req.password_cipher, "base64"),
  iv: Buffer.from(req.password_iv, "base64"),
  tag: Buffer.from(req.password_tag, "base64"),
});

console.log(`→ approving '${req.username}' (${req.display_name})  decrypted_pw=${plaintext}`);

const email = `${req.username}@lab.local`;
const { data: created, error: createError } = await admin.auth.admin.createUser({
  email,
  password: plaintext,
  email_confirm: true,
  user_metadata: { display_name: req.display_name },
});
if (createError) {
  console.error("createUser failed:", createError.message);
  process.exit(2);
}

await admin
  .from("profiles")
  .update({ display_name: req.display_name, role: "researcher", disabled: false })
  .eq("id", created.user.id);

await admin
  .from("registration_requests")
  .update({
    status: "approved",
    processed_at: new Date().toISOString(),
    password_cipher: "",
    password_iv: "",
    password_tag: "",
  })
  .eq("id", req.id);

console.log(`✓ researcher '${req.username}' can now log in with password '${plaintext}'`);

// Round-trip login check
const anon = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
);
const { data: signIn, error: signInError } = await anon.auth.signInWithPassword({
  email,
  password: plaintext,
});
if (signInError) {
  console.error("login round-trip FAILED:", signInError.message);
  process.exit(3);
}
console.log(`✓ login round-trip ok  user_id=${signIn.user.id}  role=${signIn.user.role}`);
