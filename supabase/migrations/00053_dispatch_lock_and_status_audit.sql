-- 이메일 자동 발송 인프라의 두 가지 결함 (P0-Α + P0-Η, 개선 플랜 Phase 2)
-- 을 처리하기 위한 schema 변경.
--
-- 결함 1 — payment-info-notify 의 "post-hoc CAS" race
--   현재: SELECT (sent_at IS NULL) → SMTP send (~700ms) → conditional
--         UPDATE. SELECT 와 UPDATE 사이의 SMTP call 이 들어 있는 동안
--         4개 트리거 (PUT-completed / observation auto-complete /
--         /run verify auto-complete / cron sweep) 가 동시에 fire 하면
--         같은 booking_group 에 2~4통 메일이 나간다. CAS 는 발송이
--         아닌 stamp 만 막는다.
--   수정: dispatch_lock_until 컬럼 추가. notify 시작 시 atomic UPDATE
--         로 lock 획득 (5분 lease) → SMTP → 성공 시 sent_at stamp +
--         lock release. lock 보유 중 다른 트리거는 즉시 skip.
--
-- 결함 2 — status-notify (cancel/no_show) 가 booking_integrations 에
--         audit row 안 남김
--   현재: PUT /api/bookings/[id] 의 cancel/no_show 분기가 notify 결과
--         를 console.warn 만 함. 발송 실패 시 사일런트 손실. 참여자가
--         "왜 통보 안 받았어요?" 항의 시 추적 불가.
--   수정: integration_type enum 에 status_email + status_sms 추가.
--         notify 함수가 마지막에 booking_integrations row INSERT.
--
-- 둘 다 가산형 변경 — 기존 행에 영향 X.

-- ── 1. dispatch lock ────────────────────────────────────────────────
ALTER TABLE participant_payment_info
  ADD COLUMN IF NOT EXISTS payment_link_dispatch_lock_until timestamptz;

COMMENT ON COLUMN participant_payment_info.payment_link_dispatch_lock_until IS
  '발송 시도 중인 트리거가 보유한 lease 만료 시각. atomic UPDATE 로 획득; SMTP 완료 후 release. 두 트리거 간 race 방지 (P0-Α).';

-- 락 만료 후 다른 트리거가 빨리 잡을 수 있도록 lookup 인덱스. payment_link_sent_at
-- IS NULL + lock 만료 두 조건을 partial index 로.
CREATE INDEX IF NOT EXISTS idx_payment_info_dispatch_eligible
  ON participant_payment_info (payment_link_dispatch_lock_until)
  WHERE payment_link_sent_at IS NULL
    AND status = 'pending_participant';

-- ── 2. integration_type enum 확장 — status email/sms 가 audit row 남기도록 ─
ALTER TYPE integration_type ADD VALUE IF NOT EXISTS 'status_email';
ALTER TYPE integration_type ADD VALUE IF NOT EXISTS 'status_sms';

-- 참고: PostgreSQL 은 같은 transaction 안에서 enum 새 값을 INSERT 에
-- 사용 못 한다. 마이그레이션 적용 후 별도 transaction (= 다음 호출)
-- 부터 사용 가능. 코드 측 변경은 본 migration 적용 후 deploy.
