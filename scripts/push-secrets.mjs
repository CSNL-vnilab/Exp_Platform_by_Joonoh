#!/usr/bin/env node
// Read .env.local and push sensitive values to Cloudflare as Wrangler secrets.
// Public `NEXT_PUBLIC_*` and other non-secret values belong in wrangler.jsonc
// `vars`; this script explicitly skips them.
//
// Usage:
//   npx wrangler login     # one-time
//   npm run push-secrets
//
// Idempotent — re-running overwrites existing secrets.

import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dirname, "..", ".env.local");

// Keys that Cloudflare should hold as encrypted secrets (not plain vars).
const SECRET_KEYS = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY",
  "GMAIL_APP_PASSWORD",
  "CRON_SECRET",
  "NOTION_API_KEY",
  "SOLAPI_API_SECRET",
  "REGISTRATION_SECRET", // optional; falls back to SUPABASE_SERVICE_ROLE_KEY
];

async function loadEnv() {
  const text = await readFile(ENV_PATH, "utf8").catch(() => "");
  const out = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
  return out;
}

function runWrangler(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["wrangler", ...args], { stdio: ["pipe", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`wrangler ${args.join(" ")} exited ${code}`));
    });
    if (input !== undefined) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

async function main() {
  const env = await loadEnv();
  let pushed = 0;
  let skipped = 0;

  for (const key of SECRET_KEYS) {
    const value = env[key];
    if (!value) {
      console.log(`  ⏭  ${key}  (empty in .env.local — skipping)`);
      skipped++;
      continue;
    }
    process.stdout.write(`  → ${key}  (${value.length} chars) ... `);
    try {
      await runWrangler(["secret", "put", key], value);
      console.log("ok");
      pushed++;
    } catch (e) {
      console.log(`FAIL: ${e.message}`);
    }
  }

  console.log(`\n${pushed} secrets pushed, ${skipped} skipped.`);
  console.log(
    "Public vars still need to be set in wrangler.jsonc (NEXT_PUBLIC_*, GMAIL_USER, etc).",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
