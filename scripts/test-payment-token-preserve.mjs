#!/usr/bin/env node
/**
 * QC for the P0 #6 token-preserve flow.
 *
 * Verifies:
 *   - encryptToken/decryptToken round-trip
 *   - notify service preserves token when participant opened the link
 *     (payment_link_first_opened_at != null AND token_cipher present)
 *   - notify service rotates token when participant did NOT open
 *   - notify service rotates token on legacy rows (no token_cipher)
 *   - notify service falls back to rotation when decrypt throws
 *   - email template (isReminder=true) uses the "재안내" subject + body
 *
 * Stubbed Supabase + injected mailer so no real DB / SMTP.
 */

process.env.PAYMENT_TOKEN_SECRET ||= "test-token-secret-" + "x".repeat(40);
process.env.PAYMENT_INFO_KEY ||= "test-key-" + "y".repeat(40);
process.env.NEXT_PUBLIC_APP_URL ||= "https://test.local";

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

// ── 1. crypto round-trip ──────────────────────────────────────────────
await group("encryptToken / decryptToken round-trip", async () => {
  const m = await import("../src/lib/crypto/payment-info.ts");
  const plaintext = "abc.123456789.deadbeef.signature";
  const enc = m.encryptToken(plaintext);
  check("cipher non-empty", enc.cipher.length > 0);
  check("iv 12 bytes (GCM)", enc.iv.length === 12);
  check("tag 16 bytes", enc.tag.length === 16);
  check("keyVersion = 1", enc.keyVersion === 1);
  const dec = m.decryptToken(enc);
  check("round-trip recovers plaintext", dec === plaintext);

  // tamper detection
  enc.cipher[0] ^= 0xff;
  let threw = false;
  try { m.decryptToken(enc); } catch { threw = true; }
  check("tampered cipher rejected by GCM", threw);
});

// ── Stubbed Supabase ──────────────────────────────────────────────────
function makeSb(state) {
  function fromImpl(table) {
    const filt = {};
    const builder = {
      select() { return builder; },
      eq(c, v) { filt[c] = v; return builder; },
      is() { return builder; },
      maybeSingle() {
        const row = (state[table] ?? []).find((r) =>
          Object.entries(filt).every(([k, v]) => r[k] === v),
        ) ?? null;
        return Promise.resolve({ data: row, error: null });
      },
      then(resolve) {
        const rows = (state[table] ?? []).filter((r) =>
          Object.entries(filt).every(([k, v]) => r[k] === v),
        );
        resolve({ data: rows, error: null });
      },
      update(payload) {
        const updateBuilder = {
          eq(c, v) {
            const target = (state[table] ?? []).find((r) => r[c] === v);
            if (target) Object.assign(target, payload);
            return updateBuilder;
          },
          is() { return updateBuilder; },
          then(resolve) { resolve({ error: null, count: 1 }); },
        };
        return updateBuilder;
      },
    };
    return builder;
  }
  return { from: fromImpl };
}

const groupId = "11111111-2222-3333-4444-555555555555";

function freshState(overrides = {}) {
  return {
    state: {
      participant_payment_info: [{
        id: "pi-1",
        booking_group_id: groupId,
        experiment_id: "exp-1",
        participant_id: "p-1",
        amount_krw: 30000,
        status: "pending_participant",
        token_hash: "old-hash",
        token_issued_at: new Date().toISOString(),
        token_expires_at: new Date(Date.now() + 30 * 86400_000).toISOString(),
        payment_link_sent_at: null,
        payment_link_attempts: 0,
        payment_link_first_opened_at: null,
        token_cipher: null,
        token_iv: null,
        token_tag: null,
        token_key_version: null,
        period_start: "2026-04-01",
        period_end: "2026-04-01",
        name_override: null,
        email_override: null,
        ...(overrides.payment ?? {}),
      }],
      bookings: [{ booking_group_id: groupId, status: "completed" }],
      participants: [{ id: "p-1", name: "홍길동", email: "p@test.local" }],
      experiments: [{ id: "exp-1", title: "테스트", created_by: null }],
      profiles: [],
    },
  };
}

// ── 2. preserve path: opened + token_cipher present ───────────────────
await group("preserves token when user opened link AND cipher available", async () => {
  const crypto = await import("../src/lib/crypto/payment-info.ts");
  const originalToken = "preserved-token-payload.123.xyz.sig";
  const enc = crypto.encryptToken(originalToken);
  const toHex = (b) => "\\x" + b.toString("hex");
  const { state } = freshState({
    payment: {
      payment_link_first_opened_at: new Date(Date.now() - 60_000).toISOString(),
      token_cipher: toHex(enc.cipher),
      token_iv: toHex(enc.iv),
      token_tag: toHex(enc.tag),
      token_key_version: enc.keyVersion,
    },
  });
  const sb = makeSb(state);
  const sendCalls = [];
  const stubMailer = async (opts) => {
    sendCalls.push(opts);
    return { success: true, messageId: "<m1>" };
  };
  const { notifyPaymentInfoIfReady } = await import(
    "../src/lib/services/payment-info-notify.service.ts"
  );
  const result = await notifyPaymentInfoIfReady(sb, groupId, stubMailer);
  check("outcome = sent", result.outcome === "sent");
  check("token_hash NOT rotated (stays 'old-hash')",
        state.participant_payment_info[0].token_hash === "old-hash",
        `got ${state.participant_payment_info[0].token_hash}`);
  check("email URL contains the original preserved token",
        sendCalls[0].html.includes(encodeURIComponent(originalToken)),
        "URL did not include original token");
  check("subject includes (재안내)",
        sendCalls[0].subject.includes("재안내"));
  check("body has 동일한 링크 wording",
        sendCalls[0].html.includes("동일한 링크"));
});

