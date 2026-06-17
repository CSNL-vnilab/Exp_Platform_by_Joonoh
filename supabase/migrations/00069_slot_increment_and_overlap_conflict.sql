-- 00069: per-experiment slot increment + book_slot overlap-conflict.
--
-- slot_increment_minutes lets an experiment offer booking START times at a
-- finer granularity than its session length — e.g. 30-minute steps for a
-- 60-minute session, so a participant can pick 13:00 OR 13:30. NULL keeps
-- the legacy behaviour (grid increment = session_duration + break). Only the
-- slot GRID (src/lib/utils/slots.ts) reads this; book_slot just validates
-- whatever slots it is handed.
--
-- book_slot conflict check: was EXACT-match
--   (slot_start = X AND slot_end = Y)
-- which silently misses OVERLAPPING slots — a confirmed 13:00–14:00 booking
-- did NOT block a 13:30–14:30 request, so finer increments could double-book
-- the room. It now uses a time-OVERLAP test
--   (slot_start < requested_end AND slot_end > requested_start).
-- Backward-compatible: for experiments whose slots never overlap, the only
-- confirmed booking overlapping a requested slot is the one at the identical
-- time, so the counted value is unchanged.

-- IF NOT EXISTS added 2026-06-17: the prod migration ledger
-- (supabase_migrations.schema_migrations) is stuck at 00065, so a future
-- `supabase db push` re-attempts 00066-00077. This ADD COLUMN was the only
-- non-idempotent statement in that range; the guard makes the whole range
-- safe to re-run (every other migration already uses IF NOT EXISTS /
-- CREATE OR REPLACE / DROP IF EXISTS). Schema result is unchanged.
ALTER TABLE experiments
  ADD COLUMN IF NOT EXISTS slot_increment_minutes integer
    CHECK (slot_increment_minutes IS NULL OR slot_increment_minutes >= 5);

COMMENT ON COLUMN experiments.slot_increment_minutes IS
  '예약 그리드의 시작 시각 간격(분). NULL = 세션시간+휴식(기존). 세션보다 작으면 슬롯이 겹치며 book_slot이 시간 겹침으로 충돌을 검사한다.';

