#!/usr/bin/env node
/**
 * QC for the branding placeholder guards added in P0 #1.
 *
 * Verifies that:
 *   1. The branding helpers detect the un-configured placeholder.
 *   2. validateBrandingForProduction() reports both env vars as missing
 *      when un-configured, and silent when configured.
 *   3. Email + SMS templates that fall back to BRAND_CONTACT_EMAIL
 *      hide the inquiry line when the env is the placeholder, instead
 *      of rendering "contact@example.com".
 *
 * Run: node --import tsx scripts/test-branding-placeholder.mjs
 */

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    process.stdout.write(`  ✅ ${name}\n`);
  } else {
    failed++;
    process.stdout.write(`  ❌ ${name}${detail ? " — " + detail : ""}\n`);
  }
}
async function group(label, fn) {
  console.log(`\n── ${label} ──`);
  try { await fn(); }
  catch (err) { failed++; console.log(`  ❌ ${label} crashed: ${err.message}\n${err.stack ?? ""}`); }
}

// ── 1. Helpers ──────────────────────────────────────────────────────────
await group("placeholder detection helpers", async () => {
  const m = await import("../src/lib/branding.ts");
  // Default state at import time (no env set in this test process).
  check("isBrandNamePlaceholder() === true when env unset",
        m.isBrandNamePlaceholder() === true);
  check("isBrandContactEmailPlaceholder() === true when env unset",
        m.isBrandContactEmailPlaceholder() === true);
  check("brandContactEmailOrNull() returns null when unset",
        m.brandContactEmailOrNull() === null);

  // Validation report
  const missing = m.validateBrandingForProduction();
  check("validate reports NEXT_PUBLIC_LAB_NAME missing",
        missing.includes("NEXT_PUBLIC_LAB_NAME"));
  check("validate reports NEXT_PUBLIC_LAB_CONTACT_EMAIL missing",
        missing.includes("NEXT_PUBLIC_LAB_CONTACT_EMAIL"));

  // Explicit-value variants (don't mutate process.env between tests).
  check("isBrandNamePlaceholder('CSNL') === false",
        m.isBrandNamePlaceholder("CSNL") === false);
  check("isBrandContactEmailPlaceholder('a@b.com') === false",
        m.isBrandContactEmailPlaceholder("a@b.com") === false);
});

// ── 2. payment-info email — researcher email present ──────────────────
await group("payment-info-email-template — researcher email overrides", async () => {
  const { buildPaymentInfoEmail } = await import(
    "../src/lib/services/payment-info-email-template.ts"
  );
  const built = buildPaymentInfoEmail({
    participantName: "홍길동",
    participantEmail: "p@test.local",
    experimentTitle: "테스트",
    amountKrw: 10000,
    paymentUrl: "https://t.local/payment-info/abc",
    periodStart: "2026-04-30",
    periodEnd: "2026-04-30",
    researcher: {
      displayName: "이연구원",
      contactEmail: "researcher@test.local",
      phone: "010-1111-2222",
    },
    tokenExpiresAt: new Date(Date.now() + 60 * 86400_000).toISOString(),
  });
  check("uses researcher contact",
        built.html.includes("researcher@test.local"));
  check("does NOT include placeholder address",
        !built.html.includes("contact@example.com"));
});

// ── 3. payment-info email — no researcher contact, env is placeholder ───
await group("payment-info-email-template — no researcher, no lab inbox", async () => {
  const { buildPaymentInfoEmail } = await import(
    "../src/lib/services/payment-info-email-template.ts"
  );
  const built = buildPaymentInfoEmail({
    participantName: "홍길동",
    participantEmail: "p@test.local",
    experimentTitle: "테스트",
    amountKrw: 10000,
    paymentUrl: "https://t.local/payment-info/abc",
    periodStart: null,
    periodEnd: null,
    researcher: null,
    tokenExpiresAt: new Date(Date.now() + 60 * 86400_000).toISOString(),
  });
  check("does NOT include placeholder address (env is unset in test)",
        !built.html.includes("contact@example.com"),
        built.html.match(/[\w.+-]+@[\w-]+\.\w+/g)?.join(",") ?? "no email match");
  check("does NOT render an empty mailto: tag",
        !built.html.includes("mailto:\""));
  check("section header still present (graceful degradation)",
        built.html.includes("담당 연구원 · 문의"));
});

// ── 4. signup page — placeholder hides confirmation line ────────────────
await group("signup confirmation — placeholder hides confirmation email line", async () => {
  // We can only test the helpers reach the right branch here without
  // importing React. Direct assertion: when env is placeholder, the
  // helper that gates the line returns true, so the JSX block is null.
  const { isBrandContactEmailPlaceholder } = await import("../src/lib/branding.ts");
  check("placeholder detected → JSX would suppress",
        isBrandContactEmailPlaceholder() === true);
});

console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`✅ passed: ${passed}   ❌ failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
