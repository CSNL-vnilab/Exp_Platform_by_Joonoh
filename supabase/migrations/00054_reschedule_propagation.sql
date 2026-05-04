-- Reschedule propagation RPCs (P0-Γ, 개선 플랜 Phase 3).
--
-- 결함:
--   PATCH /api/bookings/[id] 가 booking 의 slot_start/end 만 update 하고
--   다음 두 가지 의존 row 는 그대로 둔다:
--
--   1. reminders.scheduled_at — `book_slot` 시점에 KST 기반 day-before
--      18:00 / day-of 09:00 으로 큐된 timestamp. reschedule 후에도 옛
--      시각에 cron 이 fire → "내일 실험 안내" 메일이 어제 18:00 에
--      도착하거나 오늘 실험 종료 후 도착.
--
--   2. participant_payment_info.period_start / period_end / amount_krw
--      — booking 시점의 slot 분포로 계산. 다음 자동 정산 메일은 옛
--      period 텍스트를 사용 → 행정 entries 와 어긋남.
--
-- 두 가지 다 RPC 로 묶음:
--   - reschedule_reminders(booking_id, new_slot_start, new_slot_end)
--   - propagate_payment_period(booking_group_id)
--
-- 둘 다 idempotent 하고 user-input 없음 (기존 데이터 + 실험 설정만 사용).
-- 호출자는 booking UPDATE 직후 둘 다 fire-and-forget 호출.

-- ── 1. reschedule_reminders ─────────────────────────────────────────────
--
-- 동작:
--   - status='pending' reminders 만 update (이미 sent / failed / cancelled
--     은 그대로).
--   - 새 시각이 now() 보다 과거면 그 reminder 는 status='cancelled' 처리
--     (silent skip — book_slot 도 v_day_of_at > now() 같은 가드를 두고
--     INSERT 안 하는 패턴과 동일한 의미를 사후에 적용).
--   - day_before / day_of 두 type 둘 다 처리.

CREATE OR REPLACE FUNCTION reschedule_reminders(
  p_booking_id uuid,
  p_new_slot_start timestamptz,
  p_new_slot_end timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_experiment experiments;
  v_day_before_at timestamptz;
  v_day_of_at timestamptz;
  v_slot_start_kst_time time;
  v_updated integer := 0;
  v_cancelled integer := 0;
  v_tmp integer := 0;
BEGIN
  SELECT e.* INTO v_experiment
    FROM bookings b
    JOIN experiments e ON e.id = b.experiment_id
   WHERE b.id = p_booking_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'BOOKING_NOT_FOUND');
  END IF;

  -- KST math mirrors book_slot exactly so propagate behavior matches initial seed.
  v_day_before_at := ((p_new_slot_start AT TIME ZONE 'Asia/Seoul')::date - 1)
    + v_experiment.reminder_day_before_time AT TIME ZONE 'Asia/Seoul';
  v_day_of_at := (p_new_slot_start AT TIME ZONE 'Asia/Seoul')::date
    + v_experiment.reminder_day_of_time AT TIME ZONE 'Asia/Seoul';
  v_slot_start_kst_time := (p_new_slot_start AT TIME ZONE 'Asia/Seoul')::time;

  -- ── day_before_evening ─────────────────────────────────────────────
  IF v_experiment.reminder_day_before_enabled AND v_day_before_at > now() THEN
    UPDATE reminders
       SET scheduled_at = v_day_before_at
     WHERE booking_id = p_booking_id
       AND reminder_type = 'day_before_evening'
       AND status = 'pending';
    GET DIAGNOSTICS v_updated = ROW_COUNT;
  ELSE
    -- New slot leaves the day-before reminder in the past (or feature
    -- disabled). Mark pending reminders cancelled so the cron skips.
    UPDATE reminders
       SET status = 'cancelled'
     WHERE booking_id = p_booking_id
       AND reminder_type = 'day_before_evening'
       AND status = 'pending';
    GET DIAGNOSTICS v_tmp = ROW_COUNT;
    v_cancelled := v_cancelled + v_tmp;
  END IF;

  -- ── day_of_morning ─────────────────────────────────────────────────
  IF v_experiment.reminder_day_of_enabled
     AND v_day_of_at > now()
     AND v_day_of_at < p_new_slot_start
     AND v_experiment.reminder_day_of_time < v_slot_start_kst_time THEN
    UPDATE reminders
       SET scheduled_at = v_day_of_at
     WHERE booking_id = p_booking_id
       AND reminder_type = 'day_of_morning'
       AND status = 'pending';
    GET DIAGNOSTICS v_tmp = ROW_COUNT;
    v_updated := v_updated + v_tmp;
  ELSE
    UPDATE reminders
       SET status = 'cancelled'
     WHERE booking_id = p_booking_id
       AND reminder_type = 'day_of_morning'
       AND status = 'pending';
    GET DIAGNOSTICS v_tmp = ROW_COUNT;
    v_cancelled := v_cancelled + v_tmp;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'updated', v_updated,
    'cancelled', v_cancelled
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION reschedule_reminders(uuid, timestamptz, timestamptz) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION reschedule_reminders(uuid, timestamptz, timestamptz) TO authenticated, service_role;

