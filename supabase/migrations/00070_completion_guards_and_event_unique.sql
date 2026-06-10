-- 00070: completion-path guards from the 2026-06-10 blind design review
-- (예약→완료→정보입력→청구 flow, 6-lens adversarial review).
--
-- Three independent hardenings, one migration:
--
--   [2]  mark_group_completed gains a slot_end < now() guard. The
--        payment-panel "회차 완료 처리" button flipped FUTURE sessions
--        to 'completed' too: the slot silently freed for double-booking
--        (book_slot counts only live statuses) while reminders kept
--        firing for a "completed" future session. Past-only matches the
--        status-PUT sibling sweep's semantics; future sessions stay
--        'confirmed' until they actually happen (or are cancelled).
--
--   [1]  auto_complete_stale_bookings also sweeps 'running'. A
--        completion-code run that was never verified stayed 'running'
--        forever — no janitorial path touched it, so the group never
--        reached payment readiness and the participant was never paid.
--        Same grace window as confirmed: slot_end + p_grace_days.
--
--   [24] bookings.google_event_id becomes UNIQUE (partial). Import
--        idempotency relied on a read-once in-memory snapshot of
--        existing event ids; two concurrent importer runs could both
--        miss each other's inserts and double-import the same calendar
--        event. Verified 0 duplicates in prod before this migration
--        (159 non-null ids, all distinct). Replaces 00068's non-unique
--        partial index — same predicate, so all 00068 call sites keep
--        their index scan.

-- [2] ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION mark_group_completed(p_booking_group_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_is_admin boolean := false;
  v_owner uuid;
  v_updated integer := 0;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED';
  END IF;

  SELECT is_admin(v_caller) INTO v_is_admin;

  SELECT e.created_by
    INTO v_owner
    FROM bookings b
    JOIN experiments e ON e.id = b.experiment_id
   WHERE b.booking_group_id = p_booking_group_id
   LIMIT 1;

  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND';
  END IF;
  IF NOT v_is_admin AND v_owner <> v_caller THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;

  -- Past-only (00070): never auto-attest a session that hasn't
  -- happened yet. Future confirmed/running rows are left untouched —
  -- the group simply isn't payment-ready until they conclude.
  UPDATE bookings
     SET status = 'completed'
   WHERE booking_group_id = p_booking_group_id
     AND status IN ('confirmed', 'running')
     AND slot_end < now();
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  RETURN jsonb_build_object('success', true, 'updated', v_updated);
END;
$$;

REVOKE EXECUTE ON FUNCTION mark_group_completed(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION mark_group_completed(uuid) TO authenticated;

-- [1] ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION auto_complete_stale_bookings(p_grace_days integer DEFAULT 7)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count integer;
BEGIN
  -- 00070: 'running' included. An online run whose completion code was
  -- never verified used to wedge at 'running' with no janitorial exit;
  -- after the same grace as confirmed rows it now conservatively
  -- completes (auto_completed_at distinguishes attested vs auto).
  UPDATE bookings
     SET status = 'completed',
         auto_completed_at = now()
   WHERE status IN ('confirmed', 'running')
     AND slot_end + make_interval(days => p_grace_days) < now();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION auto_complete_stale_bookings(integer) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION auto_complete_stale_bookings(integer) TO service_role;

-- [24] ──────────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS idx_bookings_google_event_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_google_event_id
  ON bookings (google_event_id)
  WHERE google_event_id IS NOT NULL;
