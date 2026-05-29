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
//   * 한국 mobile (010-XXXX-XXXX, 010XXXXXXXX, 02-XXX-XXXX)
//   * email (gmail, naver, university)
//   * 영문/한글 텍스트 안 섞인 경우
//   * 음수/거짓양성 (전화번호처럼 보이지만 아닌 숫자열)

const EMAIL_RE = /\b[\w._%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g;
const PHONE_RE = /\b\d{2,3}-?\d{3,4}-?\d{4}\b/g;

function scrubPii(msg) {
  return msg.replace(EMAIL_RE, "<email>").replace(PHONE_RE, "<phone>");
}

const cases = [
  // [input, expected, label]
  ["jy061100@gmail.com 결제 실패", "<email> 결제 실패", "gmail"],
  ["회원 010-1234-5678 phone", "회원 <phone> phone", "010-X-X 형식"],
  ["회원 01012345678 phone", "회원 <phone> phone", "하이픈 없는 11자"],
  ["lab@snu.ac.kr 알림", "<email> 알림", "ac.kr"],
  ["02-880-1234 연락", "<phone> 연락", "유선"],
  [
    "user.name@univ.edu and 010-9999-0000 both",
    "<email> and <phone> both",
    "복합",
  ],
  ["일반 메시지", "일반 메시지", "패턴 없음"],
  ["100.50", "100.50", "소수점 통과"],
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