-- ── 2. propagate_payment_period ────────────────────────────────────────
--
-- After a reschedule the booking_group's MIN(slot_start) / MAX(slot_end)
-- may have changed. Sync into participant_payment_info so:
--   - the auto-dispatch email body shows the right "실험 기간" line
--   - the Excel export's date-span column is correct
--   - the amount_krw stays in sync if session_count semantics changed
--     (currently fee × N sessions; this RPC re-derives it unless the
--     researcher has set amount_overridden=true)
--
-- Skips already-submitted rows — propagating period after submit could
-- mislead the admin who already exported. Status='pending_participant'
-- only.
--
-- Returns the new period for the route handler to log.

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

  -- Skip submitted/claimed/paid rows — propagating period would corrupt
  -- the admin's view of what was claimed.
  IF v_payment.status <> 'pending_participant' THEN
    RETURN jsonb_build_object('success', false, 'error', 'NOT_PENDING',
      'status', v_payment.status);
  END IF;

  SELECT * INTO v_experiment FROM experiments WHERE id = v_payment.experiment_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'NO_EXPERIMENT');
  END IF;

  -- Recompute period from current bookings (post-reschedule).
  -- Excludes cancelled/no_show — those bookings shouldn't influence the
  -- payment period.
  SELECT MIN(slot_start), MAX(slot_end), COUNT(*)
    INTO v_min_start, v_max_end, v_session_count
    FROM bookings
   WHERE booking_group_id = p_booking_group_id
     AND status IN ('confirmed', 'running', 'completed');
  IF v_min_start IS NULL THEN
    -- Group has no live bookings (all cancelled/no_show) — leave the
    -- payment row alone, caller can decide what to do.
    RETURN jsonb_build_object('success', false, 'error', 'NO_LIVE_BOOKINGS');
  END IF;

  -- Recompute amount only if researcher hasn't manually overridden.
  IF v_payment.amount_overridden THEN
    v_new_amount := v_payment.amount_krw;
  ELSE
    v_new_amount := COALESCE(v_experiment.participation_fee, 0) * v_session_count;
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

-- ── 3. cancelled status enum value for reminders ───────────────────────
-- reminders.status currently has CHECK / enum. We need 'cancelled' as a
-- valid value for the reschedule cancel-out path above. Inspect first.
DO $$
BEGIN
  -- Column type may be text or enum. ALTER VALUE ADD only works on
  -- enums. If it's text + check constraint, just drop+re-add the check.
  IF EXISTS (
    SELECT 1 FROM information_schema.check_constraints
     WHERE constraint_name LIKE '%reminders%status%'
        OR constraint_name LIKE 'reminders_status%'
  ) THEN
    -- Loosen the check; tolerable since 'cancelled' is the only new value.
    NULL; -- handled below
  END IF;
END;
$$;

-- reminders.status was 'pending' / 'sent' / 'failed' (text + check from 00004).
-- Replace the check to include 'cancelled'.
ALTER TABLE reminders DROP CONSTRAINT IF EXISTS reminders_status_check;
ALTER TABLE reminders
  ADD CONSTRAINT reminders_status_check
  CHECK (status IN ('pending', 'sent', 'failed', 'cancelled'));
