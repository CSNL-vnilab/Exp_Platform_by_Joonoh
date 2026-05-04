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
//
// Updated for Phase 2 to honor .is()/.or() on UPDATE so lock-acquire
// races test correctly. Each update is gated by the accumulated
// predicates; matching rows are mutated and the count returned.
function makeSb(state) {
  function fromImpl(table) {
    // SELECT predicates (eq + is) — fall through .then() / maybeSingle()
    const sFilt = {};
    const builder = {
      select() { return builder; },
      eq(c, v) { sFilt[c] = ["eq", v]; return builder; },
      is(c, v) { sFilt[c] = ["is", v]; return builder; },
      maybeSingle() {
        const row = (state[table] ?? []).find((r) => matches(r, sFilt)) ?? null;
        return Promise.resolve({ data: row, error: null });
      },
      then(resolve) {
        const rows = (state[table] ?? []).filter((r) => matches(r, sFilt));
        resolve({ data: rows, error: null });
      },
      update(payload, opts) {
        const wantCount = opts && opts.count === "exact";
        const uFilt = {};
        const orClauses = [];
        const u = {
          eq(c, v) { uFilt[c] = ["eq", v]; return u; },
          is(c, v) { uFilt[c] = ["is", v]; return u; },
          // Supabase .or("a.is.null,a.lt.X") — accept the same string
          // and parse into clauses we can evaluate.
          or(orStr) {
            for (const clause of orStr.split(",")) {
              const m = clause.match(/^([a-z_]+)\.([a-z]+)\.(.*)$/);
              if (!m) continue;
              orClauses.push([m[1], m[2], m[3]]);
            }
            return u;
          },
          select() { return u; },
          maybeSingle() {
            const targets = (state[table] ?? []).filter((r) =>
              matches(r, uFilt) && (orClauses.length === 0 || orMatches(r, orClauses)),
            );
            const out = { error: null, count: targets.length };
            for (const t of targets) Object.assign(t, payload);
            return Promise.resolve({ ...out, data: targets[0] ?? null });
          },
          then(resolve) {
            const targets = (state[table] ?? []).filter((r) =>
              matches(r, uFilt) && (orClauses.length === 0 || orMatches(r, orClauses)),
            );
            for (const t of targets) Object.assign(t, payload);
            resolve({
              error: null,
              count: wantCount ? targets.length : undefined,
              data: targets,
            });
          },
        };
        return u;
      },
    };
    return builder;
  }
  function matches(row, filt) {
    for (const [k, [op, v]] of Object.entries(filt)) {
      if (op === "eq" && row[k] !== v) return false;
      if (op === "is") {
        // .is("x", null) → row.x must be null/undefined
        if (v === null) {
          if (row[k] !== null && row[k] !== undefined) return false;
        } else if (row[k] !== v) return false;
      }
    }
    return true;
  }
  function orMatches(row, clauses) {
    return clauses.some(([col, op, val]) => {
      if (op === "is") {
        if (val === "null") return row[col] === null || row[col] === undefined;
        return false;
      }
      if (op === "lt") {
        if (row[col] == null) return false;
        return String(row[col]) < val;
      }
      if (op === "eq") return row[col] === val;
      return false;
    });
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
        payment_link_dispatch_lock_until: null,
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

// ── 5b. P0-Β invariant: rotation must update cipher in lockstep with hash
await group("rotation writes new cipher matching new hash (P0-Β)", async () => {
  const crypto = await import("../src/lib/crypto/payment-info.ts");
  // Seed a row with a stale cipher (decrypts to "stale-token") AND
  // first_opened_at unset → triggers the rotate branch (not preserve).
  const staleEnc = crypto.encryptToken("stale-token-from-seed.xxx.yyy.zzz");
  const toHex = (b) => "\\x" + b.toString("hex");
  const { state } = freshState({
    payment: {
      payment_link_first_opened_at: null,
      token_cipher: toHex(staleEnc.cipher),
      token_iv: toHex(staleEnc.iv),
      token_tag: toHex(staleEnc.tag),
      token_key_version: staleEnc.keyVersion,
    },
  });
  const sb = makeSb(state);
  const stubMailer = async () => ({ success: true });
  const { notifyPaymentInfoIfReady } = await import(
    "../src/lib/services/payment-info-notify.service.ts"
  );
  await notifyPaymentInfoIfReady(sb, groupId, stubMailer);

  const row = state.participant_payment_info[0];
  check("token_hash was rotated", row.token_hash !== "old-hash");
  // Decrypt the new cipher and verify its sha256 matches the new hash.
  // This is the invariant the page-level token check relies on.
  const newCipherBytes = Buffer.from(row.token_cipher.replace(/^\\x/, ""), "hex");
  const newIvBytes = Buffer.from(row.token_iv.replace(/^\\x/, ""), "hex");
  const newTagBytes = Buffer.from(row.token_tag.replace(/^\\x/, ""), "hex");
  const decrypted = crypto.decryptToken({
    cipher: newCipherBytes,
    iv: newIvBytes,
    tag: newTagBytes,
    keyVersion: row.token_key_version,
  });
  check("new cipher decrypts to a valid plaintext (not 'stale-token-…')",
        !decrypted.startsWith("stale-token"),
        `got ${decrypted.slice(0, 20)}…`);
  const { createHash } = await import("node:crypto");
  const expectedHash = createHash("sha256").update(decrypted).digest("hex");
  check("new cipher's plaintext hashes to the new token_hash",
        expectedHash === row.token_hash,
        `cipher→${expectedHash.slice(0, 12)}…  row→${row.token_hash.slice(0, 12)}…`);
});

// Same invariant for the decrypt-fallback rotation path.
await group("decrypt-fallback rotation writes new cipher matching new hash", async () => {
  const { state } = freshState({
    payment: {
      payment_link_first_opened_at: new Date().toISOString(),
      // corrupted cipher → triggers fallback rotation
      token_cipher: "\\xdeadbeef",
      token_iv: "\\xdeadbeefdeadbeefdeadbeef",
      token_tag: "\\xdeadbeefdeadbeefdeadbeefdeadbeef",
      token_key_version: 1,
    },
  });
  const sb = makeSb(state);
  const stubMailer = async () => ({ success: true });
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    const { notifyPaymentInfoIfReady } = await import(
      "../src/lib/services/payment-info-notify.service.ts"
    );
    await notifyPaymentInfoIfReady(sb, groupId, stubMailer);
  } finally {
    console.warn = realWarn;
  }
  const row = state.participant_payment_info[0];
  check("cipher was replaced (no longer the bad \\xdeadbeef)",
        !row.token_cipher.startsWith("\\xdeadbeef"));
  const crypto = await import("../src/lib/crypto/payment-info.ts");
  const decrypted = crypto.decryptToken({
    cipher: Buffer.from(row.token_cipher.replace(/^\\x/, ""), "hex"),
    iv: Buffer.from(row.token_iv.replace(/^\\x/, ""), "hex"),
    tag: Buffer.from(row.token_tag.replace(/^\\x/, ""), "hex"),
    keyVersion: row.token_key_version,
  });
  const { createHash } = await import("node:crypto");
  const expectedHash = createHash("sha256").update(decrypted).digest("hex");
  check("decrypted plaintext hashes to new token_hash",
        expectedHash === row.token_hash);
});

// ── Phase 2 / P0-Α: dispatch lock prevents concurrent double-send ────
await group("dispatch lock — second concurrent call returns lock_held without sending", async () => {
  const { state } = freshState();
  const sb = makeSb(state);
  const sendCalls = [];
  let inflight = 0;
  let maxInflight = 0;
  const slowMailer = async (opts) => {
    inflight++;
    if (inflight > maxInflight) maxInflight = inflight;
    sendCalls.push(opts);
    // Hold for a tick so the second caller sees the lock held.
    await new Promise((r) => setTimeout(r, 30));
    inflight--;
    return { success: true, messageId: `<m-${sendCalls.length}>` };
  };
  const { notifyPaymentInfoIfReady } = await import(
    "../src/lib/services/payment-info-notify.service.ts"
  );

  // Two concurrent calls against the same row.
  const [r1, r2] = await Promise.all([
    notifyPaymentInfoIfReady(sb, groupId, slowMailer),
    notifyPaymentInfoIfReady(sb, groupId, slowMailer),
  ]);
  const outcomes = [r1.outcome, r2.outcome].sort();
  check("exactly one outcome=sent",
        outcomes.filter((o) => o === "sent").length === 1,
        `outcomes=${outcomes.join(",")}`);
  check("the other is lock_held",
        outcomes.filter((o) => o === "lock_held").length === 1,
        `outcomes=${outcomes.join(",")}`);
  check("only one SMTP call fired", sendCalls.length === 1,
        `sendCalls=${sendCalls.length}`);
  check("never had >1 in-flight at once", maxInflight === 1, `max=${maxInflight}`);
  check("sent_at stamped exactly once",
        state.participant_payment_info[0].payment_link_sent_at !== null);
  check("lock released after success",
        state.participant_payment_info[0].payment_link_dispatch_lock_until === null);
});

await group("dispatch lock — released on send failure so retry can proceed", async () => {
  const { state } = freshState();
  const sb = makeSb(state);
  let attempt = 0;
  const flakyMailer = async () => {
    attempt++;
    if (attempt === 1) return { success: false, error: "smtp 451 transient" };
    return { success: true, messageId: "<m-retry>" };
  };
  const { notifyPaymentInfoIfReady } = await import(
    "../src/lib/services/payment-info-notify.service.ts"
  );

  const r1 = await notifyPaymentInfoIfReady(sb, groupId, flakyMailer);
  check("first attempt outcome=send_failed", r1.outcome === "send_failed");
  check("lock released after failure (next retry not blocked)",
        state.participant_payment_info[0].payment_link_dispatch_lock_until === null);

  const r2 = await notifyPaymentInfoIfReady(sb, groupId, flakyMailer);
  check("immediate retry succeeds (no lock-held)",
        r2.outcome === "sent",
        `outcome=${r2.outcome}`);
});

await group("dispatch lock — expired lease lets next trigger proceed", async () => {
  const expiredLockIso = new Date(Date.now() - 60_000).toISOString();
  const { state } = freshState({
    payment: { payment_link_dispatch_lock_until: expiredLockIso },
  });
  const sb = makeSb(state);
  const sendCalls = [];
  const stubMailer = async (opts) => {
    sendCalls.push(opts);
    return { success: true };
  };
  const { notifyPaymentInfoIfReady } = await import(
    "../src/lib/services/payment-info-notify.service.ts"
  );
  const result = await notifyPaymentInfoIfReady(sb, groupId, stubMailer);
  check("expired lock → outcome=sent", result.outcome === "sent");
  check("email actually sent", sendCalls.length === 1);
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
