-- 두 가지 변경:
--
-- 1. propagate_payment_period RPC (migration 00054) 의 amount 계산이
--    participation_fee × session_count 로 잘못 계산되고 있었음. 실제
--    의도는 "experiments.participation_fee = booking_group 1건당 총
--    지급액" (다회차여도 한 번만 지급). RPC 재정의 + 기존 잘못된
--    행 일괄 백필.
--
-- 2. mark_group_completed RPC 신규 — 정산 패널에서 "회차 완료 처리"
--    버튼이 호출. booking_group 의 모든 confirmed/running booking 을
--    한 번에 'completed' 로 flip 한다. 연구원이 booking 별로
--    observation modal 을 일일이 띄우지 않아도 정산 dispatch 가
--    가능해진다. 권한 체크: SECURITY DEFINER + auth.uid() 가
--    experiment.created_by 또는 admin.

-- ── 1a. propagate_payment_period 재정의 ──────────────────────────────
CREATE OR REPLACE FUNCTION propagate_payment_period(p_booking_group_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_payment participant_payment_info;
  v_experiment experiments;
  v_min_start timestamptz;
  v_max_end timestamptz;
  v_session_count integer;
  v_new_amount integer;
BEGIN
  SELECT * INTO v_payment FROM participant_payment_info
   WHERE booking_group_id = p_booking_group_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'NO_PAYMENT_ROW');
  END IF;

  IF v_payment.status <> 'pending_participant' THEN
    RETURN jsonb_build_object('success', false, 'error', 'NOT_PENDING',
      'status', v_payment.status);
  END IF;

  SELECT * INTO v_experiment FROM experiments WHERE id = v_payment.experiment_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'NO_EXPERIMENT');
  END IF;

  SELECT MIN(slot_start), MAX(slot_end), COUNT(*)
    INTO v_min_start, v_max_end, v_session_count
    FROM bookings
   WHERE booking_group_id = p_booking_group_id
     AND status IN ('confirmed', 'running', 'completed');
  IF v_min_start IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'NO_LIVE_BOOKINGS');
  END IF;

  -- Fee semantics: experiments.participation_fee = total per
  -- booking_group, NOT per session. Multi-session experiments still
  -- get one fee. Override path (amount_overridden=true) preserved.
  IF v_payment.amount_overridden THEN
    v_new_amount := v_payment.amount_krw;
  ELSE
    v_new_amount := COALESCE(v_experiment.participation_fee, 0);
  END IF;

  UPDATE participant_payment_info
     SET period_start = (v_min_start AT TIME ZONE 'Asia/Seoul')::date,
         period_end   = (v_max_end   AT TIME ZONE 'Asia/Seoul')::date,
         amount_krw   = v_new_amount
   WHERE id = v_payment.id;

  RETURN jsonb_build_object(
    'success', true,
    'period_start', (v_min_start AT TIME ZONE 'Asia/Seoul')::date,
    'period_end',   (v_max_end   AT TIME ZONE 'Asia/Seoul')::date,
    'amount_krw',   v_new_amount,
    'session_count', v_session_count
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION propagate_payment_period(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION propagate_payment_period(uuid) TO authenticated, service_role;

-- ── 1b. backfill existing wrong rows ────────────────────────────────
-- Updates only where the stored amount looks like fee*N (not 0, not
-- equal to fee already, not manually overridden). Targets rows whose
-- amount differs from experiment.participation_fee AND was not edited.
UPDATE participant_payment_info AS p
   SET amount_krw = e.participation_fee
  FROM experiments e
 WHERE p.experiment_id = e.id
   AND p.amount_overridden = false
   AND p.amount_krw <> e.participation_fee
   AND e.participation_fee > 0;

-- ── 2. mark_group_completed RPC ──────────────────────────────────────
-- Used by /api/experiments/[id]/payment-info/[bgId]/mark-completed.
-- Flips every confirmed/running booking in the group to 'completed' in
-- one transaction. Permission: experiment owner or admin (defense-in-
-- depth — the route also auth-checks).
CREATE OR REPLACE FUNCTION mark_group_completed(p_booking_group_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_is_admin boolean := false;
  v_owner uuid;
  v_updated integer := 0;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED';
  END IF;

  SELECT is_admin(v_caller) INTO v_is_admin;

  -- Resolve owner via the experiment that the booking_group belongs
  -- to (joined through the first booking).
  SELECT e.created_by
    INTO v_owner
    FROM bookings b
    JOIN experiments e ON e.id = b.experiment_id
   WHERE b.booking_group_id = p_booking_group_id
   LIMIT 1;

  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND';
  END IF;
  IF NOT v_is_admin AND v_owner <> v_caller THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;

  UPDATE bookings
     SET status = 'completed'
   WHERE booking_group_id = p_booking_group_id
     AND status IN ('confirmed', 'running');
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  RETURN jsonb_build_object('success', true, 'updated', v_updated);
END;
$$;

REVOKE EXECUTE ON FUNCTION mark_group_completed(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION mark_group_completed(uuid) TO authenticated;
