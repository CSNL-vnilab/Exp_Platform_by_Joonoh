#!/usr/bin/env node
/**
 * QC for the email-shell wrapper (P0-Ι).
 *
 * Verifies every participant-facing email template now wraps its body
 * in a proper <html><head> document with the color-scheme meta tags
 * that opt out of forced dark-mode. iOS Gmail / Outlook dark-darken
 * algorithms otherwise crush our light-color box backgrounds into
 * unreadable dark-on-dark.
 */

process.env.PAYMENT_TOKEN_SECRET ||= "test-token-secret-" + "x".repeat(40);
process.env.PAYMENT_INFO_KEY ||= "test-key-" + "y".repeat(40);

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

function assertShell(label, html) {
  check(`${label}: includes <!DOCTYPE html>`, html.includes("<!DOCTYPE html>"));
  check(`${label}: <html lang="ko">`, /<html lang="ko">/.test(html));
  check(`${label}: <meta charset="utf-8">`,
        html.includes('<meta charset="utf-8">'));
  check(`${label}: viewport meta`,
        html.includes('name="viewport"'));
  check(`${label}: color-scheme: light only`,
        html.includes('content="light only"'));
  check(`${label}: supported-color-schemes: light`,
        html.includes('content="light"'));
  check(`${label}: <body> wraps content`, /<body[^>]*>[\s\S]*<\/body>/.test(html));
  check(`${label}: original inner div preserved`,
        html.includes("font-family:-apple-system"));
}

// ── 1. wrapEmailHtml direct ───────────────────────────────────────────
await group("wrapEmailHtml — basic shape", async () => {
  const m = await import("../src/lib/services/email-shell.ts");
  const out = m.wrapEmailHtml(`<div style="font-family:-apple-system">hi</div>`);
  assertShell("default", out);
  check("no title element when opts.title omitted",
        !out.includes("<title>"));
});

await group("wrapEmailHtml — title escaping", async () => {
  const m = await import("../src/lib/services/email-shell.ts");
  const out = m.wrapEmailHtml(`<div style="font-family:-apple-system">x</div>`, {
    title: `[LAB] <script>alert(1)</script> 실험`,
  });
  check("title rendered", /<title>.+<\/title>/.test(out));
  check("title HTML-encoded", out.includes("&lt;script&gt;"));
  check("no raw <script in head", !/<title>[^<]*<script/.test(out));
});

// ── 2. each template returns a wrapped html ───────────────────────────
const baseBookingInput = {
  participant: { name: "홍길동", email: "p@t.local" },
  experiment: {
    title: "테스트 실험",
    participation_fee: 10000,
    experiment_mode: "offline",
    precautions: null,
  },
  rows: [{
    id: "b-1",
    slot_start: "2026-05-12T05:00:00Z",
    slot_end: "2026-05-12T06:00:00Z",
    session_number: 1,
  }],
  creator: null,
  location: null,
  runLinks: [],
  paymentLink: null,
};

await group("booking-email-template (confirmation)", async () => {
  const m = await import("../src/lib/services/booking-email-template.ts");
  const built = m.buildConfirmationEmail(baseBookingInput);
  assertShell("confirmation", built.html);
});

await group("booking-reschedule-email", async () => {
  const m = await import("../src/lib/services/booking-reschedule-email.ts");
  const built = m.buildRescheduleEmail({
    participant: { name: "홍", email: "p@t.local" },
    experiment: { title: "T", experiment_mode: "offline" },
    booking: {
      id: "b-1",
      session_number: 1,
      slot_start: "2026-05-12T05:00:00Z",
      slot_end: "2026-05-12T06:00:00Z",
    },
    oldSlotStart: "2026-05-10T05:00:00Z",
    oldSlotEnd: "2026-05-10T06:00:00Z",
    location: null,
    researcher: null,
    otherActiveSessions: [],
  });
  assertShell("reschedule", built.html);
});

await group("booking-status-email (cancel + no_show)", async () => {
  const m = await import("../src/lib/services/booking-status-email.ts");
  const baseStatusInput = {
    participant: { name: "홍", email: "p@t.local" },
    booking: {
      id: "b-1",
      slot_start: "2026-05-12T05:00:00Z",
      slot_end: "2026-05-12T06:00:00Z",
      session_number: 1,
    },
    experiment: { id: "e-1", title: "T", experiment_mode: "offline" },
    researcher: null,
    otherActiveSessions: [],
    appOrigin: null,
  };
  const cancel = m.buildCancellationEmail(baseStatusInput);
  assertShell("cancel", cancel.html);
  const noShow = m.buildNoShowEmail(baseStatusInput);
  assertShell("no_show", noShow.html);
});

await group("payment-info-email-template", async () => {
  const m = await import("../src/lib/services/payment-info-email-template.ts");
  const built = m.buildPaymentInfoEmail({
    participantName: "홍",
    participantEmail: "p@t.local",
    experimentTitle: "T",
    amountKrw: 10000,
    paymentUrl: "https://t.local/payment-info/abc",
    periodStart: null,
    periodEnd: null,
    researcher: null,
    tokenExpiresAt: new Date(Date.now() + 60 * 86400_000).toISOString(),
  });
  assertShell("payment-info", built.html);
});

// ── reminder.service is harder to unit-test in isolation (depends on
//    Supabase) — we just assert the wrapEmailHtml import is present and
//    the file references the wrap function in the right place.
await group("reminder.service — wrapEmailHtml usage", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(
    "/Users/csnl/Documents/claude/lab-reservation/src/lib/services/reminder.service.ts",
    "utf8",
  );
  check("imports wrapEmailHtml",
        src.includes('from "@/lib/services/email-shell"'));
  check("calls wrapEmailHtml in body", src.includes("wrapEmailHtml("));
  check("passes subject as title",
        /\{\s*title:\s*subject\s*\}/.test(src));
});

console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`✅ passed: ${passed}   ❌ failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
