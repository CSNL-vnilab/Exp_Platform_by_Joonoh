#!/usr/bin/env node
// Tiny unit-test smoke for src/lib/observability/pii.ts.
//
// Why: the helper is the single owner for last_error redaction across
// the 4 retry services + 2 cancel paths (refactor-roadmap A6). If a
// future change accidentally weakens the regexes, every PII-in-error
// audit row leaks. This script catches that within a single `node` run.
//
// Tests use the actual transpiled-equivalent regex source — we paste
// the regex strings directly rather than importing the .ts module
// (avoids needing a node loader for TypeScript). The corresponding
// test fixtures cover:
//   * Korean mobile (010-XXXX-XXXX, 010XXXXXXXX)
//   * Seoul landline / 070 internet phone / international "+82"
//   * email (gmail, ac.kr, plus-aliased)
//   * SMTP envelope patterns (admin@..., <recipient@...>)
//   * 영문/한글 mixed messages
//   * negative cases — UUIDs, ISO timestamps, decimal numbers
//   * documented limitations — country code remainder, RRN pass-through
//
// Drift check at the bottom verifies the regex source strings still
// appear verbatim in src/lib/observability/pii.ts.

const EMAIL_RE = /\b[\w._%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g;
const PHONE_RE = /\b\d{2,3}-?\d{3,4}-?\d{4}\b/g;

function scrubPii(msg) {
  return msg.replace(EMAIL_RE, "<email>").replace(PHONE_RE, "<phone>");
}

const cases = [
  // ── Email — must scrub ────────────────────────────────────────────
  ["jy061100@gmail.com 결제 실패", "<email> 결제 실패", "gmail address"],
  ["lab@snu.ac.kr 알림", "<email> 알림", "Korean university (.ac.kr)"],
  [
    "test+filter@kaist.ac.kr forward",
    "<email> forward",
    "plus-alias survives",
  ],
  [
    'recipient "user.name@univ.edu" rejected',
    'recipient "<email>" rejected',
    "email inside quotes",
  ],

  // ── Phone — must scrub ────────────────────────────────────────────
  ["회원 010-1234-5678 phone", "회원 <phone> phone", "mobile dashed"],
  ["회원 01012345678 phone", "회원 <phone> phone", "mobile no-dash 11 digit"],
  ["070-1234-5678 응답 없음", "<phone> 응답 없음", "070 internet phone"],
  ["02-880-1234 연락 바람", "<phone> 연락 바람", "Seoul landline 8-digit"],
  [
    "contact=01099887766 (no separator)",
    "contact=<phone> (no separator)",
    "mobile no-dash after = sign",
  ],

  // ── Mixed / complex ──────────────────────────────────────────────
  [
    "user.name@univ.edu and 010-9999-0000 both",
    "<email> and <phone> both",
    "email + phone in one line",
  ],
  [
    "SMTP error: <admin@lab.kr>, recipient <staff@lab.kr> rejected 010-2222-3333",
    "SMTP error: <<email>>, recipient <<email>> rejected <phone>",
    "SMTP envelope multi-email + phone",
  ],
  [
    'Notion 400: "property 전화번호 has value 010-1234-5678 that does not match"',
    'Notion 400: "property 전화번호 has value <phone> that does not match"',
    "Notion-style API echo (the exact case scrubPii was added for)",
  ],

  // ── Negative — must NOT scrub ────────────────────────────────────
  ["일반 메시지", "일반 메시지", "no patterns"],
  ["100.50 KRW total", "100.50 KRW total", "decimal currency"],
  [
    "bookingId=550e8400-e29b-41d4-a716-446655440000 row",
    "bookingId=550e8400-e29b-41d4-a716-446655440000 row",
    "UUID does not false-positive as phone",
  ],
  [
    "ts=2026-05-30T12:34:56Z",
    "ts=2026-05-30T12:34:56Z",
    "ISO timestamp does not false-positive",
  ],
  ["KST 2026-05-30", "KST 2026-05-30", "bare YYYY-MM-DD date"],

  // ── Documented limitation: +82 country code partially leaks ──────
  // The pattern `\b\d{2,3}-?\d{3,4}-?\d{4}\b` matches the
  // "10-1234-5678" inside "+82-10-1234-5678" because the dash before
  // "10" creates a word boundary. The "+82-" country code remains
  // visible. Acceptable for the audit-row use case — the participant
  // identity is the local number, not the country prefix. Documented
  // here so a future "fix" doesn't silently change behaviour.
  [
    "+82-10-1234-5678 international",
    "+82-<phone> international",
    "+82 prefix partially leaks (DOCUMENTED LIMITATION)",
  ],

  // ── Documented limitation: RRN (주민등록번호) not scrubbed here ──
  // RRN is handled separately by src/lib/crypto/rrn.ts (AES-GCM
  // ciphertext stored). RRN never flows into last_error strings
  // because we never send it to external APIs unencrypted, so this
  // scrubber doesn't need a pattern for it. This fixture asserts the
  // current behaviour so a "let's add RRN scrubbing" change must be
  // an explicit opt-in (and remove this case).
  [
    "ID 800101-1234567 fail",
    "ID 800101-1234567 fail",
    "RRN intentionally NOT scrubbed (separate crypto module)",
  ],
];

let pass = 0;
let fail = 0;
console.log("PII scrub smoke");
console.log("─".repeat(64));
for (const [input, expected, label] of cases) {
  const got = scrubPii(input);
  const ok = got === expected;
  if (ok) pass += 1;
  else fail += 1;
  console.log(`  ${ok ? "✓" : "✗"} ${label}`);
  if (!ok) {
    console.log(`      input    : ${JSON.stringify(input)}`);
    console.log(`      expected : ${JSON.stringify(expected)}`);
    console.log(`      got      : ${JSON.stringify(got)}`);
  }
}
console.log("─".repeat(64));
console.log(`${pass} passed, ${fail} failed`);

// Drift check: read the actual src/lib/observability/pii.ts and assert
// it still uses the same regex literals. Catches a refactor that
// silently swaps the patterns without updating these fixtures.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, "..", "src", "lib", "observability", "pii.ts");
let drift = 0;
try {
  const text = await readFile(SRC, "utf8");
  if (!text.includes(EMAIL_RE.source)) {
    console.log(
      "  ✗ DRIFT: pii.ts no longer contains the expected email regex",
    );
    drift += 1;
  }
  if (!text.includes(PHONE_RE.source)) {
    console.log(
      "  ✗ DRIFT: pii.ts no longer contains the expected phone regex",
    );
    drift += 1;
  }
} catch (err) {
  console.log(
    `  ✗ DRIFT: cannot read ${SRC}: ${err instanceof Error ? err.message : String(err)}`,
  );
  drift += 1;
}
if (drift === 0) {
  console.log("  ✓ DRIFT: pii.ts regexes unchanged");
}

process.exit(fail + drift === 0 ? 0 : 1);
