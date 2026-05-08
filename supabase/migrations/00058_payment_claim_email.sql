-- payment_claims: track 행정 dispatch email
--
-- After the researcher generates the participant-fee bundle, they can
-- ask the app to deliver it to the 행정 office via the lab's vnilab@gmail
-- account (preview + confirm flow on the frontend). Each payment_claim
-- can have at most one successful dispatch — re-sending requires a new
-- "재발송" click which calls the same endpoint and overwrites the
-- timestamp + recipient + message-id.

ALTER TABLE payment_claims
  ADD COLUMN IF NOT EXISTS email_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS email_sent_to text,
  ADD COLUMN IF NOT EXISTS email_message_id text;

COMMENT ON COLUMN payment_claims.email_sent_at IS
  '행정 dispatch email 송신 시각. NULL = 아직 발송 안 됨.';
COMMENT ON COLUMN payment_claims.email_sent_to IS
  '발송된 행정 이메일 주소 (감사용 스냅샷).';
COMMENT ON COLUMN payment_claims.email_message_id IS
  'Gmail SMTP의 message-id 응답값. 추후 retry / 영수 추적용.';
