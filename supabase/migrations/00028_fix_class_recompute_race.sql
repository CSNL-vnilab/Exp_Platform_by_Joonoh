-- Harden participant_classes against concurrent writers.
--
-- Problem addressed: migration 00025 introduced
--   UNIQUE (participant_id, lab_id, valid_from) on participant_classes.
-- Two independent callers inserting at the same microsecond (auto trigger
-- firing from bookings.status='completed' UPDATE, or manual POST from
-- /api/participants/[id]/class racing the trigger) both compute
-- valid_from = now() which is fixed at transaction start. They collide on
-- the UNIQUE and one gets unique_violation — which for the auto path
-- aborts the bookings UPDATE that fired the trigger, losing the observation.
-- Path 2: two manual POSTs squeezing through the 60s rate-limit window.
--
-- Why the UNIQUE is dispensable: the primary key is `id uuid`, which already
-- guarantees row-level uniqueness. Two rows with identical
-- (participant_id, lab_id, valid_from) are **benign** — participant_class_current
-- uses DISTINCT ON ordered by valid_from DESC so a single winner is always
-- picked, and the rest are silently discarded. The historical audit trail
-- lives in participant_class_audit anyway.
--
-- Fix: (a) drop the UNIQUE. (b) also serialize recompute_participant_class
-- with a transaction-scoped advisory lock so concurrent trigger fires for
-- the same (participant, lab) don't race to decide newbie↔royal.
--
-- Reverting this migration re-introduces the UNIQUE and restores the racy
-- recompute function. Nothing else depends on it.

ALTER TABLE participant_classes
  DROP CONSTRAINT IF EXISTS participant_classes_participant_id_lab_id_valid_from_key;

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
  -- Serialize concurrent recomputes for the same (participant, lab).
  -- hashtextextended returns bigint, stable within a session.
  v_lock_key := hashtextextended(p_participant_id::text || '|' || p_lab_id::text, 0);
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- Re-read current class AFTER acquiring the lock so we see the winner's
  -- write if another transaction just inserted.
  SELECT class INTO v_current
  FROM participant_class_current
  WHERE participant_id = p_participant_id
    AND lab_id = p_lab_id;

  -- Manual sticky overrides: blacklist/vip persist until an admin changes them.
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
    -- ON CONFLICT DO NOTHING: if a second transaction inside the same
    -- microsecond somehow races past the advisory lock (shouldn't happen
    -- but defence-in-depth), we silently skip rather than abort the
    -- bookings UPDATE that fired us. The other transaction already wrote
    -- the equivalent row; nothing is lost.
    -- No ON CONFLICT needed: the UNIQUE was dropped above, and `id uuid`
    -- default-generates a fresh primary key per row.
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
