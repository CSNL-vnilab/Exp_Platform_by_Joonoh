// 실험 종료 시 참여자에게 정산 정보 입력 링크 메일을 자동 발송한다.
//
// 호출 진입점 (모두 동일한 함수 — notifyPaymentInfoIfReady — 를 사용):
//
//   1. PUT /api/bookings/[id] — 연구원이 booking 상태를 'completed' 로
//      직접 변경할 때.
//   2. submit_booking_observation RPC 의 auto-complete 분기 (사후설문
//      체크 시 자동 완료) — observation 라우트 핸들러에서 호출.
//   3. /run verify 엔드포인트의 auto-complete 분기.
//   4. cron auto-complete-bookings — RPC 가 한 번에 N 행을 completed 로
//      flip 한 후 sweep.
//
// 멱등성: payment_link_sent_at 이 NULL 인 행만 발송한다. 같은 booking_group
// 의 booking 이 차례로 'completed' 로 전이되어도 마지막 한 번만 메일이
// 나간다.
//
// 발송 자격:
//   - participant_payment_info 행이 존재해야 한다 (즉 fee > 0 인 실험).
//   - 같은 booking_group 의 모든 booking 의 status 가 'completed' 여야
//     한다 ('cancelled' / 'no_show' 는 제외).
//   - 토큰이 만료되지 않았어야 한다. 만료된 경우 새 토큰을 발급해
//     hash 를 갱신하고 메일을 보낸다.
//
// 실패 처리: SMTP 실패는 catch 하여 last_error / attempts 만 기록하고
// 호출자에게 throw 하지 않는다. 호출 사이트는 booking 상태 전이를
// 메일 실패로 롤백할 의사가 없으므로.

import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail as defaultSendEmail } from "@/lib/google/gmail";
import { issuePaymentToken } from "@/lib/payments/token";
import { buildPaymentInfoEmail } from "@/lib/services/payment-info-email-template";
import { bytesFromSupabase, decryptToken, encryptToken } from "@/lib/crypto/payment-info";
import { getAppOrigin } from "@/lib/http/origin";

type Supabase = ReturnType<typeof createAdminClient>;

// Injectable mailer so unit tests can stub SMTP without monkey-patching
// ESM module exports (which fails on Node 20+ because exports are
// read-only getters). Default = the real Gmail sender.
type Mailer = (opts: {
  to: string;
  subject: string;
  html: string;
  replyTo?: string;
}) => Promise<{ success: boolean; messageId?: string; error?: string }>;

interface PaymentInfoRow {
  id: string;
  booking_group_id: string;
  experiment_id: string;
  participant_id: string;
  amount_krw: number;
  status: string;
  token_hash: string;
  token_issued_at: string;
  token_expires_at: string;
  payment_link_sent_at: string | null;
  payment_link_attempts: number;
  payment_link_first_opened_at: string | null;
  // Lease for the dispatch lock-acquire pattern (P0-Α, migration 00053).
  // Non-null + future timestamp = another trigger is mid-send.
  payment_link_dispatch_lock_until: string | null;
  // Encrypted plaintext blob (P0 #6, migration 00052). Present on rows
  // seeded after the migration. Lets us re-send the SAME URL when the
  // participant already opened the link instead of rotating the hash.
  token_cipher: unknown;
  token_iv: unknown;
  token_tag: unknown;
  token_key_version: number | null;
  period_start: string | null;
  period_end: string | null;
  name_override: string | null;
  email_override: string | null;
}

// Dispatch lock TTL — long enough that a slow SMTP send (5MB attachment,
// regional SMTP latency) doesn't expire mid-flight, short enough that a
// crashed worker doesn't block redelivery for an annoying duration.
const DISPATCH_LOCK_TTL_MS = 5 * 60 * 1000;

