-- Researcher-set recruitment quota (모집 인원) + auto-close on quota hit.
--
-- Why: `experiments.auto_lock` already flips status to 'completed' when
-- every slot-seat is booked, but that "capacity" is the theoretical max
-- — for a long-running offline study (e.g. TimeExp1 spans 102 days × 6
-- weekdays × 5 slots/day × 1/slot ≈ 500+ seats) it never realistically
-- triggers. Researchers want a *target* like "I want 30 participants",
-- and the system should auto-close on hitting that count regardless of
-- how many slot-seats remain empty.
--
-- Counted as: distinct participant_id with bookings in any "engaged"
-- status — the same set used by the cross-study exclusion check
-- (confirmed / running / completed / no_show). Cancellations free a
-- recruitment slot back up.

ALTER TABLE experiments
  ADD COLUMN recruitment_target integer
    CHECK (recruitment_target IS NULL OR recruitment_target > 0);

COMMENT ON COLUMN experiments.recruitment_target IS
  '모집 인원 (researcher-set). NULL = unlimited (legacy + opt-in). When set, book_slot rejects new participants once distinct-participant count reaches this number and flips status to completed (auto-close).';

-- Rebuild book_slot to enforce the quota. Body is identical to 00045
-- except for a new gate inserted right after the blacklist check.

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
  -- 00062 additions:
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

  -- 00062: recruitment quota gate. Fast-path BEFORE the participant
  -- upsert + slot conflict checks — once the cohort is full, no point
  -- doing more work. Atomicity is preserved by the FOR SHARE row lock
  -- taken on `v_experiment` above plus the advisory_xact_lock below;
  -- the count we read here is consistent with what other concurrent
  -- book_slot calls see.
  IF v_experiment.recruitment_target IS NOT NULL THEN
    SELECT COUNT(DISTINCT b.participant_id) INTO v_recruited_count
    FROM bookings b
    WHERE b.experiment_id = p_experiment_id
      AND b.status IN ('confirmed', 'running', 'completed', 'no_show');
    IF v_recruited_count >= v_experiment.recruitment_target THEN
      -- Defensive auto-close — if another path is somehow accepting
      -- bookings past the quota, the next booking attempt will flip the
      -- status here.
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

  FOR v_slot IN SELECT * FROM jsonb_array_elements(p_slots)
  LOOP
    SELECT COUNT(*) INTO v_conflict_count
    FROM bookings
    WHERE experiment_id = p_experiment_id
      AND status = 'confirmed'
      AND slot_start = (v_slot->>'slot_start')::timestamptz
      AND slot_end = (v_slot->>'slot_end')::timestamptz;
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

  -- 00062: also auto-close when the booking that JUST committed brought
  -- the cohort up to recruitment_target. Slot-capacity auto-close
  -- (auto_lock) below still applies independently.
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
