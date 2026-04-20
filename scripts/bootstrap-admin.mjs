#!/usr/bin/env node
// Bootstrap the initial admin account. Safe to re-run — idempotent.
//
// Usage:
//   node scripts/bootstrap-admin.mjs [username] [password]
// Defaults: username=csnl, password=slab1234

import { createClient } from "@supabase/supabase-js";
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

const USER_EMAIL_DOMAIN = "lab.local";
const USERNAME_REGEX = /^[a-z]{3,4}$/i;

function toInternalEmail(username) {
  return `${username.toLowerCase()}@${USER_EMAIL_DOMAIN}`;
}

async function main() {
  await loadEnv();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local");
    process.exit(1);
  }

  const [, , argUsername, argPassword] = process.argv;
  const username = (argUsername ?? "csnl").toLowerCase();
  const password = argPassword ?? "slab1234";
  if (!USERNAME_REGEX.test(username)) {
    console.error(`Invalid username "${username}". Must be 3-4 English letters.`);
    process.exit(1);
  }

  const email = toInternalEmail(username);
  const admin = createClient(url, key, { auth: { persistSession: false } });

  // 1. Find existing auth user by email, or create one.
  let userId;
  const { data: listData, error: listError } = await admin.auth.admin.listUsers({
    page: 1,
    perPage: 200,
  });
  if (listError) {
    console.error("listUsers failed:", listError.message);
    process.exit(2);
  }
  const existing = listData.users.find((u) => u.email?.toLowerCase() === email);

  if (existing) {
    userId = existing.id;
    console.log(`→ user already exists (${email}), updating password + metadata`);
    const { error } = await admin.auth.admin.updateUserById(userId, {
      password,
      user_metadata: { display_name: username },
      email_confirm: true,
    });
    if (error) {
      console.error("updateUser failed:", error.message);
      process.exit(3);
    }
  } else {
    console.log(`→ creating new auth user (${email})`);
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name: username },
    });
    if (error || !data.user) {
      console.error("createUser failed:", error?.message ?? "unknown error");
      process.exit(4);
    }
    userId = data.user.id;
  }

  // 2. Upsert profile with role=admin. Relies on 00009 migration being applied.
  const { error: profileError } = await admin
    .from("profiles")
    .upsert(
      {
        id: userId,
        email,
        display_name: username,
        role: "admin",
        disabled: false,
        contact_email: 'contact@example.edu',
        phone: '010-0000-0000',
      },
      { onConflict: "id" },
    );
  if (profileError) {
    console.error(
      "profiles upsert failed:",
      profileError.message,
      "\nDid you apply migrations 00009 + 00010?",
    );
    process.exit(5);
  }

  console.log(`✓ admin "${username}" ready — log in at /login with ID "${username}" and the given password`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