-- Rebuild book_slot. Body identical to 00062 except the slot-conflict check.
CREATE OR REPLACE FUNCTION book_slot(
  p_experiment_id uuid,
  p_participant_name text,
  p_participant_phone text,
  p_participant_email text,
  p_participant_gender text,
  p_participant_birthdate date,
  p_slots jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_participant_id uuid;
  v_booking_group_id uuid;
  v_experiment experiments;
  v_slot jsonb;
  v_existing_count integer;
  v_conflict_count integer;
  v_booking_ids uuid[] := '{}';
  v_booking_id uuid;
  v_next_sbj integer;
  v_total_confirmed integer;
  v_total_capacity integer;
  v_slot_dow integer;
  v_current_class participant_class;
  v_exclude_ids uuid[];
  v_excluded_count integer;
  v_recruited_count integer;
BEGIN
  FOR v_slot IN SELECT * FROM jsonb_array_elements(p_slots)
  LOOP
    IF (v_slot->>'slot_start')::timestamptz <= now() THEN
      RETURN jsonb_build_object('success', false, 'error', 'PAST_SLOT', 'slot_start', v_slot->>'slot_start');
    END IF;
  END LOOP;

  SELECT * INTO v_experiment FROM experiments WHERE id = p_experiment_id AND status = 'active' FOR SHARE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'EXPERIMENT_NOT_FOUND');
  END IF;

  IF v_experiment.registration_deadline IS NOT NULL AND v_experiment.registration_deadline <= now() THEN
    RETURN jsonb_build_object('success', false, 'error', 'REGISTRATION_CLOSED');
  END IF;

  FOR v_slot IN SELECT * FROM jsonb_array_elements(p_slots)
  LOOP
    v_slot_dow := EXTRACT(DOW FROM ((v_slot->>'slot_start')::timestamptz AT TIME ZONE 'Asia/Seoul'))::int;
    IF NOT (v_slot_dow = ANY(v_experiment.weekdays)) THEN
      RETURN jsonb_build_object('success', false, 'error', 'WEEKDAY_NOT_ALLOWED', 'slot_start', v_slot->>'slot_start');
    END IF;
  END LOOP;

  SELECT COUNT(*) INTO v_existing_count
  FROM bookings b
  JOIN participants p ON p.id = b.participant_id
  WHERE b.experiment_id = p_experiment_id
    AND b.status = 'confirmed'
    AND (p.phone = p_participant_phone OR p.email = p_participant_email);

  IF v_existing_count > 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'DUPLICATE_PARTICIPATION');
  END IF;

  IF v_experiment.recruitment_target IS NOT NULL THEN
    SELECT COUNT(DISTINCT b.participant_id) INTO v_recruited_count
    FROM bookings b
    WHERE b.experiment_id = p_experiment_id
      AND b.status IN ('confirmed', 'running', 'completed', 'no_show');
    IF v_recruited_count >= v_experiment.recruitment_target THEN
      UPDATE experiments SET status = 'completed' WHERE id = p_experiment_id AND status = 'active';
      RETURN jsonb_build_object('success', false, 'error', 'RECRUITMENT_FULL',
        'recruited', v_recruited_count, 'target', v_experiment.recruitment_target);
    END IF;
  END IF;

  IF v_experiment.session_type = 'multi' THEN
    IF jsonb_array_length(p_slots) != v_experiment.required_sessions THEN
      RETURN jsonb_build_object('success', false, 'error', 'WRONG_SESSION_COUNT',
        'required', v_experiment.required_sessions, 'provided', jsonb_array_length(p_slots));
    END IF;
  END IF;

  IF NOT pg_try_advisory_xact_lock(hashtext(p_experiment_id::text)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'SLOT_CONTENTION_RETRY');
  END IF;

  -- Time-OVERLAP conflict check (00069): a requested slot is taken when the
  -- number of CONFIRMED bookings whose interval overlaps it reaches the
  -- per-slot capacity. Replaces 00062's exact-match check so finer
  -- slot_increment_minutes (overlapping slots) cannot double-book.
  FOR v_slot IN SELECT * FROM jsonb_array_elements(p_slots)
  LOOP
    SELECT COUNT(*) INTO v_conflict_count
    FROM bookings
    WHERE experiment_id = p_experiment_id
      AND status = 'confirmed'
      AND slot_start < (v_slot->>'slot_end')::timestamptz
      AND slot_end > (v_slot->>'slot_start')::timestamptz;
    IF v_conflict_count >= v_experiment.max_participants_per_slot THEN
      RETURN jsonb_build_object('success', false, 'error', 'SLOT_ALREADY_TAKEN', 'slot', v_slot);
    END IF;
  END LOOP;

  INSERT INTO participants (name, phone, email, gender, birthdate)
  VALUES (p_participant_name, p_participant_phone, p_participant_email, p_participant_gender, p_participant_birthdate)
  ON CONFLICT (phone, email) DO UPDATE SET name = participants.name
  RETURNING id INTO v_participant_id;

  IF v_experiment.experiment_mode <> 'offline'
     AND v_experiment.online_runtime_config IS NOT NULL
     AND v_experiment.online_runtime_config ? 'exclude_experiment_ids'
     AND jsonb_typeof(v_experiment.online_runtime_config->'exclude_experiment_ids') = 'array' THEN
    BEGIN
      SELECT ARRAY(
        SELECT (value)::uuid
        FROM jsonb_array_elements_text(v_experiment.online_runtime_config->'exclude_experiment_ids')
        WHERE value ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      ) INTO v_exclude_ids;
    EXCEPTION WHEN OTHERS THEN
      v_exclude_ids := NULL;
    END;

    IF v_exclude_ids IS NOT NULL AND array_length(v_exclude_ids, 1) > 0 THEN
      SELECT COUNT(*) INTO v_excluded_count
      FROM bookings b
      WHERE b.participant_id = v_participant_id
        AND b.experiment_id = ANY(v_exclude_ids)
        AND b.status IN ('confirmed', 'running', 'completed', 'no_show');

      IF v_excluded_count > 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'EXPERIMENT_EXCLUDED');
      END IF;
    END IF;
  END IF;

  SELECT class INTO v_current_class
  FROM participant_class_current
  WHERE participant_id = v_participant_id
    AND lab_id = v_experiment.lab_id;

  IF v_current_class = 'blacklist' THEN
    RETURN jsonb_build_object('success', false, 'error', 'PARTICIPANT_BLACKLISTED');
  END IF;

  v_booking_group_id := gen_random_uuid();

  SELECT COALESCE(MAX(subject_number) + 1, v_experiment.subject_start_number) INTO v_next_sbj
  FROM bookings WHERE experiment_id = p_experiment_id;

  FOR v_slot IN SELECT * FROM jsonb_array_elements(p_slots)
  LOOP
    INSERT INTO bookings (
      experiment_id, participant_id, slot_start, slot_end,
      session_number, booking_group_id, status, subject_number
    ) VALUES (
      p_experiment_id, v_participant_id,
      (v_slot->>'slot_start')::timestamptz, (v_slot->>'slot_end')::timestamptz,
      COALESCE((v_slot->>'session_number')::integer, 1),
      v_booking_group_id, 'confirmed', v_next_sbj
    ) RETURNING id INTO v_booking_id;
    v_booking_ids := v_booking_ids || v_booking_id;
  END LOOP;

  FOR v_slot IN SELECT * FROM jsonb_array_elements(p_slots)
  LOOP
    DECLARE
      v_slot_start timestamptz := (v_slot->>'slot_start')::timestamptz;
      v_kst_date date := (v_slot_start AT TIME ZONE 'Asia/Seoul')::date;
      v_day_before_date date := v_kst_date - 1;
      v_day_before_at timestamptz;
      v_day_of_at timestamptz;
      v_slot_start_kst_time time := (v_slot_start AT TIME ZONE 'Asia/Seoul')::time;
    BEGIN
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

      IF v_experiment.reminder_day_before_enabled AND v_day_before_at > now() THEN
        INSERT INTO reminders (booking_id, reminder_type, scheduled_at, channel)
        SELECT b.id, 'day_before_evening', v_day_before_at, 'both'
        FROM bookings b
        WHERE b.experiment_id = p_experiment_id
          AND b.slot_start = v_slot_start
          AND b.participant_id = v_participant_id
          AND b.booking_group_id = v_booking_group_id;
      END IF;

      IF v_experiment.reminder_day_of_enabled
         AND v_day_of_at > now()
         AND v_day_of_at < v_slot_start
         AND v_experiment.reminder_day_of_time < v_slot_start_kst_time THEN
        INSERT INTO reminders (booking_id, reminder_type, scheduled_at, channel)
        SELECT b.id, 'day_of_morning', v_day_of_at, 'both'
        FROM bookings b
        WHERE b.experiment_id = p_experiment_id
          AND b.slot_start = v_slot_start
          AND b.participant_id = v_participant_id
          AND b.booking_group_id = v_booking_group_id;
      END IF;
    END;
  END LOOP;

  IF v_experiment.recruitment_target IS NOT NULL THEN
    SELECT COUNT(DISTINCT b.participant_id) INTO v_recruited_count
    FROM bookings b
    WHERE b.experiment_id = p_experiment_id
      AND b.status IN ('confirmed', 'running', 'completed', 'no_show');
    IF v_recruited_count >= v_experiment.recruitment_target THEN
      UPDATE experiments SET status = 'completed' WHERE id = p_experiment_id AND status = 'active';
    END IF;
  END IF;

  IF v_experiment.auto_lock THEN
    SELECT COUNT(*) INTO v_total_confirmed FROM bookings
    WHERE experiment_id = p_experiment_id AND status = 'confirmed';
    SELECT experiment_total_capacity(v_experiment) INTO v_total_capacity;
    IF v_total_capacity IS NOT NULL AND v_total_capacity > 0 AND v_total_confirmed >= v_total_capacity THEN
      UPDATE experiments SET status = 'completed' WHERE id = p_experiment_id;
    END IF;
  END IF;

  RETURN jsonb_build_object('success', true, 'booking_ids', to_jsonb(v_booking_ids),
    'booking_group_id', v_booking_group_id, 'participant_id', v_participant_id,
    'subject_number', v_next_sbj);
END;
$$;
