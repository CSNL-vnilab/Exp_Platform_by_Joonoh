#!/usr/bin/env node
/**
 * Unit tests for src/lib/services/payment-info-notify.service.ts
 *
 * Exercises every branch of notifyPaymentInfoIfReady against a stub
 * Supabase client + a stub sendEmail. No SMTP, no Supabase, no DB.
 *
 * Branches covered:
 *   1. no_payment_row       — group has no payment_info entry
 *   2. amount_zero          — payment_info.amount_krw === 0
 *   3. already_sent         — payment_link_sent_at already populated
 *   4. status != pending    — row already submitted (auto-stamps sent_at)
 *   5. not_all_completed    — at least one booking still pending
 *   6. no_recipient         — neither participant.email nor email_override
 *   7. send_failed          — sendEmail returns success:false
 *   8. sent (happy path)    — email goes out, sent_at stamped
 *   9. token rotation       — token_hash is updated even when not expired
 *
 * Run: node --import tsx scripts/test-payment-info-notify.mjs
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Sentinel envs so token issuance / encrypt helpers don't crash.
process.env.PAYMENT_TOKEN_SECRET ||= "test-token-secret-" + "x".repeat(40);
process.env.PAYMENT_INFO_KEY ||= "test-key-" + "y".repeat(40);
process.env.NEXT_PUBLIC_APP_URL ||= "https://test.local";

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
  try {
    await fn();
  } catch (err) {
    failed++;
    console.log(`  ❌ ${label} crashed: ${err.message}\n${err.stack ?? ""}`);
  }
}

// ── Stubs ────────────────────────────────────────────────────────────────

/**
 * Stub Supabase client. Each test rebuilds it fresh with a fixture data
 * map. Captures all .update() payloads in `updates` for assertions.
 */
