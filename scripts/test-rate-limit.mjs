#!/usr/bin/env node
/**
 * QC for src/lib/utils/rate-limit.ts (P0-Ζ).
 *
 * Sliding-window in-memory limiter is the front-line defense for
 * /api/payment-info/[token]/submit. Verify:
 *   - count under cap → allowed
 *   - count at cap → rejected with retryAfterMs > 0
 *   - new key (different IP / token) shares no state
 *   - window expires correctly
 */

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

const m = await import("../src/lib/utils/rate-limit.ts");

// ── 1. allow under cap, reject at cap ──────────────────────────────────
await group("allows N attempts up to max, rejects N+1", async () => {
  m._resetRateLimitForTests();
  const opts = { windowMs: 60_000, max: 3 };
  const r1 = m.rateLimit("p", "ip-A", opts);
  const r2 = m.rateLimit("p", "ip-A", opts);
  const r3 = m.rateLimit("p", "ip-A", opts);
  const r4 = m.rateLimit("p", "ip-A", opts);
  check("attempt 1 allowed (count=1)", r1.allowed && r1.count === 1);
  check("attempt 2 allowed (count=2)", r2.allowed && r2.count === 2);
  check("attempt 3 allowed (count=3)", r3.allowed && r3.count === 3);
  check("attempt 4 rejected", !r4.allowed);
  check("rejection has retryAfterMs > 0", r4.retryAfterMs > 0);
  check("rejection retryAfterMs < windowMs", r4.retryAfterMs <= 60_000);
});

// ── 2. independent keys are independent ────────────────────────────────
await group("different keys don't share state", async () => {
  m._resetRateLimitForTests();
  const opts = { windowMs: 60_000, max: 2 };
  m.rateLimit("p", "ip-A", opts);
  m.rateLimit("p", "ip-A", opts);
  const blocked = m.rateLimit("p", "ip-A", opts);
  check("ip-A blocked at cap", !blocked.allowed);
  const otherIp = m.rateLimit("p", "ip-B", opts);
  check("ip-B allowed (independent)", otherIp.allowed && otherIp.count === 1);
});

// ── 3. different prefixes don't collide ────────────────────────────────
await group("different prefixes don't collide", async () => {
  m._resetRateLimitForTests();
  const opts = { windowMs: 60_000, max: 1 };
  const r1 = m.rateLimit("payment-ip", "key", opts);
  const r2 = m.rateLimit("payment-token", "key", opts);
  check("first prefix allowed", r1.allowed);
  check("different prefix, same key still allowed", r2.allowed);
});

// ── 4. window expiry — simulate by tiny windowMs + setTimeout ─────────
await group("window expiry releases the lock", async () => {
  m._resetRateLimitForTests();
  const opts = { windowMs: 80, max: 1 }; // 80ms window
  const r1 = m.rateLimit("p", "ip-X", opts);
  const r2 = m.rateLimit("p", "ip-X", opts);
  check("first allowed", r1.allowed);
  check("second rejected (within window)", !r2.allowed);
  await new Promise((r) => setTimeout(r, 100));
  const r3 = m.rateLimit("p", "ip-X", opts);
  check("after window, allowed again", r3.allowed, `count=${r3.count}`);
});

// ── 5. rejected attempt does NOT consume a slot ────────────────────────
await group("rejected attempt does not extend the window forever", async () => {
  m._resetRateLimitForTests();
  const opts = { windowMs: 80, max: 1 };
  m.rateLimit("p", "ip-Y", opts); // first allowed
  // Hammer rejections — none should push the original timestamp forward
  m.rateLimit("p", "ip-Y", opts);
  m.rateLimit("p", "ip-Y", opts);
  m.rateLimit("p", "ip-Y", opts);
  await new Promise((r) => setTimeout(r, 100));
  const after = m.rateLimit("p", "ip-Y", opts);
  check("after window expires, allowed again",
        after.allowed,
        `count=${after.count} retryAfterMs=${after.retryAfterMs}`);
});

console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`✅ passed: ${passed}   ❌ failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