// ── 3. rotate path: opened but no cipher (legacy row) ─────────────────
await group("rotates token on legacy row (no token_cipher) even if opened", async () => {
  const { state } = freshState({
    payment: {
      payment_link_first_opened_at: new Date().toISOString(),
      // token_cipher etc. stay null
    },
  });
  const sb = makeSb(state);
  const stubMailer = async () => ({ success: true });
  const { notifyPaymentInfoIfReady } = await import(
    "../src/lib/services/payment-info-notify.service.ts"
  );
  const result = await notifyPaymentInfoIfReady(sb, groupId, stubMailer);
  check("outcome = sent", result.outcome === "sent");
  check("token_hash WAS rotated",
        state.participant_payment_info[0].token_hash !== "old-hash");
});

// ── 4. rotate path: cipher present but never opened ───────────────────
await group("rotates token when participant never opened the link", async () => {
  const crypto = await import("../src/lib/crypto/payment-info.ts");
  const enc = crypto.encryptToken("never-opened.token.xyz.sig");
  const toHex = (b) => "\\x" + b.toString("hex");
  const { state } = freshState({
    payment: {
      payment_link_first_opened_at: null,
      token_cipher: toHex(enc.cipher),
      token_iv: toHex(enc.iv),
      token_tag: toHex(enc.tag),
      token_key_version: enc.keyVersion,
    },
  });
  const sb = makeSb(state);
  const stubMailer = async () => ({ success: true });
  const { notifyPaymentInfoIfReady } = await import(
    "../src/lib/services/payment-info-notify.service.ts"
  );
  await notifyPaymentInfoIfReady(sb, groupId, stubMailer);
  check("token_hash rotated",
        state.participant_payment_info[0].token_hash !== "old-hash");
});

// ── 5. rotate path: cipher corrupt → fallback ─────────────────────────
await group("falls back to rotation when decryptToken throws", async () => {
  const { state } = freshState({
    payment: {
      payment_link_first_opened_at: new Date().toISOString(),
      // Wrong-shape ciphertext — decrypt will throw
      token_cipher: "\\xdeadbeef",
      token_iv: "\\xdeadbeefdeadbeefdeadbeef",
      token_tag: "\\xdeadbeefdeadbeefdeadbeefdeadbeef",
      token_key_version: 1,
    },
  });
  const sb = makeSb(state);
  const stubMailer = async () => ({ success: true });
  const { notifyPaymentInfoIfReady } = await import(
    "../src/lib/services/payment-info-notify.service.ts"
  );
  // Suppress the warn log noise from intentional decrypt failure.
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    const result = await notifyPaymentInfoIfReady(sb, groupId, stubMailer);
    check("still sent (graceful fallback)", result.outcome === "sent");
    check("token_hash rotated as fallback",
          state.participant_payment_info[0].token_hash !== "old-hash");
  } finally {
    console.warn = realWarn;
  }
});

// ── 6. email template: isReminder shapes subject + intro ──────────────
await group("payment-info-email-template — isReminder branch", async () => {
  const m = await import("../src/lib/services/payment-info-email-template.ts");
  const built = m.buildPaymentInfoEmail({
    participantName: "홍",
    participantEmail: "p@t.local",
    experimentTitle: "T",
    amountKrw: 1000,
    paymentUrl: "https://t.local/payment-info/abc",
    periodStart: null,
    periodEnd: null,
    researcher: null,
    tokenExpiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
    isReminder: true,
  });
  check("subject ends with (재안내)", built.subject.endsWith("(재안내)"));
  check("body has '동일한 링크' wording", built.html.includes("동일한 링크"));
  check("body has '이미 입력 중이셨다면' wording",
        built.html.includes("이미 입력 중이셨다면"));
});

await group("payment-info-email-template — default (no isReminder)", async () => {
  const m = await import("../src/lib/services/payment-info-email-template.ts");
  const built = m.buildPaymentInfoEmail({
    participantName: "홍",
    participantEmail: "p@t.local",
    experimentTitle: "T",
    amountKrw: 1000,
    paymentUrl: "https://t.local/payment-info/abc",
    periodStart: null,
    periodEnd: null,
    researcher: null,
    tokenExpiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
  });
  check("subject does NOT end with (재안내)", !built.subject.endsWith("(재안내)"));
  check("body does NOT have '동일한 링크' wording", !built.html.includes("동일한 링크"));
});

console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`✅ passed: ${passed}   ❌ failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