export interface NotifyResult {
  /** Why the call did/didn't end up sending. Useful for cron logs. */
  outcome:
    | "sent"
    | "already_sent"
    | "no_payment_row"
    | "amount_zero"
    | "not_all_completed"
    | "no_recipient"
    | "send_failed"
    // experiments.payment_link_auto_send=false — researcher opted out
    // of auto-dispatch so the amount can be reviewed before going out.
    // The send only happens when they click "안내 메일 발송" in the
    // payment-panel (which calls this same function with force=true).
    | "auto_send_disabled"
    // Another trigger is currently mid-send; we backed off cleanly.
    // Caller (cron) sees this and knows the next tick will retry.
    | "lock_held"
    // Every booking in the group ended up cancelled. Helper transitions
    // payment_info.status to 'cancelled' so the row stops blocking the
    // pending-payment dashboard / cron sweep. 2026-05-29 (A2 fix for
    // hidden-couplings.md #25).
    | "all_cancelled";
  bookingGroupId: string;
  detail?: string;
}

export interface NotifyOptions {
  /**
   * Bypass the experiments.payment_link_auto_send=false opt-out AND
   * the payment_link_sent_at-already-stamped guard. Used by the
   * explicit "안내 메일 발송" / "수정 후 발송" admin buttons — at
   * that point the researcher has already reviewed the amount and is
   * asking for an immediate (re-)dispatch.
   *
   * Default false → respect the experiment-level toggle AND
   * idempotency (no re-send of an already-sent group).
   *
   * Implementation note (Codex C6 hot-fix 2026-05-28): force=true
   * also RESETS payment_link_sent_at to NULL atomically when we
   * acquire the dispatch lock, so two concurrent force callers race
   * for the same lock rather than each doing a separate null-reset +
   * lock cycle. Previously the route handlers reset sent_at *before*
   * calling notify, which let two near-simultaneous resend clicks
   * both stamp NULL and then both win different lock acquires,
   * resulting in a duplicate email to the participant.
   */
  force?: boolean;
}