function makeStubSupabase(state) {
  const updates = [];

  function fromImpl(table) {
    let _filter = {};
    let _select = "";
    let _count = false;
    const builder = {
      select(cols, opts) {
        _select = cols;
        _count = !!opts?.count;
        return builder;
      },
      eq(col, val) {
        _filter[col] = val;
        return builder;
      },
      in(col, vals) {
        _filter[col] = { in: vals };
        return builder;
      },
      is(col, val) {
        _filter[col] = { is: val };
        return builder;
      },
      gt(col, val) {
        _filter[col] = { gt: val };
        return builder;
      },
      limit() {
        return builder;
      },
      maybeSingle() {
        const row = state[table]?.find((r) => matches(r, _filter)) ?? null;
        return Promise.resolve({ data: row, error: null });
      },
      then(resolve) {
        // List form .select(...).eq(...) without maybeSingle() — used by
        // the bookings query.
        const rows = (state[table] ?? []).filter((r) => matches(r, _filter));
        resolve({ data: rows, error: null });
      },
      update(payload, opts) {
        let _filterPath = {};
        const _orClauses = [];
        const updateBuilder = {
          eq(col, val) {
            _filterPath[col] = val;
            return updateBuilder;
          },
          is(col, val) {
            _filterPath[col] = { is: val };
            return updateBuilder;
          },
          // Phase 2 lock-acquire uses .or("a.is.null,a.lt.X") — accept
          // and parse for predicate evaluation.
          or(orStr) {
            for (const clause of String(orStr).split(",")) {
              const m = clause.match(/^([a-z_]+)\.([a-z]+)\.(.*)$/);
              if (!m) continue;
              _orClauses.push([m[1], m[2], m[3]]);
            }
            return updateBuilder;
          },
          select() { return updateBuilder; },
          then(resolve) {
            const targets = (state[table] ?? []).filter((r) =>
              matches(r, _filterPath) &&
              (_orClauses.length === 0 || _orMatches(r, _orClauses)),
            );
            for (const t of targets) {
              Object.assign(t, payload);
            }
            updates.push({ table, payload, filter: { ..._filterPath }, count: targets.length });
            resolve({ error: null, count: opts?.count === "exact" ? targets.length : undefined });
          },
        };
        return updateBuilder;
      },
    };
    return builder;
  }

  // P0-Α lock-acquire UPDATE uses .or("a.is.null,a.lt.X") — clause
  // evaluator for the stub. Returns true if ANY clause matches.
  function _orMatches(row, clauses) {
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

  function matches(row, filter) {
    for (const [k, v] of Object.entries(filter)) {
      if (v && typeof v === "object" && "is" in v) {
        if (v.is === null) {
          if (row[k] !== null && row[k] !== undefined) return false;
        } else if (row[k] !== v.is) return false;
      } else if (v && typeof v === "object" && "in" in v) {
        if (!v.in.includes(row[k])) return false;
      } else if (v && typeof v === "object" && "gt" in v) {
        if (!(row[k] > v.gt)) return false;
      } else if (row[k] !== v) {
        return false;
      }
    }
    return true;
  }

  return { from: fromImpl, _updates: updates };
}

// Mailer stub. The service accepts an injectable mailer (default = real
// gmail.sendEmail) so we don't need to monkey-patch ESM exports.
let pendingSendResult = { success: true, messageId: "<stub@test.local>" };
const sendEmailCalls = [];
const stubMailer = async (opts) => {
  sendEmailCalls.push(opts);
  return pendingSendResult;
};

const { notifyPaymentInfoIfReady } = await import(
  "../src/lib/services/payment-info-notify.service.ts"
);

function freshFixture(overrides = {}) {
  const groupId = "11111111-2222-3333-4444-555555555555";
  return {
    groupId,
    state: {
      participant_payment_info: [
        {
          id: "pi-1",
          booking_group_id: groupId,
          experiment_id: "exp-1",
          participant_id: "p-1",
          amount_krw: 30000,
          status: "pending_participant",
          token_hash: "old-hash",
          token_issued_at: new Date().toISOString(),
          token_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          payment_link_sent_at: null,
          payment_link_attempts: 0,
          period_start: "2026-04-01",
          period_end: "2026-04-01",
          name_override: null,
          email_override: null,
          ...(overrides.payment ?? {}),
        },
      ],
      bookings: overrides.bookings ?? [
        { booking_group_id: groupId, status: "completed" },
      ],
      participants: [
        {
          id: "p-1",
          name: "홍길동",
          email: "honggildong@test.local",
        },
      ],
      experiments: [
        {
          id: "exp-1",
          title: "[테스트] 결제정보 발송",
          created_by: "u-1",
        },
      ],
      profiles: [
        {
          id: "u-1",
          display_name: "이연구원",
          contact_email: "researcher@test.local",
          phone: "010-0000-0000",
        },
      ],
    },
  };
}

// ── 1. no_payment_row ────────────────────────────────────────────────────
await group("no payment_info row → no_payment_row", async () => {
  const { groupId, state } = freshFixture();
  state.participant_payment_info = [];
  const sb = makeStubSupabase(state);
  sendEmailCalls.length = 0;
  const result = await notifyPaymentInfoIfReady(sb, groupId, stubMailer);
  check("outcome=no_payment_row", result.outcome === "no_payment_row", `got ${result.outcome}`);
  check("no email sent", sendEmailCalls.length === 0);
});

// ── 2. amount_zero ───────────────────────────────────────────────────────
await group("amount_krw=0 → amount_zero", async () => {
  const { groupId, state } = freshFixture({ payment: { amount_krw: 0 } });
  const sb = makeStubSupabase(state);
  sendEmailCalls.length = 0;
  const result = await notifyPaymentInfoIfReady(sb, groupId, stubMailer);
  check("outcome=amount_zero", result.outcome === "amount_zero");
  check("no email sent", sendEmailCalls.length === 0);
});

// ── 3. already_sent ──────────────────────────────────────────────────────
await group("payment_link_sent_at non-null → already_sent", async () => {
  const { groupId, state } = freshFixture({
    payment: { payment_link_sent_at: new Date().toISOString() },
  });
  const sb = makeStubSupabase(state);
  sendEmailCalls.length = 0;
  const result = await notifyPaymentInfoIfReady(sb, groupId, stubMailer);
  check("outcome=already_sent", result.outcome === "already_sent");
  check("no email sent", sendEmailCalls.length === 0);
});

// ── 4. status != pending (already submitted) ─────────────────────────────
await group("status=submitted_to_admin → already_sent + auto-stamp", async () => {
  const { groupId, state } = freshFixture({
    payment: { status: "submitted_to_admin" },
  });
  const sb = makeStubSupabase(state);
  sendEmailCalls.length = 0;
  const result = await notifyPaymentInfoIfReady(sb, groupId, stubMailer);
  check("outcome=already_sent", result.outcome === "already_sent");
  check("no email sent", sendEmailCalls.length === 0);
  check(
    "sent_at auto-stamped",
    state.participant_payment_info[0].payment_link_sent_at !== null,
  );
});

// ── 5. not_all_completed ─────────────────────────────────────────────────
await group("partial completion → not_all_completed", async () => {
  const { groupId, state } = freshFixture({
    bookings: [
      { booking_group_id: "11111111-2222-3333-4444-555555555555", status: "completed" },
      { booking_group_id: "11111111-2222-3333-4444-555555555555", status: "confirmed" },
    ],
  });
  const sb = makeStubSupabase(state);
  sendEmailCalls.length = 0;
  const result = await notifyPaymentInfoIfReady(sb, groupId, stubMailer);
  check("outcome=not_all_completed", result.outcome === "not_all_completed");
  check("no email sent", sendEmailCalls.length === 0);
});

// ── 5b. zero bookings (orphan row) ───────────────────────────────────────
await group("zero bookings (cascade race) → not_all_completed", async () => {
  const { groupId, state } = freshFixture({ bookings: [] });
  const sb = makeStubSupabase(state);
  sendEmailCalls.length = 0;
  const result = await notifyPaymentInfoIfReady(sb, groupId, stubMailer);
  check("outcome=not_all_completed", result.outcome === "not_all_completed");
});

// ── 6. no_recipient ──────────────────────────────────────────────────────
await group("empty participant email → no_recipient", async () => {
  const { groupId, state } = freshFixture();
  state.participants[0].email = "";
  const sb = makeStubSupabase(state);
  sendEmailCalls.length = 0;
  const result = await notifyPaymentInfoIfReady(sb, groupId, stubMailer);
  check("outcome=no_recipient", result.outcome === "no_recipient", `got ${result.outcome}`);
  check("no email sent", sendEmailCalls.length === 0);
  check(
    "last_error stamped",
    state.participant_payment_info[0].payment_link_last_error?.includes("no recipient"),
  );
});

// ── 7. send_failed ──────────────────────────────────────────────────────
await group("sendEmail returns failure → send_failed", async () => {
  const { groupId, state } = freshFixture();
  pendingSendResult = { success: false, error: "smtp 451 service busy" };
  const sb = makeStubSupabase(state);
  sendEmailCalls.length = 0;
  const result = await notifyPaymentInfoIfReady(sb, groupId, stubMailer);
  check("outcome=send_failed", result.outcome === "send_failed");
  check("attempts incremented", state.participant_payment_info[0].payment_link_attempts === 1);
  check(
    "last_error captured",
    state.participant_payment_info[0].payment_link_last_error?.includes("smtp 451"),
  );
  check(
    "sent_at still null",
    state.participant_payment_info[0].payment_link_sent_at === null,
  );
});

// ── 8. happy path ────────────────────────────────────────────────────────
await group("all conditions met → sent", async () => {
  pendingSendResult = { success: true, messageId: "<msg-1@test.local>" };
  const { groupId, state } = freshFixture();
  const sb = makeStubSupabase(state);
  sendEmailCalls.length = 0;
  const result = await notifyPaymentInfoIfReady(sb, groupId, stubMailer);
  check("outcome=sent", result.outcome === "sent", `got ${result.outcome} ${result.detail}`);
  check("one email sent", sendEmailCalls.length === 1);
  const sent = sendEmailCalls[0];
  check("email recipient is participant", sent.to === "honggildong@test.local");
  check("subject mentions experiment", sent.subject.includes("결제정보 발송") || sent.subject.includes("정산"));
  check("html contains payment URL", sent.html.includes("/payment-info/"));
  check("html contains amount", sent.html.includes("30,000"));
  check(
    "html contains researcher contact",
    sent.html.includes("researcher@test.local"),
  );
  check(
    "sent_at stamped",
    state.participant_payment_info[0].payment_link_sent_at !== null,
  );
  check("attempts incremented", state.participant_payment_info[0].payment_link_attempts === 1);
  check(
    "last_error cleared",
    state.participant_payment_info[0].payment_link_last_error === null,
  );
  check(
    "token_hash rotated",
    state.participant_payment_info[0].token_hash !== "old-hash",
    `still ${state.participant_payment_info[0].token_hash}`,
  );
});

// ── 9. email_override / name_override take precedence ─────────────────────
await group("email_override beats participants.email", async () => {
  pendingSendResult = { success: true, messageId: "<msg-2@test.local>" };
  const { groupId, state } = freshFixture({
    payment: { email_override: "override@test.local", name_override: "변경된이름" },
  });
  const sb = makeStubSupabase(state);
  sendEmailCalls.length = 0;
  const result = await notifyPaymentInfoIfReady(sb, groupId, stubMailer);
  check("outcome=sent", result.outcome === "sent");
  const sent = sendEmailCalls[0];
  check("recipient = override", sent.to === "override@test.local");
  check("html includes name_override", sent.html.includes("변경된이름"));
});

// ── 10. URL formed from APP_URL ───────────────────────────────────────────
await group("URL uses NEXT_PUBLIC_APP_URL", async () => {
  pendingSendResult = { success: true };
  const { groupId, state } = freshFixture();
  const sb = makeStubSupabase(state);
  sendEmailCalls.length = 0;
  await notifyPaymentInfoIfReady(sb, groupId, stubMailer);
  const sent = sendEmailCalls[0];
  check(
    "url is absolute (https://test.local/payment-info/...)",
    sent.html.includes("https://test.local/payment-info/"),
  );
});

// ── Summary ───────────────────────────────────────────────────────────────
console.log(
  `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
);
console.log(`✅ passed: ${passed}   ❌ failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
