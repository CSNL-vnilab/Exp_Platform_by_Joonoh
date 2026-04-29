-- 실험 종료 시 참여자에게 정산 정보 입력 링크를 자동 발송하기 위한
-- per-row dispatch 상태를 participant_payment_info 에 추가한다.
--
-- 발송 흐름:
--
-- 1. 예약 확정 시 — booking.service.seedPaymentInfo 가 row 와 token 을
--    이미 생성하지만 (확정 메일에 함께 실린다), 참여자가 그 메일을 놓치는
--    경우가 잦다. 그래서 실험 종료 (= booking_group 의 모든 booking 이
--    status='completed') 시점에 정산 입력 전용 메일을 한 번 더 자동
--    발송한다.
--
-- 2. 발송 트리거 — 다음 4 곳에서 동일한 notify 함수를 호출한다.
--      - PUT /api/bookings/[id] (수동 상태 변경 → completed)
--      - submit_booking_observation RPC 의 auto-complete 분기
--      - /run verify 엔드포인트의 auto-complete 분기
--      - 야간 cron auto_complete_stale_bookings 후 sweep
--
-- 3. 멱등성 — payment_link_sent_at 이 NULL 인 행만 발송한다. 같은 그룹의
--    여러 booking 이 차례로 completed 로 전이되어도 마지막 한 번만 메일이
--    나간다.
--
-- 4. 재발송 — 연구원이 명시적으로 "재발송" 버튼을 누르면 같은 row 의
--    payment_link_sent_at 을 NULL 로 리셋하고 다시 호출한다 (아래 RPC).
--
-- 컬럼 모두 nullable / 0 default — 기존 행은 backfill 비용 0.

ALTER TABLE participant_payment_info
  ADD COLUMN IF NOT EXISTS payment_link_sent_at      timestamptz,
  ADD COLUMN IF NOT EXISTS payment_link_attempts     integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payment_link_last_error   text,
  ADD COLUMN IF NOT EXISTS payment_link_last_attempt_at timestamptz;

COMMENT ON COLUMN participant_payment_info.payment_link_sent_at IS
  '실험 종료 후 정산 링크 메일을 처음으로 성공적으로 발송한 시각.';
COMMENT ON COLUMN participant_payment_info.payment_link_attempts IS
  '발송 시도 횟수 (성공·실패 모두 합산). 디버깅용.';
COMMENT ON COLUMN participant_payment_info.payment_link_last_error IS
  '마지막 실패 사유 (SMTP 응답 등). 성공 시 NULL 로 클리어.';
COMMENT ON COLUMN participant_payment_info.payment_link_last_attempt_at IS
  '마지막 시도 시각 (성공·실패 무관). cron 의 backoff 판단용.';

-- ── reset_payment_link_dispatch(): 연구원의 수동 재발송 진입점 ────────────
--
-- payment_link_sent_at 을 NULL 로, 마지막 오류를 클리어하고, attempts 를
-- 0 으로 되돌린다. 행정용 보안: 행이 속한 실험의 created_by 가 호출자거나
-- admin 일 때만 허용. Anon/authenticated 모두 호출 가능하지만 RLS 권한
-- 검사를 SECURITY DEFINER 함수 내부에서 다시 한 번 한다.
CREATE OR REPLACE FUNCTION reset_payment_link_dispatch(p_booking_group_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_is_admin boolean := false;
  v_owner uuid;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED';
  END IF;

  SELECT is_admin(v_caller) INTO v_is_admin;

  SELECT e.created_by
    INTO v_owner
    FROM participant_payment_info p
    JOIN experiments e ON e.id = p.experiment_id
   WHERE p.booking_group_id = p_booking_group_id
   LIMIT 1;

  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND';
  END IF;
  IF NOT v_is_admin AND v_owner <> v_caller THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;

  UPDATE participant_payment_info
     SET payment_link_sent_at = NULL,
         payment_link_last_error = NULL,
         payment_link_attempts = 0
   WHERE booking_group_id = p_booking_group_id;

  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION reset_payment_link_dispatch(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION reset_payment_link_dispatch(uuid) TO authenticated;