export async function notifyPaymentInfoIfReady(
  supabase: Supabase,
  bookingGroupId: string,
  mailer: Mailer = defaultSendEmail,
  options: NotifyOptions = {},
): Promise<NotifyResult> {
  // 1) Load the payment_info row.
  const { data: rowRaw } = await supabase
    .from("participant_payment_info")
    .select(
      "id, booking_group_id, experiment_id, participant_id, amount_krw, status, token_hash, token_issued_at, token_expires_at, payment_link_sent_at, payment_link_attempts, payment_link_first_opened_at, payment_link_dispatch_lock_until, token_cipher, token_iv, token_tag, token_key_version, period_start, period_end, name_override, email_override",
    )
    .eq("booking_group_id", bookingGroupId)
    .maybeSingle();

  const row = rowRaw as unknown as PaymentInfoRow | null;
  if (!row) {
    return { outcome: "no_payment_row", bookingGroupId };
  }

  // Idempotency gate — force=true (explicit admin resend) bypasses so
  // the researcher can re-send after an amount edit. Without force we
  // refuse to re-send a row that's already been dispatched once.
  if (row.payment_link_sent_at && !options.force) {
    return { outcome: "already_sent", bookingGroupId };
  }
  if (row.amount_krw <= 0) {
    return { outcome: "amount_zero", bookingGroupId };
  }
  // If the row was already submitted (참여자가 이미 정산 정보를 제출한 경우)
  // — 이미 메일이 굳이 필요 없다. 멱등성 차원에서 sent_at 을 stamp 해둔다.
  if (row.status !== "pending_participant") {
    await supabase
      .from("participant_payment_info")
      .update({ payment_link_sent_at: new Date().toISOString() })
      .eq("id", row.id);
    return { outcome: "already_sent", bookingGroupId, detail: "row not pending" };
  }

  // 2) Group readiness gate.
  //
  // Pre-A2 (2026-05-29) this required every booking to be 'completed'.
  // That broke partial-cancel groups (hidden-couplings #25): if a
  // participant self-cancelled 1 of 5 sessions, the remaining 4
  // completing would still fail the gate forever — payment email never
  // dispatched and the row sat as pending in the admin queue.
  //
  // New semantics: cancelled bookings are terminal-non-blocking. The
  // gate passes when (a) at least one booking is non-cancelled AND
  // (b) every non-cancelled booking is 'completed'. If EVERY booking
  // is cancelled, transition payment_info to 'cancelled' and short-
  // circuit — the row is dead, not pending.
  //
  // The researcher's amount-override workflow (migration 00065) already
  // handles per-session billing adjustments when a session count
  // diverges from the planned count, so passing the gate with a partial
  // count is safe — the researcher reviews amount before clicking
  // "안내 메일 발송".
  const { data: bookings } = await supabase
    .from("bookings")
    .select("status")
    .eq("booking_group_id", bookingGroupId);
  const groupBookings = bookings ?? [];
  if (groupBookings.length === 0) {
    return { outcome: "not_all_completed", bookingGroupId, detail: "no bookings" };
  }
  const nonCancelled = groupBookings.filter((b) => b.status !== "cancelled");
  if (nonCancelled.length === 0) {
    // Every booking cancelled. Mark the payment row dead so it stops
    // appearing in pending dashboards / cron retries. Idempotent — if
    // a concurrent call already flipped status, the WHERE clause skips
    // the UPDATE.
    await supabase
      .from("participant_payment_info")
      // Cast: 'cancelled' was added to the payment_status enum in
      // migration 00066 (2026-05-29) but the generated database types
      // here still enumerate the pre-migration union. Once the schema
      // codegen rerun lands the cast can drop.
      .update({
        status: "cancelled",
        // Stamp sent_at so the row also exits the "send pending"
        // candidate set. last_error left blank — this isn't a failure.
        payment_link_sent_at: new Date().toISOString(),
      } as never)
      .eq("id", row.id)
      .eq("status", "pending_participant");
    return {
      outcome: "all_cancelled",
      bookingGroupId,
      detail: "all bookings in group are cancelled",
    };
  }
  const allCompleted = nonCancelled.every((b) => b.status === "completed");
  if (!allCompleted) {
    return { outcome: "not_all_completed", bookingGroupId };
  }

  // 3) Resolve recipient + experiment context. participants(name, email) is
  // joined here rather than at step 1 because we may also need the override
  // values from name_override/email_override and we want the join to fail
  // loudly if the row was orphaned.
  const [{ data: participant }, { data: experimentRaw }] = await Promise.all([
    supabase
      .from("participants")
      .select("name, email")
      .eq("id", row.participant_id)
      .maybeSingle(),
    supabase
      .from("experiments")
      .select("id, title, created_by, payment_link_auto_send")
      .eq("id", row.experiment_id)
      .maybeSingle(),
  ]);

  // 3a) Auto-send opt-out (migration 00063). When the experiment is
  // configured to require an explicit researcher trigger, every
  // automatic call (PUT booking → completed, observation auto-complete,
  // /run verify, cron sweep) bails out here. The send only proceeds
  // when the researcher clicks "안내 메일 발송" in payment-panel,
  // which calls this function with { force: true }.
  //
  // Rationale: multi-session experiments where the actual session count
  // diverges from the planned count (5 → 6 with extension, 5 → 2 with
  // early stop) need the researcher to confirm the amount before the
  // participant sees it. Without this guard the auto-send fires
  // milliseconds after the last booking flips to completed, before the
  // researcher has any chance to adjust amount_krw.
  const experimentForGate = experimentRaw as
    | { payment_link_auto_send?: boolean | null }
    | null;
  if (
    !options.force &&
    experimentForGate &&
    experimentForGate.payment_link_auto_send === false
  ) {
    return {
      outcome: "auto_send_disabled",
      bookingGroupId,
      detail:
        "experiment.payment_link_auto_send=false — researcher must trigger explicitly",
    };
  }

  // Computed from the pre-lock row; recomputed under-lock from freshRow
  // below (Codex 2nd-pass M, 2026-05-29). `let` so the refresh can
  // mutate them — previously these were const and the email body used
  // the stale pre-lock recipient even when freshRow.email_override was
  // updated.
  let recipientEmail =
    (row.email_override?.trim() || participant?.email || "").trim();
  let recipientName =
    (row.name_override?.trim() || participant?.name || "").trim();
  if (!recipientEmail) {
    await stampFailure(supabase, row.id, "no recipient email");
    return { outcome: "no_recipient", bookingGroupId };
  }
  const experiment = experimentRaw as unknown as
    | { id: string; title: string; created_by: string | null }
    | null;
  if (!experiment) {
    await stampFailure(supabase, row.id, "experiment not found");
    return { outcome: "send_failed", bookingGroupId, detail: "experiment missing" };
  }

  // 3.5) Acquire dispatch lock (P0-Α). Atomic UPDATE that succeeds only
  // if no other trigger holds an unexpired lease. Without this, four
  // trigger paths (PUT-completed / observation auto-complete / /run
  // verify auto-complete / cron sweep) all racing through the same
  // booking_group within the SMTP-call window (~700ms) would each
  // dispatch a separate email, and the post-hoc sent_at CAS at the
  // end would only stamp once. Net: participant gets 2-4 copies, with
  // different tokens (preserve vs rotate diverged on hash race).
  //
  // Lock holds for DISPATCH_LOCK_TTL_MS so a crashed worker doesn't
  // block delivery indefinitely; another trigger picks it up after
  // expiry. Lock is released on both success (with sent_at stamp) and
  // failure (without stamp, so retry is allowed).
  const lockUntilIso = new Date(Date.now() + DISPATCH_LOCK_TTL_MS).toISOString();
  const nowIsoForLock = new Date().toISOString();
  // C6 fix (Codex review 2026-05-28): when force=true (explicit
  // researcher resend after amount edit), atomically reset
  // payment_link_sent_at=null + payment_link_attempts=0 in the SAME
  // UPDATE that acquires the lock. The lock then becomes the single
  // source of truth even on resend; previously the route handlers
  // reset sent_at *before* calling notify, so two near-simultaneous
  // resend clicks could both reset, both acquire the lock (each
  // succeeding because sent_at was NULL when they raced), and both
  // send — participant got two copies. Now only one UPDATE wins.
  //
  // The lock predicate stays `payment_link_sent_at IS NULL` for the
  // non-force path (idempotent first dispatch). For force, drop that
  // check because the same UPDATE nulls it.
  const lockUpdate: {
    payment_link_dispatch_lock_until: string;
    payment_link_sent_at?: string | null;
    payment_link_attempts?: number;
  } = {
    payment_link_dispatch_lock_until: lockUntilIso,
  };
  if (options.force) {
    lockUpdate.payment_link_sent_at = null;
    lockUpdate.payment_link_attempts = 0;
  }
  // Codex 2nd-pass L (2026-05-29): the success / failure increments
  // below add 1 to row.payment_link_attempts (the pre-lock snapshot).
  // When force=true reset the column to 0 in the SAME UPDATE that
  // acquired the lock, that increment would write stale+1 instead of
  // 1. Track the post-reset base here so the increment reflects DB
  // truth.
  const attemptsBase = options.force ? 0 : row.payment_link_attempts ?? 0;
  let lockQuery = supabase
    .from("participant_payment_info")
    .update(lockUpdate, { count: "exact" })
    .eq("id", row.id)
    .or(
      `payment_link_dispatch_lock_until.is.null,payment_link_dispatch_lock_until.lt.${nowIsoForLock}`,
    );
  if (!options.force) {
    lockQuery = lockQuery.is("payment_link_sent_at", null);
  }
  const { count: lockCount } = await lockQuery;

  if ((lockCount ?? 0) === 0) {
    return {
      outcome: "lock_held",
      bookingGroupId,
      detail: "another dispatch in progress",
    };
  }

  // From here on: any return path must release the lock (set back to NULL).
  // Wrap the SMTP-and-stamp work in try/finally to guarantee release on
  // unexpected throws too. The `released` flag prevents a double-clear in
  // the success path (stamp + clear in one UPDATE) from being undone by
  // the finally block.
  let released = false;
  const releaseLock = async () => {
    if (released) return;
    released = true;
    await supabase
      .from("participant_payment_info")
      .update({ payment_link_dispatch_lock_until: null })
      .eq("id", row.id);
  };

  try {
  // C8/C9 fix (Codex review 2026-05-28): the amount and the auto-send
  // flag were both read BEFORE the dispatch lock above. A researcher
  // who PATCHes amount or toggles auto_send while we were waiting on
  // the lock would have their new value ignored — the email would
  // send the stale snapshot. Now that we hold the lock, re-fetch both
  // so the email body and the gate decision use the freshest committed
  // state. We re-validate auto_send + amount under-lock; row.id is
  // already pinned so the re-read is a single-row hit.
  const { data: freshRowRaw } = await supabase
    .from("participant_payment_info")
    .select(
      "amount_krw, status, payment_link_sent_at, name_override, email_override",
    )
    .eq("id", row.id)
    .maybeSingle();
  const freshRow = freshRowRaw as
    | {
        amount_krw: number;
        status: string;
        payment_link_sent_at: string | null;
        name_override: string | null;
        email_override: string | null;
      }
    | null;
  if (freshRow) {
    row.amount_krw = freshRow.amount_krw;
    row.name_override = freshRow.name_override;
    row.email_override = freshRow.email_override;
    // Codex 2nd-pass M (2026-05-29): recompute the recipient address +
    // display name from the freshly-fetched overrides. Without this,
    // an admin who edited email_override/name_override between the
    // pre-lock fetch and the lock acquire had their edit silently
    // ignored — the email body still used the stale recipient.
    recipientEmail =
      (freshRow.email_override?.trim() ||
        participant?.email ||
        "").trim();
    recipientName =
      (freshRow.name_override?.trim() ||
        participant?.name ||
        "").trim();
    if (!recipientEmail) {
      await releaseLock();
      await stampFailure(supabase, row.id, "no recipient email after override removal");
      return { outcome: "no_recipient", bookingGroupId };
    }
    // Codex 2nd-pass M: re-check status as well. submit/route.ts can
    // CAS pending_participant → submitted_to_admin from another
    // request between our pre-lock status gate at line 156 and SMTP
    // dispatch below. Without this re-check we'd email a participant
    // who already submitted bank info — confusing at best.
    if (freshRow.status !== "pending_participant") {
      await releaseLock();
      // Stamp sent_at so a future retrigger doesn't re-send.
      await supabase
        .from("participant_payment_info")
        .update({ payment_link_sent_at: new Date().toISOString() })
        .eq("id", row.id);
      return {
        outcome: "already_sent",
        bookingGroupId,
        detail: `status changed to ${freshRow.status} after lock acquire`,
      };
    }
    // Defensive: another trigger may have stamped sent_at + released
    // the lock between our lock CAS and this re-fetch. We backed off
    // cleanly with already_sent in that case (the CAS only succeeds
    // when sent_at IS NULL — so this branch is dead code in practice
    // but cheap insurance against future lock-pattern changes).
    if (freshRow.payment_link_sent_at) {
      await releaseLock();
      return { outcome: "already_sent", bookingGroupId, detail: "stamped after lock acquire" };
    }
  }
  // Re-validate auto_send under lock. force=true bypasses, matching
  // the pre-lock check at step 3a.
  if (!options.force) {
    const { data: gateRaw } = await supabase
      .from("experiments")
      .select("payment_link_auto_send")
      .eq("id", row.experiment_id)
      .maybeSingle();
    const gate = gateRaw as { payment_link_auto_send?: boolean | null } | null;
    if (gate && gate.payment_link_auto_send === false) {
      await releaseLock();
      return {
        outcome: "auto_send_disabled",
        bookingGroupId,
        detail: "auto_send toggled off after lock acquire",
      };
    }
  }
  // Same guard for amount_krw becoming 0 after override.
  if (row.amount_krw <= 0) {
    await releaseLock();
    return { outcome: "amount_zero", bookingGroupId, detail: "amount zeroed after lock acquire" };
  }
  // 4) Token strategy (P0 #6):
  //
  //   a) If the participant has ALREADY opened the link
  //      (payment_link_first_opened_at != null) AND we still have the
  //      encrypted plaintext (token_cipher != null), reuse the SAME
  //      token. Their bookmark / open tab keeps working; the dispatch
  //      email simply nudges them to come finish.
  //
  //   b) Otherwise mint a fresh token and rotate the hash. Covers the
  //      security-conscious path (link never observed → no benefit
  //      from preserving) AND the legacy fallback (rows seeded before
  //      migration 00052 don't have token_cipher).
  //
  // Either way the email gets a working link.
  let tokenString: string;
  let tokenExpiresAtIso: string;
  const cipherBytes = bytesFromSupabase(row.token_cipher);
  const ivBytes = bytesFromSupabase(row.token_iv);
  const tagBytes = bytesFromSupabase(row.token_tag);
  const haveEncryptedToken =
    cipherBytes.length > 0 &&
    ivBytes.length > 0 &&
    tagBytes.length > 0 &&
    row.token_key_version != null;
  const userAlreadyOpened = row.payment_link_first_opened_at != null;
  let preservedToken = false;

  if (userAlreadyOpened && haveEncryptedToken) {
    try {
      tokenString = decryptToken({
        cipher: cipherBytes,
        iv: ivBytes,
        tag: tagBytes,
        keyVersion: row.token_key_version!,
      });
      tokenExpiresAtIso = row.token_expires_at;
      preservedToken = true;
    } catch (err) {
      // Decrypt failure (key rotated out without re-encrypt, corrupt
      // ciphertext, etc.) — fall through to rotation rather than
      // abort the dispatch.
      console.warn(
        `[PaymentInfoNotify] decryptToken failed for ${bookingGroupId}; falling back to rotation: ${err instanceof Error ? err.message : String(err)}`,
      );
      const issued = issuePaymentToken(bookingGroupId);
      tokenString = issued.token;
      tokenExpiresAtIso = new Date(issued.expiresAt).toISOString();
      // P0-Β fix: rotate cipher in lockstep with hash. Without this, the
      // row would keep stale ciphertext that decrypts to the OLD token,
      // and the next dispatch would think it can preserve — but the
      // preserved token's hash no longer matches token_hash, so the
      // page rejects as INVALID. Encrypt the new token so cipher and
      // hash always describe the same plaintext.
      const enc = encryptToken(issued.token);
      const toHex = (b: Buffer) => `\\x${b.toString("hex")}`;
      await supabase
        .from("participant_payment_info")
        .update({
          token_hash: issued.hash,
          token_cipher: toHex(enc.cipher),
          token_iv: toHex(enc.iv),
          token_tag: toHex(enc.tag),
          token_key_version: enc.keyVersion,
          token_issued_at: new Date(issued.issuedAt).toISOString(),
          token_expires_at: tokenExpiresAtIso,
          token_revoked_at: null,
        })
        .eq("id", row.id);
    }
  } else {
    const issued = issuePaymentToken(bookingGroupId);
    tokenString = issued.token;
    tokenExpiresAtIso = new Date(issued.expiresAt).toISOString();
    // P0-Β fix — see decrypt-fallback comment above. Same lockstep
    // requirement: write cipher with the new hash.
    const enc = encryptToken(issued.token);
    const toHex = (b: Buffer) => `\\x${b.toString("hex")}`;
    await supabase
      .from("participant_payment_info")
      .update({
        token_hash: issued.hash,
        token_cipher: toHex(enc.cipher),
        token_iv: toHex(enc.iv),
        token_tag: toHex(enc.tag),
        token_key_version: enc.keyVersion,
        token_issued_at: new Date(issued.issuedAt).toISOString(),
        token_expires_at: tokenExpiresAtIso,
        token_revoked_at: null,
      })
      .eq("id", row.id);
  }

  // 5) Researcher contact (best-effort).
  let researcher: {
    displayName: string | null;
    contactEmail: string | null;
    phone: string | null;
  } | null = null;
  if (experiment.created_by) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("display_name, contact_email, phone")
      .eq("id", experiment.created_by)
      .maybeSingle();
    if (profile) {
      researcher = {
        displayName: (profile as { display_name: string | null }).display_name,
        contactEmail: (profile as { contact_email: string | null }).contact_email,
        phone: (profile as { phone: string | null }).phone,
      };
    }
  }

  // 6) Build URL.
  const origin = getAppOrigin();
  const path = `/payment-info/${encodeURIComponent(tokenString)}`;
  const paymentUrl = origin ? `${origin}${path}` : path;

  // 7) Render + send.
  const built = buildPaymentInfoEmail({
    participantName: recipientName,
    participantEmail: recipientEmail,
    experimentTitle: experiment.title,
    amountKrw: row.amount_krw,
    paymentUrl,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    researcher,
    tokenExpiresAt: tokenExpiresAtIso,
    isReminder: preservedToken,
  });

  // C-P1-4 Reply-To = researcher contact_email
  const replyTo =
    (researcher?.contactEmail ?? "").trim() || undefined;
  const sendResult = await mailer({
    to: built.to,
    subject: built.subject,
    html: built.html,
    replyTo,
  });

  const nowIso = new Date().toISOString();
  if (!sendResult.success) {
    // Release lock + record failure. Lock cleared so the next trigger
    // can retry without waiting for the lease expiry.
    released = true;
    await supabase
      .from("participant_payment_info")
      .update({
        payment_link_attempts: attemptsBase + 1,
        payment_link_last_error: (sendResult.error ?? "unknown").slice(0, 500),
        payment_link_last_attempt_at: nowIso,
        payment_link_dispatch_lock_until: null,
      })
      .eq("id", row.id);
    return {
      outcome: "send_failed",
      bookingGroupId,
      detail: sendResult.error ?? "unknown",
    };
  }

  // Success — stamp sent_at + clear lock atomically. With the
  // dispatch lock acquired earlier, the post-hoc `is sent_at NULL`
  // CAS here is no longer load-bearing, but kept as belt-and-
  // braces against an operator manually clearing the lock.
  released = true;
  const { count } = await supabase
    .from("participant_payment_info")
    .update(
      {
        payment_link_sent_at: nowIso,
        payment_link_attempts: attemptsBase + 1,
        payment_link_last_error: null,
        payment_link_last_attempt_at: nowIso,
        payment_link_dispatch_lock_until: null,
      },
      { count: "exact" },
    )
    .eq("id", row.id)
    .is("payment_link_sent_at", null);

  if ((count ?? 0) === 0) {
    // With the lock in place, this branch should not normally fire.
    // If it does, something circumvented the lock (operator-initiated
    // backfill, SQL console etc). Surface as a warn so it's visible.
    console.warn(
      `[PaymentInfoNotify] post-lock CAS lost for ${bookingGroupId}; message ${sendResult.messageId} sent but sent_at was already non-null`,
    );
  }

  return { outcome: "sent", bookingGroupId, detail: sendResult.messageId };
  } finally {
    // Belt-and-braces: if any unexpected throw escaped the try (template
    // crash, network error before stamp, etc.), release the lock so the
    // next trigger isn't blocked for 5 minutes.
    await releaseLock().catch(() => {
      // Even the lock-release can fail; log and move on. The lease
      // will naturally expire after DISPATCH_LOCK_TTL_MS.
    });
  }
}

