-- payment_claims: track 행정 dispatch email failures
--
-- The first version of the email feature stamped only success state
-- (email_sent_at + email_sent_to + email_message_id from 00058). When
-- the researcher clicked 발송 and the API path silently 4xx'd / 5xx'd,
-- the UI toast disappeared and no audit trail remained — the next
-- session debugging the issue had to reach for Vercel runtime logs,
-- which are scoped to team members only.
--
-- These columns turn each failure into a queryable DB row so the
-- researcher can see "마지막 발송 시도 ... 실패: <msg>" inside the
-- modal next time they open it.

ALTER TABLE payment_claims
  ADD COLUMN IF NOT EXISTS email_last_error text,
  ADD COLUMN IF NOT EXISTS email_last_error_at timestamptz,
  ADD COLUMN IF NOT EXISTS email_attempt_count integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN payment_claims.email_last_error IS
  '마지막 발송 시도에서 발생한 에러 메시지. 성공 시 NULL 로 클리어.';
COMMENT ON COLUMN payment_claims.email_last_error_at IS
  '마지막 발송 시도 실패 시각.';
COMMENT ON COLUMN payment_claims.email_attempt_count IS
  '총 발송 시도 횟수 (성공 + 실패 합). 한 청구당 재시도 패턴 추적용.';
