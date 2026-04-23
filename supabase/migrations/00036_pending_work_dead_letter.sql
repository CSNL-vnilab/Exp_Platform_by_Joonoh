-- Extend get_researcher_pending_work() to distinguish actively-retrying
-- from exhausted-retries outbox rows.
--
-- Previously `notion_stuck` counted `status='failed' AND attempts<5`
-- (still inside the retry window). Rows that hit attempts>=5 are
-- operationally different — the cron has given up; only a researcher
-- clicking "재발행" can move them. Surface them on the dashboard so they
-- don't rot invisibly.
--
-- Behaviour: same grants / same name / different return shape (added
-- key 'notion_dead_letter'). Additive so existing callers still work.

CREATE OR REPLACE FUNCTION get_researcher_pending_work()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_disabled boolean;
  v_obs_missing integer;
  v_notion_stuck integer;
  v_notion_dead_letter integer;
  v_royal_queue integer;
  v_auto_completed_7d integer;
  v_class_changes_7d jsonb;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('error', 'UNAUTHENTICATED');
  END IF;

  SELECT disabled INTO v_disabled FROM profiles WHERE id = v_caller;
  IF COALESCE(v_disabled, true) THEN
    RETURN jsonb_build_object('error', 'FORBIDDEN');
  END IF;

  SELECT COUNT(*) INTO v_obs_missing
  FROM bookings b
  JOIN experiments e ON e.id = b.experiment_id
  LEFT JOIN booking_observations o ON o.booking_id = b.id
  WHERE e.created_by = v_caller
    AND b.status IN ('confirmed', 'completed')
    AND b.slot_end < now()
    AND o.booking_id IS NULL;

  SELECT COUNT(*) INTO v_notion_stuck
  FROM booking_integrations i
  JOIN bookings b ON b.id = i.booking_id
  JOIN experiments e ON e.id = b.experiment_id
  WHERE e.created_by = v_caller
    AND i.integration_type IN ('notion', 'notion_survey')
    AND i.status = 'failed'
    AND i.attempts < 5;

  -- D2-4 addition: separate tile for exhausted retries.
  SELECT COUNT(*) INTO v_notion_dead_letter
  FROM booking_integrations i
  JOIN bookings b ON b.id = i.booking_id
  JOIN experiments e ON e.id = b.experiment_id
  WHERE e.created_by = v_caller
    AND i.integration_type IN ('notion', 'notion_survey')
    AND i.status = 'failed'
    AND i.attempts >= 5;

  SELECT COUNT(*) INTO v_royal_queue
  FROM (
    SELECT b.participant_id, e.lab_id
    FROM bookings b
    JOIN experiments e ON e.id = b.experiment_id
    WHERE b.status = 'completed'
      AND EXISTS (
        SELECT 1 FROM experiments e2
        WHERE e2.created_by = v_caller AND e2.lab_id = e.lab_id
        LIMIT 1
      )
    GROUP BY b.participant_id, e.lab_id
    HAVING COUNT(*) >= 15
       AND NOT EXISTS (
         SELECT 1 FROM participant_class_current pcc
         WHERE pcc.participant_id = b.participant_id
           AND pcc.lab_id = e.lab_id
           AND pcc.class IN ('royal', 'vip', 'blacklist')
       )
  ) s;

  SELECT COUNT(*) INTO v_auto_completed_7d
  FROM bookings b
  JOIN experiments e ON e.id = b.experiment_id
  WHERE e.created_by = v_caller
    AND b.auto_completed_at IS NOT NULL
    AND b.auto_completed_at > now() - interval '7 days';

  SELECT COALESCE(jsonb_agg(row_to_json(t.*)), '[]'::jsonb)
  INTO v_class_changes_7d
  FROM (
    SELECT a.participant_id, a.previous_class, a.new_class,
           a.changed_kind, a.created_at
    FROM participant_class_audit a
    WHERE a.created_at > now() - interval '7 days'
      AND EXISTS (
        SELECT 1 FROM experiments e
        WHERE e.created_by = v_caller AND e.lab_id = a.lab_id
        LIMIT 1
      )
    ORDER BY a.created_at DESC
    LIMIT 20
  ) t;

  RETURN jsonb_build_object(
    'obs_missing', v_obs_missing,
    'notion_stuck', v_notion_stuck,
    'notion_dead_letter', v_notion_dead_letter,
    'royal_queue', v_royal_queue,
    'auto_completed_7d', v_auto_completed_7d,
    'class_changes_7d', v_class_changes_7d
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION get_researcher_pending_work()
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_researcher_pending_work()
  TO authenticated, service_role;