async function stampFailure(supabase: Supabase, rowId: string, reason: string) {
  const nowIso = new Date().toISOString();
  await supabase
    .from("participant_payment_info")
    .update({
      payment_link_last_error: reason.slice(0, 500),
      payment_link_last_attempt_at: nowIso,
    })
    .eq("id", rowId);
}

// ── Sweep helper: iterate over all groups whose bookings are completed
//    but whose payment_link_sent_at is NULL. Used by the auto-complete
//    cron after it flips a batch of rows to 'completed'. Bounded so a
//    single cron tick can't fan out to thousands of SMTP calls.
const SWEEP_LIMIT = 50;

export async function sweepPaymentInfoNotifications(
  supabase: Supabase,
  mailer: Mailer = defaultSendEmail,
): Promise<{ examined: number; sent: number; errors: number; results: NotifyResult[] }> {
  // C7 fix (Codex review 2026-05-28): exclude experiments whose
  // researcher opted out of auto-dispatch (migration 00065). Otherwise
  // every cron tick re-examines every held-up opt-out row, returning
  // 'auto_send_disabled' each time and starving rows that should
  // actually go out. Filter via a nested experiments(payment_link_auto_send)
  // join — supabase-js !inner() forces an INNER JOIN we can constrain.
  const { data: rows } = await supabase
    .from("participant_payment_info")
    .select("booking_group_id, experiments!inner(payment_link_auto_send)")
    .is("payment_link_sent_at", null)
    .eq("status", "pending_participant")
    .gt("amount_krw", 0)
    .eq("experiments.payment_link_auto_send", true)
    .limit(SWEEP_LIMIT);

  const results: NotifyResult[] = [];
  let sent = 0;
  let errors = 0;
  for (const r of rows ?? []) {
    const bgId = (r as { booking_group_id: string }).booking_group_id;
    try {
      const result = await notifyPaymentInfoIfReady(supabase, bgId, mailer);
      results.push(result);
      if (result.outcome === "sent") sent++;
      if (result.outcome === "send_failed" || result.outcome === "no_recipient") errors++;
    } catch (err) {
      errors++;
      results.push({
        outcome: "send_failed",
        bookingGroupId: bgId,
        detail: err instanceof Error ? err.message : "unknown",
      });
    }
  }
  return { examined: (rows ?? []).length, sent, errors, results };
}
