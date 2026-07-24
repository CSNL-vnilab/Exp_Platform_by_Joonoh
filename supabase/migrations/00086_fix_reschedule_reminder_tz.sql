-- 00086 — fix reschedule_reminders KST timezone math.
--
-- Bug (found 2026-07-24 while backfilling a rescheduled participant): the
-- reschedule path computed reminder times with
--
--   v_day_before_at := ((p_new_slot_start AT TIME ZONE 'Asia/Seoul')::date - 1)
--     + v_experiment.reminder_day_before_time AT TIME ZONE 'Asia/Seoul';
--
-- Operator precedence makes `AT TIME ZONE` bind to the bare `time` FIRST,
-- so `reminder_day_before_time AT TIME ZONE 'Asia/Seoul'` produces a
-- time-with-zone that, added to the date, yields the WRONG instant. For an
-- 18:00 KST day-before reminder on a 15:00 KST session this produced
-- 03:00 KST (~36h early); and because the buggy day_of value landed AFTER
-- the slot start, the `v_day_of_at < p_new_slot_start` guard sent the
-- day-of branch to its ELSE and NO day-of-morning reminder was seeded.
--
-- Net effect: every rescheduled (or revived cancelled/no_show) booking got a
-- mis-timed day-before reminder and lost its day-of reminder entirely.
--
-- Fix: build the KST wall-clock instant with make_timestamptz(...) — the
-- exact form book_slot (00069) uses for the initial seed — so the reschedule
-- path and the initial-booking path compute identical reminder times.
--
-- Only the KST-math lines change; the update / gap-fill / cancel branches are
-- copied verbatim from 00071. Idempotent (CREATE OR REPLACE).

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
  v_kst_date date;
  v_day_before_date date;
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

  -- KST math via make_timestamptz — mirrors book_slot (00069) EXACTLY so the
  -- reschedule seed matches the initial seed (previously diverged; see header).
  v_kst_date := (p_new_slot_start AT TIME ZONE 'Asia/Seoul')::date;
  v_day_before_date := v_kst_date - 1;
  v_slot_start_kst_time := (p_new_slot_start AT TIME ZONE 'Asia/Seoul')::time;

  v_day_before_at := make_timestamptz(
    EXTRACT(YEAR FROM v_day_before_date)::int,
    EXTRACT(MONTH FROM v_day_before_date)::int,
    EXTRACT(DAY FROM v_day_before_date)::int,
    EXTRACT(HOUR FROM v_experiment.reminder_day_before_time)::int,
    EXTRACT(MINUTE FROM v_experiment.reminder_day_before_time)::int,
    0,
    'Asia/Seoul'
  );
  v_day_of_at := make_timestamptz(
    EXTRACT(YEAR FROM v_kst_date)::int,
    EXTRACT(MONTH FROM v_kst_date)::int,
    EXTRACT(DAY FROM v_kst_date)::int,
    EXTRACT(HOUR FROM v_experiment.reminder_day_of_time)::int,
    EXTRACT(MINUTE FROM v_experiment.reminder_day_of_time)::int,
    0,
    'Asia/Seoul'
  );

  -- ── day_before_evening ─────────────────────────────────────────────
  IF v_experiment.reminder_day_before_enabled AND v_day_before_at > now() THEN
    UPDATE reminders
       SET scheduled_at = v_day_before_at
     WHERE booking_id = p_booking_id
       AND reminder_type = 'day_before_evening'
       AND status = 'pending';
    GET DIAGNOSTICS v_tmp = ROW_COUNT;
    v_updated := v_updated + v_tmp;

    -- Gap-fill: re-seed when no pending row remains (old date's already sent).
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

NOTIFY pgrst, 'reload schema';
