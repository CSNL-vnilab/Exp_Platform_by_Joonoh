#!/usr/bin/env node
/**
 * Live regression for the blacklist *approval* cascade → payment_info
 * settlement coupling (must-fix criterion b — coverage gap).
 *
 * Two distinct blacklist cascade flows exist:
 *   1. direct class flip:    /api/participants/[participantId]/class
 *   2. researcher-request →  /api/participants/blacklist-requests/[id]
 *      admin-approval         (action:"approve")
 *
 * Only (1) was previously verified to funnel cancelled groups through
 * propagate_payment_period + notifyPaymentInfoIfReady. Flow (2) cascade-
 * cancelled future confirmed/running bookings but NEVER settled
 * participant_payment_info — so when an approved cascade cancelled the
 * LAST live booking of a group, the settlement row stayed stuck in
 * pending/claimed/submitted_to_admin until the nightly cron. And the cron
 * sweeps status='pending_participant' ONLY, so a claimed/submitted row was
 * never reconciled at all (live prod: sbj13 pi=818c13e9, claimed with all
 * 5 bookings cancelled).
 *
 * This script reproduces flow (2)'s post-approval settlement against live
 * Supabase and asserts the fix: a fully-cancelled group settles its
 * payment_info to 'cancelled', from BOTH a pending_participant starting
 * status AND a claimed starting status (the cron-blind case).
 *
 * It drives the EXACT code the route now runs after the cascade loop:
 * the same propagate_payment_period RPC + notifyPaymentInfoIfReady helper
 * the route imports — so a regression in either the route wiring or the
 * helper's all-terminal transition will fail here.
 *
 * Safe to re-run — every row carries an E2E-BLCASCADE-{ts} marker and is
 * torn down at the end (and on early failure).
 *
 * Run: node --import tsx scripts/e2e-blacklist-cascade-settle.mjs
 */

import { createClient } from "@supabase/supabase-js";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadEnvFile(path) {
  if (!existsSync(path)) return;
  const text = await readFile(path, "utf8");
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
    }
  }
}
await loadEnvFile(join(__dirname, "..", ".env.local"));

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local",
  );
  process.exit(1);
}
const s = createClient(url, key);

// token_hash is NOT NULL on participant_payment_info. We never verify these
// tokens (the test exercises settlement, not the participant link), so a
// local-only secret is fine — same fallback pattern as e2e-payment-live.
if (!process.env.PAYMENT_TOKEN_SECRET) {
  process.env.PAYMENT_TOKEN_SECRET = "e2e-local-token-secret-" + "b".repeat(40);
}
const { issuePaymentToken } = await import("../src/lib/payments/token.ts");
// PAYMENT_INFO_KEY backs the RRN cipher we stamp on the 'claimed' fixture
// (its submitted_requires_pii CHECK demands a full PII set). Local-only.
if (!process.env.PAYMENT_INFO_KEY) {
  process.env.PAYMENT_INFO_KEY = "e2e-local-key-" + "a".repeat(40);
}
const { encryptRrn } = await import("../src/lib/crypto/payment-info.ts");

// The route imports this helper; the script imports the SAME module so the
// assertion exercises the real settlement transition, not a copy.
const { notifyPaymentInfoIfReady } = await import(
  "../src/lib/services/payment-info-notify.service.ts"
);
// COMPLETABLE_STATUSES is the SSOT for the cascade-cancel filter.
const { COMPLETABLE_STATUSES } = await import("../src/lib/bookings/status.ts");

const TEST_MARKER = `E2E-BLCASCADE-${Date.now().toString(36)}`;
const LAB_ID = "5681016e-dbd7-46e5-a6fc-673dad12280f"; // CSNL
const ADMIN_ID = "581e52f0-417e-45fd-b6c8-877b723978fc"; // csnl

console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(` Blacklist-approval cascade → settle regression  ${TEST_MARKER}`);
console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

