#!/usr/bin/env node
/**
 * 백필: payment_info row 가 없는 booking_group 에 대해 row 를 INSERT.
 *
 * 발생 배경: 일부 실험은 import/백필 스크립트로 booking 만 만들고
 * runPostBookingPipeline 을 우회한다 (e.g. TimeExp1 의 Sbj 5~12 는
 * "Sbj 5~12 백필 완료" description 대로 import). 그 결과
 * participant_payment_info row 가 없어서 청구 패널이 비어 있고
 * "정산안내 발송" / "참여자비 청구" 버튼이 영원히 비활성.
 *
 * 동작:
 *   1. 인자로 받은 experiment_id 의 모든 booking_group_id 수집
 *      (cancelled-only 그룹은 제외).
 *   2. 각 그룹에서 participant_payment_info row 가 없으면
 *      seedPaymentInfo 와 동일 로직으로 INSERT.
 *   3. row 가 이미 있으면 skip (idempotent — UNIQUE on booking_group_id
 *      가 안전망).
 *   4. status='pending_participant' 로 시작 → 연구원이 booking 을
 *      manually completed 로 마킹한 뒤 패널의 "안내 메일 발송" 버튼을
 *      누르면 알림이 나간다.
 *
 * 환경변수: PAYMENT_INFO_KEY, PAYMENT_TOKEN_SECRET (이 둘은 토큰 발급/
 * 암호화에 필수).
 *
 * Usage: node scripts/backfill-payment-info.mjs <experimentId>
 *        node scripts/backfill-payment-info.mjs <experimentId> --dry-run
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

// Load .env.local first, then fill missing prod-only keys from
// .env.vercel.prod (PAYMENT_INFO_KEY / PAYMENT_TOKEN_SECRET typically
// live there, not in the local dev env).
for (const fname of [".env.local", ".env.vercel.prod"]) {
  try {
    const envText = await readFile(join(repoRoot, fname), "utf8");
    for (const line of envText.split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
    }
  } catch {
    // missing file is fine; .env.vercel.prod may not exist locally
  }
}

const args = process.argv.slice(2);
const expId = args.find((a) => !a.startsWith("--"));
const dryRun = args.includes("--dry-run");
if (!expId) {
  console.error("Usage: node scripts/backfill-payment-info.mjs <experimentId> [--dry-run]");
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const headers = {
  apikey: key,
  Authorization: `Bearer ${key}`,
  "content-type": "application/json",
  Prefer: "return=representation",
};

// Load token + crypto helpers via the repo's TS modules.
const tokenMod = await import(join(repoRoot, "src/lib/payments/token.ts"));
const cryptoMod = await import(join(repoRoot, "src/lib/crypto/payment-info.ts"));

// ── 1. fetch experiment ────────────────────────────────────────────────
const expRes = await fetch(
  `${url}/rest/v1/experiments?select=id,title,participation_fee&id=eq.${expId}`,
  { headers },
);
const [exp] = await expRes.json();
if (!exp) {
  console.error(`Experiment ${expId} not found`);
  process.exit(1);
}
console.log(`Experiment: ${exp.title}  fee=${exp.participation_fee}`);
if ((exp.participation_fee ?? 0) <= 0) {
  console.error("participation_fee <= 0 — no payment_info needed for this experiment");
  process.exit(0);
}

// ── 2. fetch all bookings for this experiment ─────────────────────────
const bookRes = await fetch(
  `${url}/rest/v1/bookings?select=id,participant_id,booking_group_id,slot_start,slot_end,status,subject_number,session_number&experiment_id=eq.${expId}&order=subject_number,session_number`,
  { headers },
);
const allBookings = await bookRes.json();
console.log(`Bookings: ${allBookings.length}`);

// Group by booking_group_id, drop cancelled-only groups + null group_ids.
const groups = new Map();
for (const b of allBookings) {
  if (!b.booking_group_id) continue;
  const arr = groups.get(b.booking_group_id) ?? [];
  arr.push(b);
  groups.set(b.booking_group_id, arr);
}
const candidateGroups = [...groups.entries()].filter(([, rows]) =>
  rows.some((r) => r.status !== "cancelled"),
);
console.log(`Booking groups (non-cancelled): ${candidateGroups.length}`);

// ── 3. fetch existing payment_info rows so we skip them ───────────────
const piRes = await fetch(
  `${url}/rest/v1/participant_payment_info?select=booking_group_id&experiment_id=eq.${expId}`,
  { headers },
);
const existing = new Set((await piRes.json()).map((r) => r.booking_group_id));
console.log(`Existing payment_info rows: ${existing.size}`);

// ── 4. backfill loop ──────────────────────────────────────────────────
const toHex = (b) => `\\x${b.toString("hex")}`;
const kstDate = (d) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);

let inserted = 0;
let skipped = 0;
for (const [groupId, rows] of candidateGroups) {
  if (existing.has(groupId)) {
    skipped++;
    continue;
  }
  const sbj = rows[0].subject_number;
  const participantId = rows[0].participant_id;
  // Period from MIN/MAX of all live slots (mirror seedPaymentInfo).
  // We include 'cancelled' rows here only if all are cancelled (filtered
  // out earlier), otherwise we use only non-cancelled rows so a
  // half-cancelled group doesn't get a stretched period.
  const liveRows = rows.filter((r) => r.status !== "cancelled");
  const starts = liveRows.map((r) => new Date(r.slot_start).getTime());
  const ends = liveRows.map((r) => new Date(r.slot_end).getTime());
  const periodStart = new Date(Math.min(...starts));
  const periodEnd = new Date(Math.max(...ends));
  const sessionCount = liveRows.length;
  const amountKrw = exp.participation_fee * sessionCount;

  const issued = tokenMod.issuePaymentToken(groupId);
  const enc = cryptoMod.encryptToken(issued.token);

  const payload = {
    participant_id: participantId,
    experiment_id: expId,
    booking_group_id: groupId,
    token_hash: issued.hash,
    token_cipher: toHex(enc.cipher),
    token_iv: toHex(enc.iv),
    token_tag: toHex(enc.tag),
    token_key_version: enc.keyVersion,
    token_issued_at: new Date(issued.issuedAt).toISOString(),
    token_expires_at: new Date(issued.expiresAt).toISOString(),
    period_start: kstDate(periodStart),
    period_end: kstDate(periodEnd),
    amount_krw: amountKrw,
    status: "pending_participant",
  };

  console.log(
    `  Sbj${sbj} group=${groupId.slice(0, 8)} sessions=${sessionCount} amount=${amountKrw} period=${payload.period_start}~${payload.period_end}`,
  );

  if (dryRun) {
    inserted++;
    continue;
  }

  const r = await fetch(`${url}/rest/v1/participant_payment_info`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const body = await r.text();
    console.error(`    ❌ INSERT failed: HTTP ${r.status} ${body}`);
    continue;
  }
  inserted++;
}

console.log(`\n${dryRun ? "DRY RUN — would insert" : "Inserted"}: ${inserted}`);
console.log(`Skipped (already had row): ${skipped}`);
