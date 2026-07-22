-- 00085 — cancel an entire experiment's bookings and reopen it for re-booking.
--
-- User need (2026-07): an experiment whose sessions were AUTO-completed by the
-- server (e.g. during app maintenance the researcher couldn't cancel in time)
-- must be fully reset — cancel EVERY booking (incl. completed/no_show) and
-- reopen the experiment so the participant can re-book from a clean slate,
-- with no leftover records blocking re-booking (the 00084 duplicate-gate +
-- recruitment fixes already ensure cancelled rows don't block; this RPC makes
-- the reset atomic).
--
-- Returns the google_event_ids of the bookings it cancelled so the calling
-- route can delete them from Google Calendar immediately (edit/cancel must
-- reflect on the calendar right away).
--
-- SAFETY: money-moved payment rows (claimed/submitted_to_admin/paid/
-- paid_offline) are LEFT ALONE — cancelling the booking must not un-record a
-- settled payment; only still-pending payment_info rows are swept to cancelled.
-- SECURITY DEFINER + REVOKE PUBLIC + GRANT service_role (the route enforces
-- owner-or-admin before calling via the service-role client).
--
-- Idempotent: CREATE OR REPLACE FUNCTION.

CREATE OR REPLACE FUNCTION cancel_experiment_and_reopen(
  p_experiment_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event_ids text[];
  v_booking_ids uuid[];
  v_cancelled_count integer := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_experiment_id::text));

  -- Snapshot the bookings we're about to cancel (for GCal cleanup + reminders).
  SELECT
    array_agg(id),
    array_remove(array_agg(google_event_id), NULL)
  INTO v_booking_ids, v_event_ids
  FROM bookings
  WHERE experiment_id = p_experiment_id
    AND status <> 'cancelled';

  IF v_booking_ids IS NULL THEN
    -- Nothing to cancel; still ensure the experiment is reopened.
    UPDATE experiments
      SET status = 'active', recruitment_auto_closed = false
      WHERE id = p_experiment_id AND status <> 'active';
    RETURN jsonb_build_object(
      'cancelled_count', 0,
      'google_event_ids', to_jsonb(ARRAY[]::text[])
    );
  END IF;

  UPDATE bookings
    SET status = 'cancelled',
        -- clear the event id since the route deletes the GCal events next.
        google_event_id = NULL
    WHERE id = ANY(v_booking_ids);
  GET DIAGNOSTICS v_cancelled_count = ROW_COUNT;

  -- Cancel any pending reminders for these bookings so the cron skips them.
  UPDATE reminders
    SET status = 'cancelled'
    WHERE booking_id = ANY(v_booking_ids)
      AND status = 'pending';

  -- Sweep still-pending settlement rows to cancelled (money-moved rows stay).
  UPDATE participant_payment_info pi
    SET status = 'cancelled'
    WHERE pi.booking_group_id IN (
      SELECT DISTINCT booking_group_id FROM bookings
      WHERE id = ANY(v_booking_ids) AND booking_group_id IS NOT NULL
    )
    AND pi.status = 'pending_participant';

  -- Reopen the experiment so participants can re-book a clean slate.
  UPDATE experiments
    SET status = 'active', recruitment_auto_closed = false
    WHERE id = p_experiment_id;

  RETURN jsonb_build_object(
    'cancelled_count', v_cancelled_count,
    'google_event_ids', to_jsonb(coalesce(v_event_ids, ARRAY[]::text[]))
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION cancel_experiment_and_reopen(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION cancel_experiment_and_reopen(uuid) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION cancel_experiment_and_reopen(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
