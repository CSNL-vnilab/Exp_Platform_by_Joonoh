-- Hardening fixes for get_researcher_pending_work (migration 00034).
--
-- Reviewer findings addressed:
--   D2-1 (CRITICAL IDOR) — 00034 created a SECURITY DEFINER function
--       without REVOKE EXECUTE FROM PUBLIC. Default Postgres grants
--       EXECUTE to PUBLIC, so any authenticated user could call it
--       with any p_user_id and read pending-work counts + cross-lab
--       participant_ids from participant_class_audit. Fix: (1) remove
--       the p_user_id argument entirely — the function now uses
--       auth.uid() internally, (2) REVOKE EXECUTE FROM PUBLIC/anon/
--       authenticated and GRANT only to authenticated + service_role
--       so the caller must at least be logged in, (3) add a disabled
--       guard.
--
--   D2-2 (CRITICAL) — royal_queue used SELECT ... INTO scalar on a
--       result set. plpgsql coerces to the first row, so the widget
--       returned 0 or 1 regardless of how many participants qualified.
--       Fix: wrap as subquery then COUNT(*).
--
--   D2-3 (HIGH) — royal_queue counted only bookings on experiments the
--       caller owns. Participants with >=15 total completed bookings
--       in the lab across MULTIPLE researchers were missed. Fix:
--       widen the inner aggregation to all completed bookings in the
--       caller's lab, then use created_by as a filter on which labs
--       the caller sees.
--
--   B-1 (HIGH, IDOR compound) — class_changes_7d EXISTS predicate
--       used p_user_id. Fixed by (1) above: now scopes to auth.uid()'s
--       labs.

DROP FUNCTION IF EXISTS get_researcher_pending_work(uuid);

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
  v_royal_queue integer;
  v_auto_completed_7d integer;
  v_class_changes_7d jsonb;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('error', 'UNAUTHENTICATED');
  END IF;

  -- Disabled users get nothing.
  SELECT disabled INTO v_disabled FROM profiles WHERE id = v_caller;
  IF COALESCE(v_disabled, true) THEN
    RETURN jsonb_build_object('error', 'FORBIDDEN');
  END IF;

  -- 관찰 미입력.
  SELECT COUNT(*) INTO v_obs_missing
  FROM bookings b
  JOIN experiments e ON e.id = b.experiment_id
  LEFT JOIN booking_observations o ON o.booking_id = b.id
  WHERE e.created_by = v_caller
    AND b.status IN ('confirmed', 'completed')
    AND b.slot_end < now()
    AND o.booking_id IS NULL;

  -- Notion 미동기화.
  SELECT COUNT(*) INTO v_notion_stuck
  FROM booking_integrations i
  JOIN bookings b ON b.id = i.booking_id
  JOIN experiments e ON e.id = b.experiment_id
  WHERE e.created_by = v_caller
    AND i.integration_type IN ('notion', 'notion_survey')
    AND i.status = 'failed'
    AND i.attempts < 5;

  -- Royal 승급 대기: rewritten per D2-2 + D2-3.
  -- Widen inner count to ALL completed bookings in the lab (not just
  -- the caller's experiments). Caller-visibility restricted by the
  -- outer "this lab hosts at least one of my experiments" predicate.
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

  -- 자동완료 최근 7일.
  SELECT COUNT(*) INTO v_auto_completed_7d
  FROM bookings b
  JOIN experiments e ON e.id = b.experiment_id
  WHERE e.created_by = v_caller
    AND b.auto_completed_at IS NOT NULL
    AND b.auto_completed_at > now() - interval '7 days';

  -- 최근 7일 클래스 변경 이력 — scoped to labs where caller owns ≥1 exp.
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
    'royal_queue', v_royal_queue,
    'auto_completed_7d', v_auto_completed_7d,
    'class_changes_7d', v_class_changes_7d
  );
END;
$$;

-- Explicit grants — default is EXECUTE TO PUBLIC which is the D2-1 bug.
REVOKE EXECUTE ON FUNCTION get_researcher_pending_work()
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_researcher_pending_work()
  TO authenticated, service_role;
