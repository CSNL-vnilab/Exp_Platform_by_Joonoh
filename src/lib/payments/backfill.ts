// Backfill payment_info rows for booking_groups that ended up without
// one — typically because the bookings were imported via a one-off
// script that bypassed runPostBookingPipeline (which is where
// seedPaymentInfo runs). Symptom: payment panel shows 0 rows even
// though all sessions are completed → "참여자비 청구" / "안내 메일
// 발송" buttons stay disabled forever.
//
// Idempotent: skips groups that already have a payment_info row
// (UNIQUE on booking_group_id is the safety net). Cancelled-only
// groups skipped — those wouldn't pay anything anyway.

import { createAdminClient } from "@/lib/supabase/admin";
import { issuePaymentToken } from "@/lib/payments/token";
import { encryptToken } from "@/lib/crypto/payment-info";
import { SWEEP_MAX_ATTEMPTS } from "@/lib/services/payment-info-notify.service";
import { isLive } from "@/lib/bookings/status";

type Supabase = ReturnType<typeof createAdminClient>;

export interface BackfillResult {
  experimentId: string;
  fee: number;
  groupsExamined: number;
  alreadyHadRow: number;
  inserted: number;
  insertFailures: number;
  skippedNoFee: boolean;
}

const kstDate = (d: Date): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);

const toHex = (b: Buffer) => `\\x${b.toString("hex")}`;

export async function backfillPaymentInfoForExperiment(
  supabase: Supabase,
  experimentId: string,
): Promise<BackfillResult> {
  const result: BackfillResult = {
    experimentId,
    fee: 0,
    groupsExamined: 0,
    alreadyHadRow: 0,
    inserted: 0,
    insertFailures: 0,
    skippedNoFee: false,
  };

  // 1. Load the experiment fee. Zero-fee experiments don't need any
  // payment_info rows; we mirror seedPaymentInfo's early return.
  const { data: exp } = await supabase
    .from("experiments")
    .select("id, participation_fee")
    .eq("id", experimentId)
    .maybeSingle();
  const fee = (exp as { participation_fee?: number } | null)?.participation_fee ?? 0;
  result.fee = fee;
  if (!exp || fee <= 0) {
    result.skippedNoFee = true;
    return result;
  }

  // 2. Group bookings by booking_group_id and drop cancelled-only
  // groups. Null booking_group_id rows are legacy single-session
  // bookings without group semantics — also skipped.
  const { data: bookings } = await supabase
    .from("bookings")
    .select(
      "id, participant_id, booking_group_id, slot_start, slot_end, status",
    )
    .eq("experiment_id", experimentId);
  const groups = new Map<
    string,
    Array<{
      participant_id: string;
      slot_start: string;
      slot_end: string;
      status: string;
    }>
  >();
  for (const b of bookings ?? []) {
    const row = b as {
      participant_id: string;
      booking_group_id: string | null;
      slot_start: string;
      slot_end: string;
      status: string;
    };
    if (!row.booking_group_id) continue;
    const arr = groups.get(row.booking_group_id) ?? [];
    arr.push(row);
    groups.set(row.booking_group_id, arr);
  }
  const candidateGroups = [...groups.entries()].filter(([, rows]) =>
    rows.some((r) => r.status !== "cancelled"),
  );
  result.groupsExamined = candidateGroups.length;

  if (candidateGroups.length === 0) return result;

  // 3. Find which already have a payment_info row.
  const groupIds = candidateGroups.map(([gid]) => gid);
  const { data: existingRows } = await supabase
    .from("participant_payment_info")
    .select("booking_group_id")
    .eq("experiment_id", experimentId)
    .in("booking_group_id", groupIds);
  const existing = new Set(
    (existingRows ?? []).map(
      (r) => (r as { booking_group_id: string }).booking_group_id,
    ),
  );
  result.alreadyHadRow = existing.size;

  // 4. Insert missing rows.
  for (const [groupId, rows] of candidateGroups) {
    if (existing.has(groupId)) continue;

    // Period from attended sessions only — a half-cancelled group
    // shouldn't get a stretched period from terminal-non-payable tails.
    // 살아있는 세션 규약 (propagate_payment_period, 00055): cancelled +
    // no_show 둘 다 terminal-non-payable. no_show 를 빠뜨리면 불참 회차의
    // slot 이 period_start/end 와 sessionCount 를 부풀려 정산서류에 들어간다
    // (backlog [17]; claim-bundle.loadSessionsByBgId 의 status 필터와 정합).
    // isLive = LIVE_STATUSES 멤버십 (bookings/status SSOT).
    const liveRows = rows.filter((r) => isLive(r.status));
    if (liveRows.length === 0) continue;
    const starts = liveRows.map((r) => new Date(r.slot_start).getTime());
    const ends = liveRows.map((r) => new Date(r.slot_end).getTime());
    const periodStart = new Date(Math.min(...starts));
    const periodEnd = new Date(Math.max(...ends));
    const sessionCount = liveRows.length;
    // experiments.participation_fee is the TOTAL participation fee for
    // the entire experiment regardless of session count (multi-session
    // experiments pay one fee per completed booking_group, not per
    // session). Earlier this multiplied fee × sessionCount which gave
    // 450,000원 for a 5-session 90,000원 experiment.
    const amountKrw = fee;

    const issued = issuePaymentToken(groupId);
    const enc = encryptToken(issued.token);

    const { error } = await supabase.from("participant_payment_info").insert({
      participant_id: liveRows[0].participant_id,
      experiment_id: experimentId,
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
      // Auto-dispatch suppression (2026-06-10 blind review [6]):
      // backfilled rows describe HISTORICAL groups — without this the
      // nightly sweep sees pending+unsent+amount>0 and mass-emails
      // payment-info requests to participants whose experiments ended
      // months ago (likely already paid offline). Seeding attempts at
      // the sweep ceiling keeps the row out of the cron candidate set;
      // the researcher's explicit 발송 button (force=true) remains the
      // only dispatch door for backfilled rows.
      payment_link_attempts: SWEEP_MAX_ATTEMPTS,
      payment_link_last_error:
        "백필 행 — 자동발송 억제. 필요 시 결제 패널에서 수동 발송하세요.",
    });
    if (error) {
      result.insertFailures++;
      console.error(
        `[BackfillPaymentInfo] insert failed for group ${groupId}: ${error.message}`,
      );
      continue;
    }
    result.inserted++;
  }

  return result;
}
