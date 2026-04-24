#!/usr/bin/env node
// Regression guard for the SMTP transient/permanent classification.
//
// The regex lives in src/lib/google/smtp-classification.ts. This script
// re-declares it inline (we can't import TS from node without a loader)
// and asserts the same boundary cases. If the production regex changes,
// update BOTH places — the `diff` between them is intentional so a
// silent drift shows up as a test failure here.
//
// Run:  node scripts/test-smtp-classification.mjs
// Exit: 0 if all assertions pass, 1 on first mismatch.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const helperPath = join(
  __dirname,
  "..",
  "src",
  "lib",
  "google",
  "smtp-classification.ts",
);

// Pull the regex literal out of the TS source so this script stays in
// sync without needing a TS compiler. The helper exports exactly one
// regex pattern on a single line; we parse it by anchor.
const helperSrc = readFileSync(helperPath, "utf8");
const anchor = "const TRANSIENT_SMTP_PATTERN =";
const idx = helperSrc.indexOf(anchor);
if (idx < 0) {
  console.error("✗ could not locate TRANSIENT_SMTP_PATTERN in helper source");
  process.exit(1);
}
const tail = helperSrc.slice(idx + anchor.length);
// Match `/regex/flags;` on the next non-whitespace line(s).
const m = tail.match(/\/(.+?)\/([a-z]*);/s);
if (!m) {
  console.error("✗ could not parse regex literal from helper source");
  process.exit(1);
}
const pattern = new RegExp(m[1], m[2]);

function isTransient(err) {
  return pattern.test(err);
}

const cases = [
  // transient: SMTP 4xx per RFC 5321
  ["421 4.7.0 Temporary service not available", true],
  ["452 Too many recipients", true],
  ["450 Requested mail action not taken: mailbox unavailable", true],
  ["421 Try again later", true],
  // transient: HTTP 429
  ["429 Too Many Requests", true],
  // transient: node socket errors
  ["ETIMEDOUT connect", true],
  ["Error: ECONNRESET", true],
  ["ENOTFOUND smtp.gmail.com", true],
  ["ECONNABORTED", true],
  // transient: human-readable
  ["rate-limit exceeded", true],
  ["rate limit exceeded", true],
  ["Quota exceeded temporarily", true],
  ["Greylisted, try again later", true],
  ["server busy", true],

  // permanent: SMTP 5xx — DO NOT RETRY FOREVER
  ["550 5.1.1 No such user", false],
  ["553 5.1.3 bad recipient address syntax", false],
  ["552 Message size exceeds fixed limit", false],
  ["501 Syntax error in parameters", false],
  ["554 Transaction failed", false],
  // permanent: auth/permission
  ["Invalid API credentials", false],
  ["Gmail API: permission denied", false],
  ["Authentication failed", false],
  // permanent: generic
  ["", false],
  ["unknown", false],
];

let failed = 0;
for (const [input, expected] of cases) {
  const got = isTransient(input);
  const ok = got === expected;
  const tag = ok ? "✓" : "✗";
  const label = expected ? "transient" : "permanent";
  console.log(`  ${tag} [${label}] ${JSON.stringify(input)}`);
  if (!ok) {
    failed += 1;
    console.log(`    expected ${expected}, got ${got}`);
  }
}

console.log("");
if (failed === 0) {
  console.log(`All ${cases.length} cases pass.`);
  process.exit(0);
} else {
  console.log(`${failed} of ${cases.length} cases failed.`);
  process.exit(1);
}
