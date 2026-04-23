-- Extend the integration_type enum for per-booking Notion syncs (experiment
-- log + survey rows) and add an auto-completion grace path for bookings
-- whose post-survey never arrived.
--
-- Invariant: once a booking's slot_end has passed by `p_grace_days`, the
-- booking is conservatively marked 'completed' with `auto_completed_at` set
-- so reporting can distinguish researcher-confirmed completions from
-- janitorial ones. Status transition still fires the class-recompute trigger
-- from 00025.
--
-- Reverting this migration:
--   * drops `auto_completed_at` from `bookings`
--   * drops `auto_complete_stale_bookings()`
--   * leaves the two new enum values in place (Postgres does not support
--     removing an enum value without recreating the type; manual cleanup is
--     required if a true revert is needed)
-- Any cron/worker that depends on these hooks will break.

-- ---------------------------------------------------------------------------
-- ALTER TYPE ... ADD VALUE is allowed inside a transaction from PG 12+.
-- Restriction: the new value can't be *used* in the same transaction. This
-- migration only adds the enum values; the code that writes them as
-- integration_type values runs in later transactions. IF NOT EXISTS so
-- re-apply is a no-op.
-- ---------------------------------------------------------------------------
ALTER TYPE integration_type ADD VALUE IF NOT EXISTS 'notion_experiment';
ALTER TYPE integration_type ADD VALUE IF NOT EXISTS 'notion_survey';

-- ---------------------------------------------------------------------------
-- bookings.auto_completed_at
-- ---------------------------------------------------------------------------
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS auto_completed_at timestamptz;

-- ---------------------------------------------------------------------------
-- auto_complete_stale_bookings()
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auto_complete_stale_bookings(
  p_grace_days integer DEFAULT 7
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  WITH updated AS (
    UPDATE bookings
    SET status = 'completed',
        auto_completed_at = now()
    WHERE status = 'confirmed'
      AND slot_end + make_interval(days => p_grace_days) < now()
    RETURNING id
  )
  SELECT COUNT(*) INTO v_count FROM updated;

  RETURN COALESCE(v_count, 0);
END;
$$;
