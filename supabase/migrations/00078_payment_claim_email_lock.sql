-- 00078 — payment_claims.email_sending_at (atomic send lock)
--
-- The dispatch email (POST /payment-claim/[claimId]/email) carries
-- plaintext RRN + bank details + bankbook scans. Before this column the
-- "at most one successful dispatch" invariant from 00058 was enforced
-- only by a frontend confirm dialog, so two rapid POSTs (double-click or
-- a retry race) could each pass the check and send TWO PII-bearing emails
-- to 행정.
--
-- The route now acquires an in-DB lock atomically:
--   UPDATE payment_claims SET email_sending_at = now()
--    WHERE id = :id
--      AND (email_sending_at IS NULL OR email_sending_at < now()-'5min')
--      AND email_sent_at IS NULL         -- omitted for an explicit 재발송
--   RETURNING id
-- Only the POST whose UPDATE returns a row proceeds to send; the loser
-- gets a 409. On success email_sending_at is cleared and email_sent_at
-- stamped; on failure the lock is released so a retry can re-acquire it.
-- The 5-minute staleness window lets a crashed/timed-out send self-heal.
--
-- Additive + idempotent (ADD COLUMN IF NOT EXISTS). Apply BEFORE the
-- commit-2 code deploys — the send route references the column
-- immediately. NOTIFY refreshes PostgREST's schema cache.

ALTER TABLE payment_claims
  ADD COLUMN IF NOT EXISTS email_sending_at timestamptz;

COMMENT ON COLUMN payment_claims.email_sending_at IS
  '진행 중인 행정 dispatch 발송의 원자 락. 발송 성공 시 NULL + email_sent_at 스탬프, 실패 시 NULL 해제. 5분 초과 stale 락은 재획득 허용. 동시 이중발송(중복 PII 메일) 방지용.';

NOTIFY pgrst, 'reload schema';
