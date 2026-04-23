-- Participant identity + classification layer.
--
-- Invariant: every experiment belongs to exactly one lab, and a participant's
-- external-facing identity (`public_code`) and HMAC-based deduplication key
-- (`identity_hmac`) are scoped to that lab. Classes (newbie / royal /
-- blacklist / vip) are also lab-scoped, derived from bookings with
-- status='completed' on experiments belonging to the same lab.
--
-- Reverting this migration drops:
--   * `labs` table (and the `experiments.lab_id` FK column)
--   * `participant_lab_identity` rows (lab-scoped public codes / HMACs)
--   * `participant_class` enum, `participant_classes` table + audit + view
--   * `recompute_participant_class()` function and the `bookings` trigger
--   * the blacklist check inside `book_slot`
-- Any UI/API code relying on public codes, class badges, or the
-- PARTICIPANT_BLACKLISTED booking error will break.

-- ---------------------------------------------------------------------------
-- 1. labs
-- ---------------------------------------------------------------------------
CREATE TABLE labs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  participant_id_salt bytea NOT NULL DEFAULT gen_random_bytes(32),
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO labs (code, name)
VALUES ('CSNL', 'Cognitive Systems & Neuroimaging Lab');

ALTER TABLE labs ENABLE ROW LEVEL SECURITY;

-- Any authenticated user can read lab metadata (code/name); the salt is
-- sensitive but RLS only controls row visibility — we rely on column grants
-- for the salt. For now keep it single-tenant and allow authenticated reads.
CREATE POLICY "Authenticated read labs"
  ON labs FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Admins manage labs"
  ON labs FOR ALL
  USING (is_admin(auth.uid()))
  WITH CHECK (is_admin(auth.uid()));

-- ---------------------------------------------------------------------------
-- 2. experiments.lab_id
-- ---------------------------------------------------------------------------
ALTER TABLE experiments
  ADD COLUMN lab_id uuid REFERENCES labs(id);

UPDATE experiments
SET lab_id = (SELECT id FROM labs WHERE code = 'CSNL')
WHERE lab_id IS NULL;

ALTER TABLE experiments
  ALTER COLUMN lab_id SET NOT NULL;

CREATE INDEX idx_experiments_lab_id ON experiments (lab_id);

-- ---------------------------------------------------------------------------
-- 3. participant_lab_identity
-- ---------------------------------------------------------------------------
CREATE TABLE participant_lab_identity (
  participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  lab_id uuid NOT NULL REFERENCES labs(id) ON DELETE RESTRICT,
  public_code text NOT NULL,
  identity_hmac bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (participant_id, lab_id),
  UNIQUE (lab_id, public_code),
  UNIQUE (lab_id, identity_hmac)
);

CREATE INDEX idx_pli_lab_hmac
  ON participant_lab_identity (lab_id, identity_hmac);

ALTER TABLE participant_lab_identity ENABLE ROW LEVEL SECURITY;

-- Researchers and admins of the lab can read lab-scoped identities.
CREATE POLICY "Researchers read lab identities"
  ON participant_lab_identity FOR SELECT
  USING (
    is_admin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid()
        AND p.disabled = false
        AND p.role IN ('admin', 'researcher')
    )
  );

CREATE POLICY "Admins manage lab identities"
  ON participant_lab_identity FOR ALL
  USING (is_admin(auth.uid()))
  WITH CHECK (is_admin(auth.uid()));

-- ---------------------------------------------------------------------------
-- 4. participant_class enum and participant_classes table
-- ---------------------------------------------------------------------------
CREATE TYPE participant_class AS ENUM ('newbie', 'royal', 'blacklist', 'vip');

CREATE TABLE participant_classes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  lab_id uuid NOT NULL REFERENCES labs(id) ON DELETE RESTRICT,
  class participant_class NOT NULL,
  reason text,
  assigned_by uuid REFERENCES auth.users(id),
  assigned_kind text NOT NULL DEFAULT 'auto'
    CHECK (assigned_kind IN ('auto', 'manual')),
  completed_count integer NOT NULL DEFAULT 0,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (participant_id, lab_id, valid_from)
);

CREATE INDEX idx_participant_classes_lookup
  ON participant_classes (participant_id, lab_id, valid_from DESC);

ALTER TABLE participant_classes ENABLE ROW LEVEL SECURITY;

-- Assumption (single-tenant CSNL):
--   * Any authenticated researcher or admin can READ any participant_classes
--     row. (All current researchers belong to CSNL.)
--   * WRITES (INSERT / UPDATE / DELETE) are restricted to admins; the
--     recompute_participant_class() function runs SECURITY DEFINER so
--     automated class transitions bypass these checks cleanly.
--   * When we go multi-tenant, replace these with per-lab membership checks.
CREATE POLICY "Researchers read participant classes"
  ON participant_classes FOR SELECT
  USING (
    is_admin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid()
        AND p.disabled = false
        AND p.role IN ('admin', 'researcher')
    )
  );

CREATE POLICY "Admins write participant classes"
  ON participant_classes FOR INSERT
  WITH CHECK (is_admin(auth.uid()));

