#!/usr/bin/env node
/**
 * QC for booking-status-email + booking-status-notify.service (P0 #2).
 *
 * Covers:
 *   - cancellation email: subject, body content, multi-session block,
 *     researcher contact preference, rebook CTA gating by mode,
 *     placeholder-env safety
 *   - no-show email: same axes, with the "다시 참여" disclaimer
 *   - SMS bodies: subject prefix, length under 80 chars typical case
 *   - notify service: stubbed Supabase + injected mailer/texter, all
 *     branches (booking_not_found, no_recipient, sent w/ + w/o SMS)
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

const baseInput = {
  participant: { name: "홍길동", email: "honggildong@test.local" },
  booking: {
    id: "b-1",
    slot_start: "2026-05-10T05:00:00Z", // 14:00 KST
    slot_end: "2026-05-10T06:00:00Z",
    session_number: 1,
  },
  experiment: {
    id: "e-1",
    title: "[테스트] 시각 실험",
    experiment_mode: "offline",
  },
  researcher: {
    display_name: "이연구원",
    contact_email: "researcher@test.local",
    email: "ilab@x.local",
    phone: "010-1111-2222",
  },
  otherActiveSessions: [],
  appOrigin: "https://lab.test.local",
};

// ── 1. cancellation email ──────────────────────────────────────────────
await group("cancellation email — happy path, single session, offline", async () => {
  const m = await import("../src/lib/services/booking-status-email.ts");
  const built = m.buildCancellationEmail(baseInput);
  check("recipient is participant", built.to === "honggildong@test.local");
  check("subject mentions title + cancel", built.subject.includes("취소") && built.subject.includes("시각 실험"));
  check("subject does NOT include session # for single session",
        !built.subject.includes("(1회차)"));
  check("body mentions name", built.html.includes("홍길동"));
  check("body apologetic tone", built.html.includes("양해"));
  check("body has line-through old slot", built.html.includes("text-decoration:line-through"));
  check("body has researcher email", built.html.includes("researcher@test.local"));
  check("body has researcher phone", built.html.includes("010-1111-2222"));
  check("offline → rebook CTA shown", built.html.includes("/book/") && built.html.includes("다시 예약"));
  check("no placeholder leak", !built.html.includes("contact@example.com"));
});

await group("cancellation email — online experiment hides rebook CTA", async () => {
  const m = await import("../src/lib/services/booking-status-email.ts");
  const built = m.buildCancellationEmail({
    ...baseInput,
    experiment: { ...baseInput.experiment, experiment_mode: "online" },
  });
  check("online → no rebook CTA", !built.html.includes("/book/"));
});

await group("cancellation email — multi-session block lists siblings", async () => {
  const m = await import("../src/lib/services/booking-status-email.ts");
  const built = m.buildCancellationEmail({
    ...baseInput,
    booking: { ...baseInput.booking, session_number: 1 },
    otherActiveSessions: [
      { slot_start: "2026-05-12T05:00:00Z", session_number: 2 },
      { slot_start: "2026-05-14T05:00:00Z", session_number: 3 },
    ],
  });
  check("body says 이번 회차만", built.html.includes("이번 회차만"));
  check("body says 취소", built.html.includes("취소되었으며"));
  check("body lists 2회차", built.html.includes("(2회차)"));
  check("body lists 3회차", built.html.includes("(3회차)"));
});

await group("cancellation email — multi-session subject includes (회차)", async () => {
  const m = await import("../src/lib/services/booking-status-email.ts");
  const built = m.buildCancellationEmail({
    ...baseInput,
    booking: { ...baseInput.booking, session_number: 2 },
  });
  check("subject contains (2회차)", built.subject.includes("(2회차)"));
});

// ── 2. no_show email ──────────────────────────────────────────────────
await group("no_show email — happy path", async () => {
  const m = await import("../src/lib/services/booking-status-email.ts");
  const built = m.buildNoShowEmail(baseInput);
  check("subject mentions 결석", built.subject.includes("결석"));
  check("body uses non-blaming language", built.html.includes("피치 못할"));
  check("body has 'contact researcher' line", built.html.includes("다시 참여 가능 여부"));
  check("body does NOT show rebook CTA (no_show is terminal)",
        !built.html.includes("/book/"));
  check("researcher block present", built.html.includes("researcher@test.local"));
});

await group("no_show email — multi-session uses 결석 처리 phrase", async () => {
  const m = await import("../src/lib/services/booking-status-email.ts");
  const built = m.buildNoShowEmail({
    ...baseInput,
    otherActiveSessions: [
      { slot_start: "2026-05-12T05:00:00Z", session_number: 2 },
    ],
  });
  check("body mentions 결석 처리되었으며", built.html.includes("결석 처리되었으며"));
});

// ── 3. researcher fallback chain ──────────────────────────────────────
//
// The lab-inbox fallback (brandContactEmailOrNull) is exercised in
// scripts/test-branding-placeholder.mjs. We can't re-test it here by
// mutating process.env at runtime because branding constants are
// captured at module-load time and ESM module caching defeats
// cache-busting tricks. Instead we verify the second-tier fallback
// (researcher.email when contact_email is null), and the no-leak
// behaviour with everything unset.
await group("researcher contact_email null → falls back to researcher.email", async () => {
  const m = await import("../src/lib/services/booking-status-email.ts");
  const built = m.buildCancellationEmail({
    ...baseInput,
    researcher: {
      display_name: "이연구원",
      contact_email: null,
      email: "secondary@test.local",
      phone: null,
    },
  });
  check("uses researcher.email as fallback",
        built.html.includes("secondary@test.local"));
});

await group("no researcher + no env-configured lab inbox → no email line, no leak", async () => {
  const m = await import("../src/lib/services/booking-status-email.ts");
  const built = m.buildCancellationEmail({
    ...baseInput,
    researcher: { display_name: null, contact_email: null, email: null, phone: null },
  });
  check("no placeholder leak", !built.html.includes("contact@example.com"));
  check("no empty mailto", !built.html.includes("mailto:\""));
  check("researcher header still present (graceful)",
        built.html.includes("담당 연구원 · 문의"));
});

// ── 4. SMS bodies ──────────────────────────────────────────────────────
await group("SMS bodies", async () => {
  const m = await import("../src/lib/services/booking-status-email.ts");
  const cancel = m.buildCancellationSMS(baseInput);
  const noShow = m.buildNoShowSMS(baseInput);
  check("cancel SMS starts with [BRAND]", /^\[.+\] 예약 취소/.test(cancel));
  check("no_show SMS starts with [BRAND]", /^\[.+\] 결석 기록/.test(noShow));
  check("cancel SMS includes participant name", cancel.includes("홍길동"));
  check("cancel SMS includes researcher contact", cancel.includes("researcher@test.local"));
  check("cancel SMS reasonable length (<160 chars)", cancel.length < 160, `len=${cancel.length}`);
  check("no_show SMS reasonable length (<160 chars)", noShow.length < 160, `len=${noShow.length}`);
});

// ── 5. notify service — branches via stubs ────────────────────────────
await group("notify service — booking_not_found", async () => {
  const sb = makeSupabaseStub({ bookings: [] });
  const { notifyBookingStatusChange } = await import(
    "../src/lib/services/booking-status-notify.service.ts"
  );
  const result = await notifyBookingStatusChange(
    sb, "missing", "cancelled",
    async () => ({ success: true }),
    async () => ({ success: true }),
  );
  check("outcome = booking_not_found", result.outcome === "booking_not_found");
});

await group("notify service — no_recipient when participant.email empty", async () => {
  const sb = makeSupabaseStub({
    bookings: [{
      id: "b-1", slot_start: "2026-05-10T05:00:00Z", slot_end: "2026-05-10T06:00:00Z",
      session_number: 1, booking_group_id: null, participant_id: "p-1", experiment_id: "e-1",
      participants: { name: "홍", email: "", phone: "010" },
      experiments: { id: "e-1", title: "T", experiment_mode: "offline", created_by: null },
    }],
  });
  const { notifyBookingStatusChange } = await import(
    "../src/lib/services/booking-status-notify.service.ts"
  );
  const result = await notifyBookingStatusChange(
    sb, "b-1", "cancelled",
    async () => ({ success: true }),
    async () => ({ success: true }),
  );
  check("outcome = no_recipient", result.outcome === "no_recipient", `got ${result.outcome}`);
});

await group("notify service — happy path sends email only (no SOLAPI env)", async () => {
  const sb = makeSupabaseStub({
    bookings: [{
      id: "b-1", slot_start: "2026-05-10T05:00:00Z", slot_end: "2026-05-10T06:00:00Z",
      session_number: 1, booking_group_id: null, participant_id: "p-1", experiment_id: "e-1",
      participants: { name: "홍길동", email: "p@x.local", phone: "010-1234-5678" },
      experiments: { id: "e-1", title: "T", experiment_mode: "offline", created_by: null },
    }],
    profiles: [],
  });
  const sendCalls = [];
  const smsCalls = [];
  const { notifyBookingStatusChange } = await import(
    "../src/lib/services/booking-status-notify.service.ts"
  );
  const result = await notifyBookingStatusChange(
    sb, "b-1", "cancelled",
    async (opts) => { sendCalls.push(opts); return { success: true, messageId: "<id1>" }; },
    async (to, t) => { smsCalls.push({ to, t }); return { success: true }; },
  );
  check("outcome = sent", result.outcome === "sent");
  check("channel = email (no SOLAPI env in test)", result.channel === "email");
  check("email sent once", sendCalls.length === 1);
  check("email recipient correct", sendCalls[0].to === "p@x.local");
  check("SMS not invoked without env", smsCalls.length === 0);
});

await group("notify service — send_failed bubbles up", async () => {
  const sb = makeSupabaseStub({
    bookings: [{
      id: "b-1", slot_start: "2026-05-10T05:00:00Z", slot_end: "2026-05-10T06:00:00Z",
      session_number: 1, booking_group_id: null, participant_id: "p-1", experiment_id: "e-1",
      participants: { name: "홍", email: "p@x.local", phone: "010" },
      experiments: { id: "e-1", title: "T", experiment_mode: "offline", created_by: null },
    }],
    profiles: [],
  });
  const { notifyBookingStatusChange } = await import(
    "../src/lib/services/booking-status-notify.service.ts"
  );
  const result = await notifyBookingStatusChange(
    sb, "b-1", "no_show",
    async () => ({ success: false, error: "smtp 451" }),
    async () => ({ success: true }),
  );
  check("outcome = send_failed", result.outcome === "send_failed");
  check("detail captured", (result.detail ?? "").includes("smtp 451"));
});

await group("notify service — multi-session pulls siblings", async () => {
  const groupId = "g-1";
  const sb = makeSupabaseStub({
    bookings: [
      {
        id: "b-1", slot_start: "2026-05-10T05:00:00Z", slot_end: "2026-05-10T06:00:00Z",
        session_number: 1, booking_group_id: groupId, participant_id: "p-1", experiment_id: "e-1",
        participants: { name: "홍", email: "p@x.local", phone: "010" },
        experiments: { id: "e-1", title: "T", experiment_mode: "offline", created_by: null },
      },
      // sibling 1 — confirmed
      {
        id: "b-2", slot_start: "2026-05-12T05:00:00Z", slot_end: "2026-05-12T06:00:00Z",
        session_number: 2, booking_group_id: groupId, status: "confirmed",
      },
      // sibling 2 — already cancelled (should be excluded)
      {
        id: "b-3", slot_start: "2026-05-14T05:00:00Z", slot_end: "2026-05-14T06:00:00Z",
        session_number: 3, booking_group_id: groupId, status: "cancelled",
      },
    ],
    profiles: [],
  });
  let captured;
  const { notifyBookingStatusChange } = await import(
    "../src/lib/services/booking-status-notify.service.ts"
  );
  await notifyBookingStatusChange(
    sb, "b-1", "cancelled",
    async (opts) => { captured = opts; return { success: true }; },
    async () => ({ success: true }),
  );
  check("email html mentions sibling 2회차",
        (captured?.html ?? "").includes("(2회차)"),
        captured ? "rendered" : "not captured");
  check("email html does NOT mention sibling 3회차 (cancelled)",
        !(captured?.html ?? "").includes("(3회차)"));
});

console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`✅ passed: ${passed}   ❌ failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);

// ── stub builder ───────────────────────────────────────────────────────
// Mirrors the shape used in test-payment-info-notify but tightened for
// the queries this notify service makes.
function makeSupabaseStub(state) {
  function fromImpl(table) {
    let _filter = {};
    let _excl = {};
    const builder = {
      select() { return builder; },
      eq(c, v) { _filter[c] = v; return builder; },
      neq(c, v) { _excl[c] = v; return builder; },
      maybeSingle() {
        const row = (state[table] ?? []).find((r) => matches(r, _filter, _excl)) ?? null;
        return Promise.resolve({ data: row, error: null });
      },
      then(resolve) {
        const rows = (state[table] ?? []).filter((r) => matches(r, _filter, _excl));
        resolve({ data: rows, error: null });
      },
    };
    return builder;
  }
  function matches(row, filter, excl) {
    for (const [k, v] of Object.entries(filter)) {
      if (row[k] !== v) return false;
    }
    for (const [k, v] of Object.entries(excl ?? {})) {
      if (row[k] === v) return false;
    }
    return true;
  }
  return { from: fromImpl };
}
