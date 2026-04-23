-- Extend get_researcher_pending_work() with per-type outbox counters
-- for gcal / email / sms retries. D6 follow-up.
--
-- Before this migration the dashboard tile set only covered
-- notion / notion_survey. Migration 00037 landed the generic retry
-- RPC; D6 service layer (commits 47e6312 / 05b6c7b) wired the
-- /api/cron/outbox-retry route for all four integration types. Without
-- matching dashboard counters, gcal/email/sms rows stuck in 'failed'
-- attempt<5 (actively retrying) or attempt>=5 (dead letter) are
-- invisible to the owning researcher.
--
-- Same name / same grants (authenticated + service_role). Return shape
-- is additive — existing clients keep working; the dashboard
-- PendingWorkCard reads the new keys with a default-0 fallback so the
-- UI survives pre-migration rollback.

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
  v_gcal_stuck integer;
  v_gcal_dead_letter integer;
  v_email_stuck integer;
  v_email_dead_letter integer;
  v_sms_stuck integer;
  v_sms_dead_letter integer;
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

  -- Notion (pre-existing)
  SELECT COUNT(*) INTO v_notion_stuck
  FROM booking_integrations i
  JOIN bookings b ON b.id = i.booking_id
  JOIN experiments e ON e.id = b.experiment_id
  WHERE e.created_by = v_caller
    AND i.integration_type IN ('notion', 'notion_survey')
    AND i.status = 'failed'
    AND i.attempts < 5;

  SELECT COUNT(*) INTO v_notion_dead_letter
  FROM booking_integrations i
  JOIN bookings b ON b.id = i.booking_id
  JOIN experiments e ON e.id = b.experiment_id
  WHERE e.created_by = v_caller
    AND i.integration_type IN ('notion', 'notion_survey')
    AND i.status = 'failed'
    AND i.attempts >= 5;

  -- GCal (D6 follow-up)
  SELECT COUNT(*) INTO v_gcal_stuck
  FROM booking_integrations i
  JOIN bookings b ON b.id = i.booking_id
  JOIN experiments e ON e.id = b.experiment_id
  WHERE e.created_by = v_caller
    AND i.integration_type = 'gcal'
    AND i.status = 'failed'
    AND i.attempts < 5;

  SELECT COUNT(*) INTO v_gcal_dead_letter
  FROM booking_integrations i
  JOIN bookings b ON b.id = i.booking_id
  JOIN experiments e ON e.id = b.experiment_id
  WHERE e.created_by = v_caller
    AND i.integration_type = 'gcal'
    AND i.status = 'failed'
    AND i.attempts >= 5;

  -- Email (D6 follow-up)
  SELECT COUNT(*) INTO v_email_stuck
  FROM booking_integrations i
  JOIN bookings b ON b.id = i.booking_id
  JOIN experiments e ON e.id = b.experiment_id
  WHERE e.created_by = v_caller
    AND i.integration_type = 'email'
    AND i.status = 'failed'
    AND i.attempts < 5;

  SELECT COUNT(*) INTO v_email_dead_letter
  FROM booking_integrations i
  JOIN bookings b ON b.id = i.booking_id
  JOIN experiments e ON e.id = b.experiment_id
  WHERE e.created_by = v_caller
    AND i.integration_type = 'email'
    AND i.status = 'failed'
    AND i.attempts >= 5;

  -- SMS (D6 follow-up)
  SELECT COUNT(*) INTO v_sms_stuck
  FROM booking_integrations i
  JOIN bookings b ON b.id = i.booking_id
  JOIN experiments e ON e.id = b.experiment_id
  WHERE e.created_by = v_caller
    AND i.integration_type = 'sms'
    AND i.status = 'failed'
    AND i.attempts < 5;

  SELECT COUNT(*) INTO v_sms_dead_letter
  FROM booking_integrations i
  JOIN bookings b ON b.id = i.booking_id
  JOIN experiments e ON e.id = b.experiment_id
  WHERE e.created_by = v_caller
    AND i.integration_type = 'sms'
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
    'gcal_stuck', v_gcal_stuck,
    'gcal_dead_letter', v_gcal_dead_letter,
    'email_stuck', v_email_stuck,
    'email_dead_letter', v_email_dead_letter,
    'sms_stuck', v_sms_stuck,
    'sms_dead_letter', v_sms_dead_letter,
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
