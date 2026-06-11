-- Reminder robustness — 임무 S2 (블라인드 리뷰 [30] + [20]).
--
-- 왜 (두 결함):
--
--   [30] reminder.service 실패 경로에 재시도가 없다. 디스패처는 행을
--        pending→sent 로 CAS 선점한 뒤 발송한다. 발송이 일시적
--        SMTP/SMS 장애로 throw 하면 catch 가 status='failed' 로 종결해
--        버려 — 한 번의 일시 장애로 리마인더가 영구 유실된다. 재시도
--        횟수를 셀 컬럼이 없어 "한 번 더 시도"와 "영구 포기"를 구분할
--        수 없다. → reminders.attempts 컬럼 추가. (서비스 측 정책:
--        부분실패(이메일 성공 후 SMS 실패)는 재시도 금지로 종결,
--        완전실패만 attempts<3 동안 pending 으로 되돌려 다음 cron 이
--        재claim 하게 한다.)
--
--   [20] reschedule_reminders(00054) 는 status='pending' 리마인더만
--        갱신한다. 이미 day-before 리마인더가 발송(status='sent')된
--        booking 을 더 미래 날짜로 reschedule 하면, 갱신할 pending 행이
--        없어 UPDATE 가 0건을 건드리고 — 참여자는 새 날짜에 대한
--        리마인더를 한 통도 못 받는다(리마인더 공백). → 해당 booking·
--        type 에 pending 리마인더가 하나도 없고 새 슬롯 기준 발송시각이
--        아직 미래면 reminder 행을 새로 INSERT 하도록 확장.
--
-- 적용: 메인 세션이 검토 후 prod 에 적용한다 (이 세션은 작성만).

-- ── (a) attempts 컬럼 ───────────────────────────────────────────────────
-- 멱등 ADD. DEFAULT 0 → 기존 행/신규 행 모두 0 에서 시작.
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;

-- ── (b) reschedule_reminders 재정의 ([20]) ──────────────────────────────
--
-- 00054 대비 변경점:
--   - pending 리마인더 갱신/취소-아웃 로직은 그대로 유지.
--   - 각 reminder_type 에 대해, 새 슬롯 기준 발송시각이 미래이고 해당
--     설정이 켜져 있는데도 그 type 의 pending 리마인더가 하나도 없으면
--     reminder 행을 새로 INSERT (공백 방지). NOT EXISTS 가드로 멱등 —
--     반복 reschedule 이 pending 행을 중복 적재하지 않는다. 이미
--     발송된(sent) 옛 날짜 행은 그대로 두고 새 날짜용 pending 만 추가.
--   - channel 은 book_slot 시드와 동일하게 'both' 로 INSERT (재시드
--     시점에 원래 channel 을 알 수 없으므로 초기 시드 규약을 따른다).
--   - scheduled_at 계산식은 00054 의 수식을 그대로 재사용.
--   - 시그니처 + REVOKE/GRANT 는 00054 와 동일하게 재선언.

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
  v_inserted integer := 0;
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
    GET DIAGNOSTICS v_tmp = ROW_COUNT;
    v_updated := v_updated + v_tmp;

    -- Gap-fill ([20]): the reschedule pushed the slot to a NEW future
    -- date, but the day-before reminder for the OLD date was already
    -- sent (or otherwise not pending), so the UPDATE above touched
    -- nothing and the participant would get no day-before reminder for
    -- the new date. Re-seed one when no pending row remains. NOT EXISTS
    -- guards idempotency (repeat reschedules don't pile up duplicates).
    INSERT INTO reminders (booking_id, reminder_type, scheduled_at, channel)
    SELECT p_booking_id, 'day_before_evening', v_day_before_at, 'both'
    WHERE NOT EXISTS (
      SELECT 1 FROM reminders
       WHERE booking_id = p_booking_id
         AND reminder_type = 'day_before_evening'
         AND status = 'pending'
    );
    GET DIAGNOSTICS v_tmp = ROW_COUNT;
    v_inserted := v_inserted + v_tmp;
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

    -- Gap-fill ([20]) — same rationale as day_before above.
    INSERT INTO reminders (booking_id, reminder_type, scheduled_at, channel)
    SELECT p_booking_id, 'day_of_morning', v_day_of_at, 'both'
    WHERE NOT EXISTS (
      SELECT 1 FROM reminders
       WHERE booking_id = p_booking_id
         AND reminder_type = 'day_of_morning'
         AND status = 'pending'
    );
    GET DIAGNOSTICS v_tmp = ROW_COUNT;
    v_inserted := v_inserted + v_tmp;
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
    'cancelled', v_cancelled,
    'inserted', v_inserted
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION reschedule_reminders(uuid, timestamptz, timestamptz) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION reschedule_reminders(uuid, timestamptz, timestamptz) TO authenticated, service_role;
