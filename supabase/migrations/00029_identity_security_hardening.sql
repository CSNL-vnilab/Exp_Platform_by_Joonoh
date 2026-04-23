-- Security hardening for the identity/class layer introduced in 00025.
--
-- Three fixes, bundled because they share the same threat model (a researcher
-- or admin with direct DB access bypassing application-layer guarantees):
--
-- 1. `labs.participant_id_salt` was readable by any authenticated user under
--    the "Authenticated read labs" RLS policy. The 00025 comment claimed
--    "we rely on column grants for the salt" but no GRANT/REVOKE was ever
--    issued. A researcher pulling the salt + the (phone, birthdate, name)
--    tuples already available under `participants` RLS can reconstruct every
--    HMAC and invert the pseudonymous public_code scheme. Fix: REVOKE SELECT
--    on the salt column from authenticated/anon (Supabase's "public" roles)
--    so only service_role can read it. RLS policy retains row-level reads of
--    `labs.code`/`labs.name`.
--
-- 2. `participant_class_audit` is only written by the Next.js route handler
--    in `/api/participants/[id]/class` (and by `recompute_participant_class`).
--    An admin writing to `participant_classes` directly via SQL editor OR the
--    service-role key bypasses the app handler and leaves the audit log
--    empty — unacceptable for IRB. Fix: a row-level trigger that mirrors
--    every INSERT on `participant_classes` into `participant_class_audit`.
--    Callers that already insert an audit row via the app layer will now
--    double-log; that's cheaper than the alternative. The recompute function
--    (00028) and the manual-class RPC (below) stop inserting audit rows
--    directly — the trigger handles it centrally.
--
-- 3. The manual class POST at `/api/participants/[id]/class` does a raw
--    INSERT and does NOT take the advisory lock that `recompute_participant_class`
--    now uses. Two concurrent writers (manual + auto) can insert rows with
--    identical `valid_from` at millisecond resolution; after 00028 dropped
--    the UNIQUE, the DISTINCT ON tiebreaker is physically-arbitrary and a
--    researcher's explicit uplift can silently lose to an auto newbie.
--    Fix: `assign_participant_class_manual()` RPC that takes the advisory
--    lock and writes a row whose `valid_from` is clock_timestamp() (not
--    transaction-start), with tie-break friendliness baked into the view by
--    ORDERing on `(valid_from DESC, assigned_kind ASC)` so 'manual' wins ties
--    against 'auto'. (ASC ordering works because 'auto' < 'manual' lexically.)
--
-- Reverting: restores salt readability (regression), re-opens the audit
-- bypass, and removes the manual RPC. Nothing downstream depends on the
-- trigger, so revert is safe.

-- ---------------------------------------------------------------------------
-- 1. Salt readability REVOKE.
-- ---------------------------------------------------------------------------
-- The Supabase schema grants SELECT on all columns to `authenticated` and
-- `anon` by default. We strip the salt column specifically.
REVOKE SELECT (participant_id_salt) ON labs FROM authenticated;
REVOKE SELECT (participant_id_salt) ON labs FROM anon;
-- service_role retains full access (it's what `createAdminClient()` uses).

-- ---------------------------------------------------------------------------
-- 2. participant_class_audit mirror trigger.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_participant_classes_to_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_previous participant_class;
BEGIN
  -- Latest prior non-expired row for this (participant, lab) becomes the
  -- "previous_class" in the audit record. Null on first-ever assignment.
  SELECT class INTO v_previous
  FROM participant_classes
  WHERE participant_id = NEW.participant_id
    AND lab_id = NEW.lab_id
    AND id <> NEW.id
    AND (valid_until IS NULL OR valid_until > now())
  ORDER BY valid_from DESC
  LIMIT 1;

  INSERT INTO participant_class_audit (
    participant_id,
    lab_id,
    previous_class,
    new_class,
    reason,
    completed_count,
    changed_by,
    changed_kind
  ) VALUES (
    NEW.participant_id,
    NEW.lab_id,
    v_previous,
    NEW.class,
    NEW.reason,
    NEW.completed_count,
    NEW.assigned_by,
    NEW.assigned_kind
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS participant_classes_to_audit ON participant_classes;
CREATE TRIGGER participant_classes_to_audit
  AFTER INSERT ON participant_classes
  FOR EACH ROW
  EXECUTE FUNCTION trg_participant_classes_to_audit();

-- ---------------------------------------------------------------------------
-- 3. Manual class assignment RPC (serialized via advisory lock).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assign_participant_class_manual(
  p_participant_id uuid,
  p_lab_id uuid,
  p_class participant_class,
  p_reason text,
  p_valid_until timestamptz,
  p_assigned_by uuid
) RETURNS participant_classes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lock_key bigint;
  v_current_count integer;
  v_inserted participant_classes;
BEGIN
  -- Match the lock key used by recompute_participant_class (migration 00028)
  -- so manual writers serialize against auto writers for the same
  -- (participant, lab) pair.
  v_lock_key := hashtextextended(
    p_participant_id::text || '|' || p_lab_id::text, 0
  );
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- Pull the most recent completed_count so the manual row carries context.
  SELECT COALESCE(completed_count, 0) INTO v_current_count
  FROM participant_classes
  WHERE participant_id = p_participant_id
    AND lab_id = p_lab_id
  ORDER BY valid_from DESC
  LIMIT 1;

  INSERT INTO participant_classes (
    participant_id, lab_id, class, reason,
    assigned_by, assigned_kind, completed_count,
    valid_from, valid_until
  ) VALUES (
    p_participant_id, p_lab_id, p_class, p_reason,
    p_assigned_by, 'manual',
    COALESCE(v_current_count, 0),
    clock_timestamp(),  -- clock_timestamp() advances even within the same tx
    p_valid_until
  )
  RETURNING * INTO v_inserted;

  RETURN v_inserted;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Redefine recompute_participant_class (last touched in 00028) to stop
--    double-logging audit rows — the new trigger above covers it.
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
  v_lock_key bigint;
BEGIN
  v_lock_key := hashtextextended(p_participant_id::text || '|' || p_lab_id::text, 0);
  PERFORM pg_advisory_xact_lock(v_lock_key);

  SELECT class INTO v_current
  FROM participant_class_current
  WHERE participant_id = p_participant_id
    AND lab_id = p_lab_id;

  IF v_current IN ('blacklist', 'vip') THEN
    RETURN v_current;
  END IF;

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

  IF v_current IS NULL OR v_current IS DISTINCT FROM v_new THEN
    -- Audit row is written centrally by the AFTER INSERT trigger above;
    -- no explicit INSERT INTO participant_class_audit here.
    INSERT INTO participant_classes (
      participant_id, lab_id, class, reason,
      assigned_kind, completed_count, valid_from
    ) VALUES (
      p_participant_id, p_lab_id, v_new,
      'auto: completed_count=' || v_count::text,
      'auto', v_count, clock_timestamp()
    );
  END IF;

  RETURN v_new;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Rebuild participant_class_current so manual writes win identical-
--    valid_from ties against auto writes.
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
-- Tiebreak: identical valid_from → manual wins over auto ('manual' > 'auto'
-- lexicographically, so DESC order puts 'manual' first).
ORDER BY pc.participant_id, pc.lab_id, pc.valid_from DESC, pc.assigned_kind DESC;
