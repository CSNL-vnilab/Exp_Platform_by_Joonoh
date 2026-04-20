#!/usr/bin/env node
// Take a service-account JSON file downloaded from GCP and install its
// credentials into .env.local without leaking them to the terminal.
//
// Usage:
//   node scripts/install-service-account.mjs /path/to/service-account.json [calendarId]
//
// `calendarId` is optional — if provided, GOOGLE_CALENDAR_ID is updated too.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { createPrivateKey } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dirname, "..", ".env.local");

function upsertEnv(body, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(body)) return body.replace(re, line);
  return body.endsWith("\n") ? `${body}${line}\n` : `${body}\n${line}\n`;
}

async function main() {
  const jsonPath = process.argv[2];
  const calendarId = process.argv[3];
  if (!jsonPath) {
    console.error("Usage: node scripts/install-service-account.mjs <service-account.json> [calendarId]");
    process.exit(1);
  }

  const fullPath = resolve(jsonPath);
  const raw = await readFile(fullPath, "utf8");
  let sa;
  try {
    sa = JSON.parse(raw);
  } catch (e) {
    console.error("Invalid JSON:", e.message);
    process.exit(2);
  }

  if (sa.type !== "service_account") {
    console.error(`Expected type="service_account" in JSON, got "${sa.type}"`);
    process.exit(3);
  }
  if (!sa.client_email || !sa.private_key) {
    console.error("JSON must include client_email and private_key");
    process.exit(4);
  }

  // Validate the private key parses as PEM
  try {
    const k = createPrivateKey(sa.private_key);
    console.log(`✓ private key parsed (${k.asymmetricKeyType})`);
  } catch (e) {
    console.error("private_key failed to parse:", e.message);
    process.exit(5);
  }

  // Escape newlines for .env storage
  const escapedKey = sa.private_key.replace(/\n/g, "\\n");

  let body = await readFile(ENV_PATH, "utf8");
  body = upsertEnv(body, "GOOGLE_SERVICE_ACCOUNT_EMAIL", sa.client_email);
  body = upsertEnv(body, "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY", `"${escapedKey}"`);
  if (calendarId) body = upsertEnv(body, "GOOGLE_CALENDAR_ID", calendarId);
  await writeFile(ENV_PATH, body);

  console.log(`✓ .env.local updated:`);
  console.log(`  GOOGLE_SERVICE_ACCOUNT_EMAIL=${sa.client_email}`);
  console.log(`  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY=<${sa.private_key.length} chars PEM>`);
  if (calendarId) console.log(`  GOOGLE_CALENDAR_ID=${calendarId}`);
  console.log("");
  console.log("Remember to:");
  console.log(`  1) Share the target calendar in Google Calendar UI with`);
  console.log(`     ${sa.client_email}`);
  console.log(`     — permission: "Make changes to events"`);
  console.log("  2) Restart the dev server so the new env is picked up");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