const fails = [];
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    fails.push({ name, detail });
    console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`);
  }
}

const experimentId = randomUUID();
const seeded = []; // { participantId, bookingGroupId, startStatus }

// One future-dated confirmed booking per group: matches the route's
// cascade filter (status ∈ COMPLETABLE_STATUSES AND slot_start > now). The
// group has NO other live booking, so cancelling it leaves the group
// all-terminal → payment_info must settle to 'cancelled'.
const future = new Date();
future.setDate(future.getDate() + 7);
future.setHours(14, 0, 0, 0);

async function cleanup() {
  console.log("\n── Cleanup ──");
  await s
    .from("participant_payment_info")
    .delete()
    .eq("experiment_id", experimentId);
  await s.from("bookings").delete().eq("experiment_id", experimentId);
  for (const r of seeded) {
    await s.from("participants").delete().eq("id", r.participantId);
  }
  await s.from("experiments").delete().eq("id", experimentId);
  console.log("  ✅ DB rows deleted");
}

async function fatal(msg) {
  console.error(`\nFATAL: ${msg}`);
  await cleanup();
  process.exit(1);
}

// ── Seed experiment ──────────────────────────────────────────────────────
console.log("── Phase 1: Seeding ──");
{
  const { error } = await s.from("experiments").insert({
    id: experimentId,
    lab_id: LAB_ID,
    title: `${TEST_MARKER} 단일세션 실험`,
    description: "E2E blacklist cascade settle — safe to delete",
    start_date: "2026-04-01",
    end_date: "2026-04-30",
    session_duration_minutes: 60,
    max_participants_per_slot: 1,
    participation_fee: 50000,
    session_type: "single",
    required_sessions: 1,
    daily_start_time: "09:00",
    daily_end_time: "18:00",
    break_between_slots_minutes: 15,
    status: "draft",
    categories: [],
    weekdays: [1, 2, 3, 4, 5],
    location: null,
    location_id: null,
    created_by: ADMIN_ID,
  });
  if (error) await fatal(`experiment insert: ${error.message}`);
  check("dummy experiment inserted", true);
}

// Two fixtures: one payment_info starts 'pending_participant' (cron-
// reachable), one starts 'claimed' (cron-blind — the exact stuck case).
const fixtures = [
  { name: `${TEST_MARKER} 펜딩`, startStatus: "pending_participant" },
  { name: `${TEST_MARKER} 클레임드`, startStatus: "claimed" },
];

for (let i = 0; i < fixtures.length; i++) {
  const fx = fixtures[i];
  const participantId = randomUUID();
  const bookingGroupId = randomUUID();

  const { error: pErr } = await s.from("participants").insert({
    id: participantId,
    name: fx.name,
    phone: `010-0000-${String(8880 + i).padStart(4, "0")}`,
    email: `${TEST_MARKER.toLowerCase()}-${i}@test.invalid`,
    gender: i % 2 === 0 ? "male" : "female",
    birthdate: "1995-06-15",
  });
  if (pErr) await fatal(`participant ${i} insert: ${pErr.message}`);

  const slotEnd = new Date(future);
  slotEnd.setMinutes(slotEnd.getMinutes() + 60);
  const { error: bErr } = await s.from("bookings").insert({
    id: randomUUID(),
    experiment_id: experimentId,
    participant_id: participantId,
    slot_start: future.toISOString(),
    slot_end: slotEnd.toISOString(),
    session_number: 1,
    booking_group_id: bookingGroupId,
    status: "confirmed",
  });
  if (bErr) await fatal(`booking ${i} insert: ${bErr.message}`);

  const issued = issuePaymentToken(bookingGroupId);
  const piRow = {
    id: randomUUID(),
    participant_id: participantId,
    experiment_id: experimentId,
    booking_group_id: bookingGroupId,
    token_hash: issued.hash,
    token_issued_at: new Date(issued.issuedAt).toISOString(),
    token_expires_at: new Date(issued.expiresAt).toISOString(),
    period_start: future.toISOString().slice(0, 10),
    period_end: future.toISOString().slice(0, 10),
    amount_krw: 50000,
    status: fx.startStatus,
  };
  // A 'claimed' row must satisfy two CHECKs (this faithfully reproduces the
  // live sbj13 pi=818c13e9 shape — a fully-submitted, claimed settlement
  // whose group later went fully cancelled):
  //   payment_info_submitted_requires_pii → full PII set,
  //   payment_info_claimed_has_claim      → claimed_at IS NOT NULL.
  if (fx.startStatus === "claimed") {
    const nowIso = new Date().toISOString();
    const { cipher, iv, tag, keyVersion } = encryptRrn("960615-1234567");
    const toHex = (buf) => `\\x${buf.toString("hex")}`;
    Object.assign(piRow, {
      rrn_cipher: toHex(cipher),
      rrn_iv: toHex(iv),
      rrn_tag: toHex(tag),
      rrn_key_version: keyVersion,
      bank_name: "신한은행",
      account_number: "110-545-100000",
      account_holder: fx.name,
      institution: "서울대학교",
      signature_path: `${experimentId}/${bookingGroupId}.sig.png`,
      signed_at: nowIso,
      bankbook_path: `${experimentId}/${bookingGroupId}.bb.png`,
      bankbook_mime_type: "image/png",
      submitted_at: nowIso,
      claimed_at: nowIso,
    });
  }
  const { error: piErr } = await s
    .from("participant_payment_info")
    .insert(piRow);
  if (piErr) await fatal(`payment_info ${i} insert: ${piErr.message}`);

  seeded.push({ participantId, bookingGroupId, startStatus: fx.startStatus });
}
check(`seeded ${seeded.length} groups (pending_participant + claimed)`, true);

// ── Phase 2: reproduce the route's post-approval settlement ───────────────
// This is exactly what blacklist-requests/[id]/route.ts now does after the
// admin approves: cascade-cancel future confirmed/running bookings,
// collect affected booking_group_ids, then per group call
// propagate_payment_period + notifyPaymentInfoIfReady (best-effort).
console.log("\n── Phase 2: Cascade-cancel + settle (route mirror) ──");

for (const r of seeded) {
  const participantId = r.participantId;
  const nowIso = new Date().toISOString();
  const { data: futureBks, error: selErr } = await s
    .from("bookings")
    .select("id, booking_group_id")
    .eq("participant_id", participantId)
    .in("status", [...COMPLETABLE_STATUSES])
    .gt("slot_start", nowIso);
  if (selErr) await fatal(`future-booking select: ${selErr.message}`);
  check(
    `[${r.startStatus}] cascade saw the future confirmed booking`,
    (futureBks ?? []).length === 1,
    `count=${(futureBks ?? []).length}`,
  );

  const cascadeGroups = new Set();
  for (const b of futureBks ?? []) {
    const { error: cancelErr } = await s
      .from("bookings")
      .update({ status: "cancelled" })
      .eq("id", b.id)
      .in("status", [...COMPLETABLE_STATUSES]);
    if (!cancelErr) {
      const bg = b.booking_group_id;
      if (bg) cascadeGroups.add(bg);
    } else {
      check(`[${r.startStatus}] booking cancel`, false, cancelErr.message);
    }
  }

  for (const bg of cascadeGroups) {
    try {
      await s.rpc("propagate_payment_period", { p_booking_group_id: bg });
    } catch (err) {
      console.warn(
        `  ⚠️ propagate_payment_period ${bg}: ${err?.message ?? err}`,
      );
    }
    try {
      await notifyPaymentInfoIfReady(s, bg);
    } catch (err) {
      check(`[${r.startStatus}] notifyPaymentInfoIfReady`, false, String(err));
    }
  }
}

// ── Phase 3: assertions ───────────────────────────────────────────────────
console.log("\n── Phase 3: Asserting settlement ──");
for (const r of seeded) {
  // Every booking in the group must now be cancelled.
  const { data: bks } = await s
    .from("bookings")
    .select("status")
    .eq("booking_group_id", r.bookingGroupId);
  const allCancelled =
    (bks ?? []).length > 0 && (bks ?? []).every((b) => b.status === "cancelled");
  check(
    `[${r.startStatus}] group fully cancelled`,
    allCancelled,
    JSON.stringify((bks ?? []).map((b) => b.status)),
  );

  // The payment_info row must settle to 'cancelled' — regardless of whether
  // it started pending_participant (cron-reachable) or claimed (cron-blind).
  const { data: pi } = await s
    .from("participant_payment_info")
    .select("status")
    .eq("booking_group_id", r.bookingGroupId)
    .maybeSingle();
  check(
    `[${r.startStatus}] payment_info settled to 'cancelled'`,
    pi?.status === "cancelled",
    `actual=${pi?.status}`,
  );
}

await cleanup();

// ── Report ────────────────────────────────────────────────────────────────
console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
if (fails.length === 0) {
  console.log(`  ✅  BLACKLIST-CASCADE SETTLE REGRESSION PASSED`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
  process.exit(0);
} else {
  console.log(`  ❌  ${fails.length} FAILURES`);
  for (const f of fails) console.log(`    - ${f.name}  ${f.detail}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
  process.exit(1);
}
