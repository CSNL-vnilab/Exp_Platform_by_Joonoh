#!/usr/bin/env node
/**
 * QC for Phase 5a — payment-info form/page UX bundle.
 *
 * Covers:
 *   P0-Θ  multi-session hard gate (page renders gate panel instead of form
 *         when liveBookings count > 0)
 *   P0-Κ  RRN field uses CSS -webkit-text-security instead of type=password
 *         (avoids iOS Keychain trigger)
 *   P0-Κ  RRN visibility toggle uses SVG, not emoji
 *   C-P0-8 success screen mentions disbursement window + masked account
 *   C-P1-5 canvas re-init listens to window resize / orientationchange
 *   C-P1-6 bankbook hint mentions "스마트폰으로 직접 촬영"
 *   C-P1-7 submit failure renders inline error block (not toast) with
 *         recovery steps when network failed
 *
 * Static reads — JSX rendering is hard to assert without React TLR setup,
 * and these checks pin the contract that the next refactor must preserve.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; process.stdout.write(`  ✅ ${name}\n`); }
  else { failed++; process.stdout.write(`  ❌ ${name}${detail ? " — " + detail : ""}\n`); }
}
async function group(label, fn) {
  console.log(`\n── ${label} ──`);
  try { await fn(); }
  catch (err) { failed++; console.log(`  ❌ ${label} crashed: ${err.message}\n${err.stack ?? ""}`); }
}

const { readFile } = await import("node:fs/promises");
const pagePath = join(repoRoot, "src/app/(public)/payment-info/[token]/page.tsx");
const formPath = join(repoRoot, "src/app/(public)/payment-info/[token]/PaymentInfoForm.tsx");
const page = await readFile(pagePath, "utf8");
const form = await readFile(formPath, "utf8");

// ── P0-Θ: page-level multi-session hard gate ──────────────────────────
await group("P0-Θ: page hard-gates form when liveBookings > 0", async () => {
  check("page selects bookings.status for the group",
        /from\("bookings"\)[\s\S]+?\.eq\("booking_group_id",\s*info\.booking_group_id\)/.test(page));
  check("filters to status='confirmed' or 'running'",
        page.includes('b.status === "confirmed" || b.status === "running"'));
  check("computes pendingCount from liveBookings",
        page.includes("pendingCount"));
  check("conditional render: gate panel vs PaymentInfoForm",
        /pendingCount > 0\s*\?\s*\(/.test(page));
  check("gate panel says '저장되지 않습니다'",
        page.includes("저장되지 않습니다"));
  check("gate panel mentions auto re-dispatch",
        page.includes("자동 재발송"));
  check("gate panel shows last session date when available",
        page.includes("마지막 세션 종료 예정"));
});

// ── C-P0-8: success screen disbursement window + masked account ──────
await group("C-P0-8: success screen shows 2~4주 + masked account tail", async () => {
  check("page selects account_number for masking",
        page.includes(", account_number,"));
  check("masks account to last 4 digits",
        page.includes(".slice(-4)") && page.includes("****"));
  check("body says '보통 2~4주 이내'",
        page.includes("보통") && page.includes("2~4주 이내"));
  check("falls back gracefully when account_number empty",
        page.includes("등록하신 계좌"));
  check("offers 1-month escalation path",
        page.includes("1개월 이상"));
});

// ── P0-Κ: RRN CSS masking + SVG icons ────────────────────────────────
await group("P0-Κ: RRN field avoids type=password (no iOS Keychain trigger)", async () => {
  check("RRN input is type='text'",
        /id="rrn"[\s\S]+?type="text"/.test(form),
        "expected type=\"text\" on the RRN input");
  check("uses CSS -webkit-text-security toggle",
        form.includes("WebkitTextSecurity"));
  check("toggle uses 'disc' when hidden",
        /WebkitTextSecurity:\s*rrnVisible\s*\?\s*"none"\s*:\s*"disc"/.test(form));
  check("data-form-type='other' (1Password hint)",
        form.includes('data-form-type="other"'));
  check("name='participant-id-number' (not 'password')",
        form.includes('name="participant-id-number"'));
  check("autoComplete=\"off\" preserved", form.includes('autoComplete="off"'));
});

await group("P0-Κ: RRN visibility toggle uses SVG, not emoji", async () => {
  check("no 👁/🙈 emoji in toggle button",
        !form.includes('"🙈" : "👁"') && !form.includes("rrnVisible ? \"🙈\""));
  check("uses inline SVG with eye / eye-off paths",
        form.includes("<svg") &&
        /<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/.test(form));
  check("aria-label still set", form.includes('aria-label={rrnVisible ? "주민등록번호 숨기기"'));
  check("aria-pressed still set", form.includes("aria-pressed={rrnVisible}"));
  check("svg marked aria-hidden so SR uses the button label",
        form.includes('aria-hidden="true"'));
});

// ── C-P1-5: canvas resize / orientation handling ─────────────────────
await group("C-P1-5: canvas re-inits on resize / orientation change", async () => {
  check("listens for resize", form.includes('addEventListener("resize"'));
  check("listens for orientationchange",
        form.includes('addEventListener("orientationchange"'));
  check("removes both listeners in cleanup",
        form.includes('removeEventListener("resize"') &&
        form.includes('removeEventListener("orientationchange"'));
  check("resets transform before re-scaling (prevents compounding dpr)",
        form.includes("ctx.setTransform(1, 0, 0, 1, 0, 0)"));
  check("clears hasSigned on re-init (so submit guard re-triggers)",
        form.includes("hasSignedRef.current = false") &&
        /setHasSigned\(false\);[\s\S]{0,200}initCanvas/.test(form) ||
        /initCanvas[\s\S]+?hasSignedRef\.current = false/.test(form));
});

// ── C-P1-6: bankbook hint includes "스마트폰으로 직접 촬영" ─────────
await group("C-P1-6: bankbook hint mentions phone camera", async () => {
  check("hint mentions 스마트폰",
        form.includes("스마트폰") && form.includes("촬영"));
  check("hint reformulates 'PDF, PNG, JPEG' as 'PDF 또는 사진'",
        form.includes("PDF 또는 사진"));
});

// ── C-P1-7: inline submit error block ────────────────────────────────
await group("C-P1-7: submit failure shows inline error block", async () => {
  check("submitError state present",
        form.includes("setSubmitError"));
  check("error block has role='alert'",
        form.includes('role="alert"'));
  check("recovery-steps list rendered when showRecoverySteps=true",
        form.includes("submitError.showRecoverySteps") &&
        form.includes("Wi-Fi"));
  check("error block dismissible via 닫기 button",
        form.includes("setSubmitError(null)") && form.includes("닫기"));
  check("network failure (catch branch) sets showRecoverySteps=true",
        /catch[\s\S]+?showRecoverySteps:\s*true/.test(form));
  check("rate-limit (429) suppresses recovery steps",
        /isRateLimit[\s\S]+?showRecoverySteps:\s*!isRateLimit/.test(form));
  check("toast still used for field-level missing values",
        /toast\("성명을 입력하세요/.test(form));
});

console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`✅ passed: ${passed}   ❌ failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
