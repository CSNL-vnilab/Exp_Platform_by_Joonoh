-- Patch book_slot: reject any slot whose start is in the past (or equals now).
-- Security reviewer caught this: the API happily confirmed a slot_start that
-- had already elapsed, producing bookings nobody could actually attend.

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
  v_experiment record;
  v_slot jsonb;
  v_existing_count integer;
  v_conflict_count integer;
  v_booking_ids uuid[] := '{}';
  v_booking_id uuid;
BEGIN
  -- 0. Reject any past-or-present slot up front. This runs before any other
  --    work so no lock is held and no side effects occur.
  FOR v_slot IN SELECT * FROM jsonb_array_elements(p_slots)
  LOOP
    IF (v_slot->>'slot_start')::timestamptz <= now() THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'PAST_SLOT',
        'slot_start', v_slot->>'slot_start'
      );
    END IF;
  END LOOP;

  -- 1. Validate experiment exists and is active
  SELECT * INTO v_experiment
  FROM experiments
  WHERE id = p_experiment_id AND status = 'active'
  FOR SHARE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'EXPERIMENT_NOT_FOUND');
  END IF;

  -- 2. Check duplicate participation (both single and multi session types)
  SELECT COUNT(*) INTO v_existing_count
  FROM bookings b
  JOIN participants p ON p.id = b.participant_id
  WHERE b.experiment_id = p_experiment_id
    AND b.status = 'confirmed'
    AND (p.phone = p_participant_phone OR p.email = p_participant_email);

  IF v_experiment.session_type = 'single' AND v_existing_count > 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'DUPLICATE_PARTICIPATION');
  END IF;

  IF v_experiment.session_type = 'multi' AND v_existing_count > 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'DUPLICATE_PARTICIPATION');
  END IF;

  IF v_experiment.session_type = 'multi' THEN
    IF jsonb_array_length(p_slots) != v_experiment.required_sessions THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'WRONG_SESSION_COUNT',
        'required', v_experiment.required_sessions,
        'provided', jsonb_array_length(p_slots)
      );
    END IF;
  END IF;

  IF NOT pg_try_advisory_xact_lock(hashtext(p_experiment_id::text)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'SLOT_CONTENTION_RETRY');
  END IF;

  FOR v_slot IN SELECT * FROM jsonb_array_elements(p_slots)
  LOOP
    SELECT COUNT(*) INTO v_conflict_count
    FROM bookings
    WHERE experiment_id = p_experiment_id
      AND status = 'confirmed'
      AND slot_start = (v_slot->>'slot_start')::timestamptz
      AND slot_end = (v_slot->>'slot_end')::timestamptz;

    IF v_conflict_count >= v_experiment.max_participants_per_slot THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'SLOT_ALREADY_TAKEN',
        'slot', v_slot
      );
    END IF;
  END LOOP;

  INSERT INTO participants (name, phone, email, gender, birthdate)
  VALUES (
    p_participant_name,
    p_participant_phone,
    p_participant_email,
    p_participant_gender,
    p_participant_birthdate
  )
  ON CONFLICT (phone, email)
  DO UPDATE SET
    name = participants.name
  RETURNING id INTO v_participant_id;

  v_booking_group_id := gen_random_uuid();

  FOR v_slot IN SELECT * FROM jsonb_array_elements(p_slots)
  LOOP
    INSERT INTO bookings (
      experiment_id, participant_id, slot_start, slot_end,
      session_number, booking_group_id, status
    ) VALUES (
      p_experiment_id,
      v_participant_id,
      (v_slot->>'slot_start')::timestamptz,
      (v_slot->>'slot_end')::timestamptz,
      COALESCE((v_slot->>'session_number')::integer, 1),
      v_booking_group_id,
      'confirmed'
    )
    RETURNING id INTO v_booking_id;

    v_booking_ids := v_booking_ids || v_booking_id;
  END LOOP;

  FOR v_slot IN SELECT * FROM jsonb_array_elements(p_slots)
  LOOP
    DECLARE
      v_day_before_at timestamptz;
      v_day_of_at timestamptz;
      v_slot_start_kst_time time;
    BEGIN
      v_day_before_at := (((v_slot->>'slot_start')::timestamptz AT TIME ZONE 'Asia/Seoul')::date - 1)
        + '18:00:00'::time AT TIME ZONE 'Asia/Seoul';
      v_day_of_at := ((v_slot->>'slot_start')::timestamptz AT TIME ZONE 'Asia/Seoul')::date
        + '09:00:00'::time AT TIME ZONE 'Asia/Seoul';
      v_slot_start_kst_time := ((v_slot->>'slot_start')::timestamptz AT TIME ZONE 'Asia/Seoul')::time;

      IF v_day_before_at > now() THEN
        INSERT INTO reminders (booking_id, reminder_type, scheduled_at, channel)
        SELECT b.id, 'day_before_evening', v_day_before_at, 'both'
        FROM bookings b
        WHERE b.experiment_id = p_experiment_id
          AND b.slot_start = (v_slot->>'slot_start')::timestamptz
          AND b.participant_id = v_participant_id
          AND b.booking_group_id = v_booking_group_id;
      END IF;

      IF v_day_of_at > now() AND v_slot_start_kst_time >= '10:00:00'::time THEN
        INSERT INTO reminders (booking_id, reminder_type, scheduled_at, channel)
        SELECT b.id, 'day_of_morning', v_day_of_at, 'both'
        FROM bookings b
        WHERE b.experiment_id = p_experiment_id
          AND b.slot_start = (v_slot->>'slot_start')::timestamptz
          AND b.participant_id = v_participant_id
          AND b.booking_group_id = v_booking_group_id;
      END IF;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'booking_ids', to_jsonb(v_booking_ids),
    'booking_group_id', v_booking_group_id,
    'participant_id', v_participant_id
  );

END;
$$;
