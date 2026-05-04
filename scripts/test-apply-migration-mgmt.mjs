#!/usr/bin/env node
/**
 * Pins the `ALTER TYPE ADD VALUE` + same-tx-use lint in
 * apply-migration-mgmt.mjs.
 *
 * Background: Postgres rejects any reference to a freshly-added enum
 * value within the same transaction (`55P04 unsafe use of new value`).
 * apply-migration-mgmt.mjs sends the whole .sql file as one query, so
 * a single-file ADD VALUE + USE always fails. We hit this on
 * 2026-05-04 with the `paid_offline` enum (had to split into 00056 +
 * 00057). The lint catches it pre-flight with a clearer error than
 * the raw 55P04.
 *
 * Run: node scripts/test-apply-migration-mgmt.mjs
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "apply-migration-mgmt.mjs");

// We don't have Supabase creds in CI, and we don't want test runs to
// actually hit the API. Use the lint exit code (2) as the success
// signal for "should refuse" cases. For "should pass" cases, we point
// the script at a missing env file so it bails after the lint with a
// non-2 exit.
const TMP = mkdtempSync(join(tmpdir(), "mgmt-lint-"));

function writeFixture(name, body) {
  const p = join(TMP, name);
  writeFileSync(p, body);
  return p;
}

function run(file) {
  const r = spawnSync("node", [SCRIPT, file], {
    encoding: "utf8",
    env: {
      ...process.env,
      // Force the script to not find creds, so it exits with 1
      // immediately AFTER the lint passes. This lets us distinguish
      // lint-fail (exit 2) from lint-pass.
      SUPABASE_ACCESS_TOKEN: "",
      NEXT_PUBLIC_SUPABASE_URL: "",
    },
  });
  return { code: r.status, stderr: r.stderr, stdout: r.stdout };
}

const cases = [
  {
    name: "rejects ADD VALUE + use in same file",
    body: `
      ALTER TYPE payment_status ADD VALUE 'paid_offline';
      ALTER TABLE participant_payment_info
        ADD CONSTRAINT foo CHECK (status IN ('pending', 'paid_offline'));
    `,
    expectExit: 2,
    expectStderrContains: "paid_offline",
  },
  {
    name: "rejects ADD VALUE IF NOT EXISTS + use",
    body: `
      ALTER TYPE payment_status ADD VALUE IF NOT EXISTS 'paid_offline';
      UPDATE participant_payment_info SET status = 'paid_offline' WHERE id = 1;
    `,
    expectExit: 2,
    expectStderrContains: "paid_offline",
  },
  {
    name: "passes ADD VALUE alone (mirrors 00056)",
    body: `
      ALTER TYPE payment_status ADD VALUE IF NOT EXISTS 'paid_offline';
    `,
    expectExit: 1, // bails at missing creds, but past the lint
    expectStderrNotContains: "Refusing",
  },
  {
    name: "passes consumer-only file (mirrors 00057)",
    body: `
      ALTER TABLE participant_payment_info
        ADD CONSTRAINT foo CHECK (status IN ('pending', 'paid_offline'));
    `,
    expectExit: 1,
    expectStderrNotContains: "Refusing",
  },
  {
    name: "passes when value name only appears in a comment",
    body: `
      ALTER TYPE payment_status ADD VALUE 'shiny_new';
      -- Note: see migration 00099 for the CHECK that references 'shiny_new'.
    `,
    expectExit: 1,
    expectStderrNotContains: "Refusing",
  },
  {
    name: "passes when value name only appears in a /* block comment */",
    body: `
      ALTER TYPE payment_status ADD VALUE 'shiny_new';
      /* see 00099 for the CHECK on 'shiny_new' */
    `,
    expectExit: 1,
    expectStderrNotContains: "Refusing",
  },
  {
    name: "rejects when ADD VALUE precedes use even after a comment line",
    body: `
      ALTER TYPE payment_status ADD VALUE 'shiny_new';
      -- a comment
      UPDATE t SET s = 'shiny_new';
    `,
    expectExit: 2,
    expectStderrContains: "shiny_new",
  },
];

let failed = 0;
for (const c of cases) {
  const file = writeFixture(`${c.name.replace(/\W+/g, "_")}.sql`, c.body);
  const r = run(file);
  const exitOk = r.code === c.expectExit;
  const containsOk = c.expectStderrContains
    ? r.stderr.includes(c.expectStderrContains)
    : true;
  const notContainsOk = c.expectStderrNotContains
    ? !r.stderr.includes(c.expectStderrNotContains)
    : true;
  const ok = exitOk && containsOk && notContainsOk;
  if (!ok) {
    failed++;
    console.error(`FAIL  ${c.name}`);
    console.error(`  expected exit ${c.expectExit}, got ${r.code}`);
    if (c.expectStderrContains && !containsOk)
      console.error(
        `  expected stderr to contain "${c.expectStderrContains}"`,
      );
    if (c.expectStderrNotContains && !notContainsOk)
      console.error(
        `  expected stderr NOT to contain "${c.expectStderrNotContains}"`,
      );
    console.error(`  stderr: ${r.stderr.slice(0, 400)}`);
  } else {
    console.log(`ok    ${c.name}`);
  }
}

rmSync(TMP, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
