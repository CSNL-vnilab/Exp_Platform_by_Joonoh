-- 자동 정산 메일 (payment-info-notify) 의 토큰 회전이 참여자가 이미
-- 받은 링크를 죽이는 문제를 해결하기 위한 스키마 변경.
--
-- Audit P0 #6 — 시나리오:
--   1. 예약 확정 메일에 정산 링크 포함 (booking-email-template:paymentBlock)
--   2. 참여자가 그 링크를 열어두거나 북마크
--   3. 마지막 세션 종료 → 자동 정산 메일 발송
--      (payment-info-notify.service.ts) → 새 토큰 발급 + hash 회전
--   4. 참여자의 기존 링크가 invalid 로 죽음 → "어제 입력 시작했는데
--      오늘 invalid?" 컴플레인
--
-- 해결 (option (a) 채택): 참여자가 한 번이라도 링크를 열었으면
-- (page-load 시점에 first_opened_at 기록), 자동 메일 발송 시 토큰을
-- 회전하지 않고 동일 URL 을 재발송한다. 이를 위해 plaintext 토큰을
-- AES-256-GCM 으로 암호화하여 저장 (PAYMENT_INFO_KEY 재사용 — RRN 과
-- 동일 threat profile, 60일 TTL).
--
-- 컬럼 모두 nullable. 기존 행은 token_cipher 가 NULL → 자동 메일이
-- 기존처럼 회전 (legacy fallback). 신규 행만 새 동작.

ALTER TABLE participant_payment_info
  ADD COLUMN IF NOT EXISTS token_cipher                bytea,
  ADD COLUMN IF NOT EXISTS token_iv                    bytea,
  ADD COLUMN IF NOT EXISTS token_tag                   bytea,
  ADD COLUMN IF NOT EXISTS token_key_version           smallint,
  ADD COLUMN IF NOT EXISTS payment_link_first_opened_at timestamptz;

COMMENT ON COLUMN participant_payment_info.token_cipher IS
  'AES-256-GCM 암호화된 토큰 plaintext. 자동 메일에서 동일 URL 재발송 시 사용. PAYMENT_INFO_KEY 사용.';
COMMENT ON COLUMN participant_payment_info.payment_link_first_opened_at IS
  '참여자가 정산 입력 페이지를 처음 연 시각. NOT NULL 이면 자동 메일에서 토큰을 회전하지 않는다.';

-- Shape sanity: token_* 트리플은 함께 채워지거나 함께 NULL 이어야 함.
ALTER TABLE participant_payment_info
  ADD CONSTRAINT payment_info_token_blob_complete CHECK (
    (token_cipher IS NULL AND token_iv IS NULL AND token_tag IS NULL AND token_key_version IS NULL)
    OR (token_cipher IS NOT NULL AND token_iv IS NOT NULL AND token_tag IS NOT NULL AND token_key_version IS NOT NULL)
  );
