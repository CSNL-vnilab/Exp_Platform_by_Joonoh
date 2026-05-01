#!/usr/bin/env node
/**
 * QC for booking-reschedule-email (P0 #3 + P0 #4 SMS).
 *
 * Verifies the redesigned reschedule email matches the structural
 * skeleton of the other participant emails (header box, location
 * block, sibling block, researcher block, footer watermark) and the
 * SMS now includes a before→after diff instead of just the new slot.
 *
 * Rendering safety:
 *   - subject capped to avoid mobile-Gmail truncation
 *   - all user-controlled strings escapeHtml-encoded
 *   - timestamps wrapped with white-space:nowrap
 *   - long Korean phrases use word-break:keep-all
 *   - no placeholder leaks (P0 #1 helpers integrated)
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
  experiment: {
    title: "[테스트] 시각 실험",
    experiment_mode: "offline",
  },
  booking: {
    id: "b-1",
    session_number: 1,
    slot_start: "2026-05-12T05:00:00Z", // 14:00 KST
    slot_end: "2026-05-12T06:00:00Z",
  },
  oldSlotStart: "2026-05-10T05:00:00Z",
  oldSlotEnd: "2026-05-10T06:00:00Z",
  location: {
    name: "신양인문학관 5층 501호",
    address_lines: ["서울특별시 관악구 관악로 1", "서울대학교 신양인문학관"],
    naver_url: "https://map.naver.com/p/example",
  },
  researcher: {
    display_name: "이연구원",
    contact_email: "researcher@test.local",
    email: "ilab@x.local",
    phone: "010-1111-2222",
  },
  otherActiveSessions: [],
};

// ── 1. happy path ──────────────────────────────────────────────────────
await group("happy path — single session, offline", async () => {
  const m = await import("../src/lib/services/booking-reschedule-email.ts");
  const built = m.buildRescheduleEmail(baseInput);
  check("recipient is participant", built.to === "honggildong@test.local");
  check("subject starts with [BRAND] and contains 변경",
        /^\[.+\] .+ 일정이 변경되었습니다$/.test(built.subject),
        built.subject);
  check("subject excludes (1회차) for single session",
        !built.subject.includes("(1회차)"));
  check("body has header box + emoji", built.html.includes("📅") && built.html.includes("실험 일정이 변경되었습니다"));
  check("body greets participant by name", built.html.includes("홍길동님"));
  check("body apologizes", built.html.includes("양해 부탁드립니다"));
  check("body shows old slot with line-through", built.html.includes("text-decoration:line-through"));
  check("body shows new slot in highlighted row", built.html.includes("background:#fffbeb"));
  check("body has location block", built.html.includes("찾아오시는 길"));
  check("body shows location name", built.html.includes("신양인문학관 5층 501호"));
  check("body has naver link", built.html.includes("네이버 지도에서 열기"));
  check("body has researcher block", built.html.includes("담당 연구원 · 문의"));
  check("body shows researcher name + phone + email",
        built.html.includes("이연구원") && built.html.includes("010-1111-2222") && built.html.includes("researcher@test.local"));
  check("body has footer watermark", built.html.includes("자동 발송"));
  check("body uses keep-all to prevent Korean line-break breakage",
        built.html.includes("word-break:keep-all"));
  check("body wraps timestamps with nowrap",
        built.html.includes("white-space:nowrap"));
  check("no placeholder leak", !built.html.includes("contact@example.com"));
});

// ── 2. multi-session ──────────────────────────────────────────────────
await group("multi-session — sibling block + (회차) suffix", async () => {
  const m = await import("../src/lib/services/booking-reschedule-email.ts");
  const built = m.buildRescheduleEmail({
    ...baseInput,
    booking: { ...baseInput.booking, session_number: 2 },
    otherActiveSessions: [
      { slot_start: "2026-05-14T05:00:00Z", session_number: 3 },
      { slot_start: "2026-05-16T05:00:00Z", session_number: 4 },
    ],
  });
  check("subject contains (2회차)", built.subject.includes("(2회차)"));
  check("body has 회차 row in table", built.html.includes(">회차</td>"));
  check("body has sibling block intro", built.html.includes("이번 회차에만 적용됩니다"));
  check("body lists sibling 3회차", built.html.includes("(3회차)"));
  check("body lists sibling 4회차", built.html.includes("(4회차)"));
});

// ── 3. online — location hidden ───────────────────────────────────────
await group("online experiment hides location block", async () => {
  const m = await import("../src/lib/services/booking-reschedule-email.ts");
  const built = m.buildRescheduleEmail({
    ...baseInput,
    experiment: { ...baseInput.experiment, experiment_mode: "online" },
  });
  check("body omits 찾아오시는 길", !built.html.includes("찾아오시는 길"));
});

// ── 4. graceful degradation ───────────────────────────────────────────
await group("no researcher + no env-configured lab inbox → no leak", async () => {
  const m = await import("../src/lib/services/booking-reschedule-email.ts");
  const built = m.buildRescheduleEmail({
    ...baseInput,
    researcher: { display_name: null, contact_email: null, email: null, phone: null },
  });
  check("no placeholder leak", !built.html.includes("contact@example.com"));
  check("no empty mailto", !built.html.includes("mailto:\""));
  check("researcher header still present (graceful)",
        built.html.includes("담당 연구원 · 문의"));
  check("falls back to '담당 연구원' display name",
        built.html.includes("담당 연구원"));
});

await group("no location → block omitted", async () => {
  const m = await import("../src/lib/services/booking-reschedule-email.ts");
  const built = m.buildRescheduleEmail({
    ...baseInput,
    location: null,
  });
  check("location block hidden when null", !built.html.includes("찾아오시는 길"));
});

// ── 5. subject truncation safety ───────────────────────────────────────
await group("subject capped for long titles", async () => {
  const m = await import("../src/lib/services/booking-reschedule-email.ts");
  const longTitle = "굉장히 긴 실험 제목 ".repeat(10);
  const built = m.buildRescheduleEmail({
    ...baseInput,
    experiment: { ...baseInput.experiment, title: longTitle },
  });
  // [BRAND] (cap of 30 chars) (1회차) 일정이 변경되었습니다 — well under 100
  check("subject under 90 chars", built.subject.length < 90,
        `len=${built.subject.length}: ${built.subject}`);
  check("subject ends with the constant suffix",
        built.subject.endsWith("일정이 변경되었습니다"));
});

// ── 6. HTML injection safety ──────────────────────────────────────────
await group("HTML injection is escaped", async () => {
  const m = await import("../src/lib/services/booking-reschedule-email.ts");
  const built = m.buildRescheduleEmail({
    ...baseInput,
    participant: { name: '<script>alert(1)</script>홍', email: "a@b" },
    experiment: { ...baseInput.experiment, title: '<img src=x onerror=alert(1)>' },
  });
  // After escapeHtml, the *text* "onerror=" survives as plain text inside
  // an escaped &lt;img&gt; node — the browser renders it as harmless
  // text, not as an attribute. The real safety check is that no raw
  // tag opener (`<script` / `<img`) appears unescaped.
  check("no raw <script tag opener", !built.html.includes("<script"));
  check("no raw <img tag opener (from injected title)",
        !/<img[\s>]/.test(built.html));
  check("escaped lt entity present (script)", built.html.includes("&lt;script&gt;"));
  check("escaped lt entity present (img)", built.html.includes("&lt;img"));
});

// ── 7. SMS body (P0 #4) ───────────────────────────────────────────────
await group("SMS includes before→after diff (P0 #4)", async () => {
  const m = await import("../src/lib/services/booking-reschedule-email.ts");
  const sms = m.buildRescheduleSMS(baseInput);
  check("starts with [BRAND] 일정 변경", /^\[.+\] 일정 변경/.test(sms));
  check("contains arrow before→after", sms.includes("→"));
  check("includes participant name", sms.includes("홍길동"));
  check("contains researcher inquiry", sms.includes("researcher@test.local"));
  check("reasonable length (<160 chars)", sms.length < 160, `len=${sms.length}`);
});

await group("SMS for multi-session shows 회차 number", async () => {
  const m = await import("../src/lib/services/booking-reschedule-email.ts");
  const sms = m.buildRescheduleSMS({
    ...baseInput,
    booking: { ...baseInput.booking, session_number: 2 },
  });
  check("contains '2회차'", sms.includes("2회차"), sms);
});

console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`✅ passed: ${passed}   ❌ failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