CREATE POLICY "Admins update participant classes"
  ON participant_classes FOR UPDATE
  USING (is_admin(auth.uid()))
  WITH CHECK (is_admin(auth.uid()));

CREATE POLICY "Admins delete participant classes"
  ON participant_classes FOR DELETE
  USING (is_admin(auth.uid()));

-- ---------------------------------------------------------------------------
-- 5. participant_class_current view — latest non-expired class per
--    (participant, lab).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW participant_class_current AS
SELECT DISTINCT ON (pc.participant_id, pc.lab_id)
  pc.id,
  pc.participant_id,
  pc.lab_id,
  pc.class,
  pc.reason,
  pc.assigned_by,
  pc.assigned_kind,
  pc.completed_count,
  pc.valid_from,
  pc.valid_until,
  pc.created_at
FROM participant_classes pc
WHERE pc.valid_until IS NULL OR pc.valid_until > now()
ORDER BY pc.participant_id, pc.lab_id, pc.valid_from DESC;

-- ---------------------------------------------------------------------------
-- 6. participant_class_audit — append-only transition log.
-- ---------------------------------------------------------------------------
CREATE TABLE participant_class_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  lab_id uuid NOT NULL REFERENCES labs(id) ON DELETE RESTRICT,
  previous_class participant_class,
  new_class participant_class NOT NULL,
  reason text,
  completed_count integer,
  changed_by uuid REFERENCES auth.users(id),
  changed_kind text NOT NULL DEFAULT 'auto'
    CHECK (changed_kind IN ('auto', 'manual')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_participant_class_audit_lookup
  ON participant_class_audit (participant_id, lab_id, created_at DESC);

ALTER TABLE participant_class_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Researchers read class audit"
  ON participant_class_audit FOR SELECT
  USING (
    is_admin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid()
        AND p.disabled = false
        AND p.role IN ('admin', 'researcher')
    )
  );

-- Writes are service-role / SECURITY DEFINER only.

-- ---------------------------------------------------------------------------
-- 7. recompute_participant_class function
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION recompute_participant_class(
  p_participant_id uuid,
  p_lab_id uuid
) RETURNS participant_class
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current participant_class;
  v_new participant_class;
  v_count integer;
BEGIN
  -- Current effective class for this (participant, lab).
  SELECT class INTO v_current
  FROM participant_class_current
  WHERE participant_id = p_participant_id
    AND lab_id = p_lab_id;

  -- Manual sticky overrides: blacklist/vip persist until an admin changes them.
  IF v_current IN ('blacklist', 'vip') THEN
    RETURN v_current;
  END IF;

  -- Count completed bookings scoped to the lab.
  SELECT COUNT(*) INTO v_count
  FROM bookings b
  JOIN experiments e ON e.id = b.experiment_id
  WHERE b.participant_id = p_participant_id
    AND e.lab_id = p_lab_id
    AND b.status = 'completed';

  IF v_count >= 15 THEN
    v_new := 'royal';
  ELSE
    v_new := 'newbie';
  END IF;

  -- Only log / insert when the class actually changes (or when there's
  -- no current row yet).
  IF v_current IS NULL OR v_current IS DISTINCT FROM v_new THEN
    INSERT INTO participant_classes (
      participant_id, lab_id, class, reason,
      assigned_kind, completed_count, valid_from
    ) VALUES (
      p_participant_id, p_lab_id, v_new,
      'auto: completed_count=' || v_count::text,
      'auto', v_count, now()
    );

    INSERT INTO participant_class_audit (
      participant_id, lab_id, previous_class, new_class,
      reason, completed_count, changed_kind
    ) VALUES (
      p_participant_id, p_lab_id, v_current, v_new,
      'auto recompute', v_count, 'auto'
    );
  END IF;

  RETURN v_new;
END;
$$;

-- ---------------------------------------------------------------------------
-- 8. Trigger: fire recompute when a booking transitions to 'completed'.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_recompute_class_on_booking_complete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lab_id uuid;
BEGIN
  IF NEW.status = 'completed'
     AND (OLD.status IS DISTINCT FROM 'completed') THEN
    SELECT lab_id INTO v_lab_id
    FROM experiments
    WHERE id = NEW.experiment_id;

    IF v_lab_id IS NOT NULL THEN
      PERFORM recompute_participant_class(NEW.participant_id, v_lab_id);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bookings_recompute_class ON bookings;
CREATE TRIGGER bookings_recompute_class
  AFTER UPDATE OF status ON bookings
  FOR EACH ROW
  EXECUTE FUNCTION trg_recompute_class_on_booking_complete();

-- ---------------------------------------------------------------------------
-- 9. PATCH book_slot: add blacklist check after participant upsert.
--    The rest of the body is copied verbatim from 00021.
-- ---------------------------------------------------------------------------
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

  -- Blacklist check (PATCH 00025): block bookings for participants whose
  -- current class in the experiment's lab is 'blacklist'.
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

  -- Reminders — build timestamptz via make_timestamptz to avoid AT TIME ZONE
  -- operator precedence pitfalls.
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
