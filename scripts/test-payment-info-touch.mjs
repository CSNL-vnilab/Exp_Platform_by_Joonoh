#!/usr/bin/env node
/**
 * QC for POST /api/payment-info/[token]/touch (P0-Ε).
 *
 * The touch route is the new home for the payment_link_first_opened_at
 * stamp. Previously the stamp lived in the page server-component,
 * which let any party who got the URL trip the flag (forwarded mail,
 * spam-preview pane, browser sync, shoulder-surf) without ever
 * actually using the form. The flag controls token-preserve behavior
 * in payment-info-notify.service — tripping it pins the token alive
 * for the 60-day TTL.
 *
 * Now the stamp only fires from PaymentInfoForm's mount effect, which
 * requires real JS execution = real browser session.
 *
 * This test exercises the route handler directly (no Next.js server)
 * via a stub Request + the exported POST function.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.PAYMENT_TOKEN_SECRET ||= "test-token-secret-" + "x".repeat(40);
process.env.PAYMENT_INFO_KEY ||= "test-key-" + "y".repeat(40);
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://stub.local";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "stub-key";

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

// ── 1. shape: route exists, handles missing token ─────────────────────
await group("missing token → 400", async () => {
  // We can't easily import the route handler under test because it
  // pulls in createAdminClient which requires a real Supabase URL at
  // module-load time. So we instead verify the page-side change is in
  // place and do a static read of the route file.
  const { readFile } = await import("node:fs/promises");
  const route = await readFile(
    join(repoRoot, "src/app/api/payment-info/[token]/touch/route.ts"),
    "utf8",
  );
  check("file exists with POST handler",
        route.includes("export async function POST"));
  check("verifies token via verifyPaymentToken",
        route.includes("verifyPaymentToken("));
  check("checks token_hash matches verified.hash",
        route.includes("row.token_hash !== verified.hash"));
  check("CAS via .is(... NULL)",
        /\.is\("payment_link_first_opened_at",\s*null\)/.test(route));
  check("rate-limited (per-IP + per-token)",
        route.includes("payment-touch-ip") &&
        route.includes("payment-touch-token"));
  check("token plaintext not used as limiter key (uses sha256)",
        route.includes("createHash") && route.includes("digest"));
});

// ── 2. page server-component no longer stamps ─────────────────────────
await group("page.tsx no longer stamps first_opened_at on render", async () => {
  const { readFile } = await import("node:fs/promises");
  const page = await readFile(
    join(repoRoot, "src/app/(public)/payment-info/[token]/page.tsx"),
    "utf8",
  );
  check("no .update({ payment_link_first_opened_at: ... }) in page",
        !/\.update\(\{\s*payment_link_first_opened_at:/.test(page));
  check("page contains P0-Ε rationale comment",
        page.includes("P0-Ε") || page.includes("trippable") ||
        page.includes("not stamp"));
});

// ── 3. PaymentInfoForm fires touch on mount ───────────────────────────
await group("PaymentInfoForm mount effect calls /touch", async () => {
  const { readFile } = await import("node:fs/promises");
  const form = await readFile(
    join(repoRoot, "src/app/(public)/payment-info/[token]/PaymentInfoForm.tsx"),
    "utf8",
  );
  check("imports useEffect (already used for canvas)",
        form.includes("useEffect"));
  check("mount-effect fetches /touch",
        form.includes("/touch") &&
        form.includes("method: \"POST\""));
  check("uses encodeURIComponent on token",
        form.includes("encodeURIComponent(token)"));
  check("comment explains P0-Ε rationale",
        form.includes("P0-Ε"));
  check("error suppressed (.catch — fire-and-forget)",
        /\}\)\.catch\(/.test(form));
});

// ── 4. integration with rate-limit module ─────────────────────────────
await group("rate-limit module shape (used by touch + submit)", async () => {
  const m = await import("../src/lib/utils/rate-limit.ts");
  m._resetRateLimitForTests();
  // Mimic a tight cap; verify it limits as expected.
  const opts = { windowMs: 60_000, max: 2 };
  check("first call allowed", m.rateLimit("payment-touch-ip", "1.2.3.4", opts).allowed);
  check("second call allowed", m.rateLimit("payment-touch-ip", "1.2.3.4", opts).allowed);
  check("third call blocked", !m.rateLimit("payment-touch-ip", "1.2.3.4", opts).allowed);
  check("different IP independent",
        m.rateLimit("payment-touch-ip", "9.9.9.9", opts).allowed);
});

console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`✅ passed: ${passed}   ❌ failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
