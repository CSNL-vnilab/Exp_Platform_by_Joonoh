-- 00063 — amount override workflow
--
-- 사용자 요청 (2026-05-28): 실험자가 참여자비 청구 자동 메일이 나가기
-- 전에 금액을 자유롭게 조절할 수 있도록 — 예) 5회차 90,000원 실험이
-- 실험 지연으로 6회차로 늘어났거나, 2회차에서 조기 중단된 경우.
--
-- amount_krw + amount_overridden 자체는 마이그레이션 00024 에 이미
-- 들어가 있으므로 이 파일은 다음 두 가지만 추가한다:
--
--   1. experiments.payment_link_auto_send  (boolean, default true)
--      - true (기본) : 모든 booking 이 completed 가 되는 즉시
--        notifyPaymentInfoIfReady 가 정산 안내 메일을 발송한다.
--        (기존 동작과 동일 — breaking change 없음)
--      - false : 자동 발송을 보류한다. 실험자가 payment-panel 에서
--        amount 를 확인/조정 후 직접 "안내 메일 발송" 버튼으로
--        보낸다. 다회차 실험에서 회차 수 변동이 잦은 paradigm 의
--        실험자가 opt-in 으로 켜는 안전 모드.
--
--   2. participant_payment_info.amount_overridden_by/at
--      - 누가/언제 amount 를 수동 조정했는지 audit 로그. 청구 시 또는
--        분쟁 시 추적 가능. NULL 이면 자동값 (= participation_fee 기반).

BEGIN;

-- 1) experiments.payment_link_auto_send
ALTER TABLE experiments
  ADD COLUMN IF NOT EXISTS payment_link_auto_send boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN experiments.payment_link_auto_send IS
  'When true (default), notifyPaymentInfoIfReady auto-sends the payment-info request email the moment every booking in a group flips to completed. When false, the researcher must explicitly trigger the send from the payment-panel — used when the experiment is prone to session-count changes (extension / early stop) and the amount needs a manual check before going out.';

-- 2) participant_payment_info.amount_overridden_by/at audit columns
ALTER TABLE participant_payment_info
  ADD COLUMN IF NOT EXISTS amount_overridden_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS amount_overridden_at timestamptz;

COMMENT ON COLUMN participant_payment_info.amount_overridden_by IS
  'profiles.id of the researcher/admin who last changed amount_krw via the PATCH /amount endpoint. NULL when amount_krw is still the auto-seeded value from experiments.participation_fee.';
COMMENT ON COLUMN participant_payment_info.amount_overridden_at IS
  'Timestamp of the last manual amount_krw change. Together with amount_overridden_by, gives a simple audit trail for 행정 정산 분쟁 추적.';

-- Backfill: rows that already have amount_overridden=true but no
-- overridden_at — best-effort stamp with updated_at when present, else
-- leave NULL (existing UI will gracefully fall back to "수정됨").
UPDATE participant_payment_info
SET amount_overridden_at = COALESCE(amount_overridden_at, updated_at, NOW())
WHERE amount_overridden = true
  AND amount_overridden_at IS NULL;

COMMIT;
