#!/usr/bin/env node
// Read .env.local and push every variable to Vercel (production + preview +
// development). Uses `vercel env add` via stdin to avoid interactive prompts.

import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dirname, "..", ".env.local");

// Skip these — either empty-by-design or local-only
const SKIP_IF_EMPTY = new Set([
  "SOLAPI_API_KEY",
  "SOLAPI_API_SECRET",
  "SOLAPI_SENDER_PHONE",
  "REGISTRATION_SECRET",
]);

async function loadEnv() {
  const text = await readFile(ENV_PATH, "utf8").catch(() => "");
  const out = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    let value = m[2];
    // Strip surrounding quotes if present (for multi-line values stored with \n escapes)
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    out[m[1]] = value;
  }
  return out;
}

function runVercel(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["vercel", ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
    if (input !== undefined) {
      child.stdin.write(input + "\n");
      child.stdin.end();
    }
  });
}

async function main() {
  const token = process.env.VERCEL_TOKEN;
  if (!token) {
    console.error("VERCEL_TOKEN env var required");
    process.exit(1);
  }

  const env = await loadEnv();
  const keys = Object.keys(env).sort();
  let pushed = 0;
  let skipped = 0;

  for (const key of keys) {
    const value = env[key];
    if (!value && SKIP_IF_EMPTY.has(key)) {
      console.log(`  ⏭  ${key}  (empty, skipping)`);
      skipped++;
      continue;
    }
    if (!value) {
      console.log(`  ⏭  ${key}  (empty)`);
      skipped++;
      continue;
    }

    process.stdout.write(`  → ${key}  (${value.length} chars) ... `);
    // Vercel CLI v51+ requires one environment per invocation. Remove any
    // prior value (best-effort) and add fresh for each target.
    const envs = ["production", "preview", "development"];
    let anyFail = false;
    for (const target of envs) {
      await runVercel(["env", "rm", key, target, "--token", token, "--yes"]);
      const res = await runVercel(["env", "add", key, target, "--token", token], value);
      if (res.code !== 0) {
        anyFail = true;
        console.log(`FAIL (${target}): ${(res.stderr || res.stdout).slice(0, 160).trim()}`);
        break;
      }
    }
    if (!anyFail) {
      console.log("ok");
      pushed++;
    }
  }

  console.log(`\n${pushed} env vars pushed, ${skipped} skipped.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
