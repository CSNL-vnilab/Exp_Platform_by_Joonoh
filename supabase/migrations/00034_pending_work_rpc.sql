-- Dashboard "pending work" aggregate RPC.
--
-- The /dashboard page currently does N Supabase round-trips to assemble
-- upcoming bookings, recent activity, and per-experiment counts. D2 adds
-- four more widgets (관찰 미입력, Notion 미동기화, Royal 승급 대기,
-- 자동완료 최근 7일) — without this RPC that would N+4 round-trips.
-- Bundle them into one function call so the dashboard stays snappy.
--
-- Scope: pending work for one researcher's own experiments only. Admins
-- see the union across all experiments they own (same predicate).
--
-- Called from src/app/(admin)/dashboard/page.tsx via admin.rpc(...).
-- Arguments are explicit so we don't rely on auth.uid() inside the
-- function (service-role context).

CREATE OR REPLACE FUNCTION get_researcher_pending_work(
  p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_obs_missing integer;
  v_notion_stuck integer;
  v_royal_queue integer;
  v_auto_completed_7d integer;
  v_class_changes_7d jsonb;
BEGIN
  -- 관찰 미입력: bookings that are completed-or-past-slot-end but have
  -- no booking_observations row yet.
  SELECT COUNT(*) INTO v_obs_missing
  FROM bookings b
  JOIN experiments e ON e.id = b.experiment_id
  LEFT JOIN booking_observations o ON o.booking_id = b.id
  WHERE e.created_by = p_user_id
    AND b.status IN ('confirmed', 'completed')
    AND b.slot_end < now()
    AND o.booking_id IS NULL;

  -- Notion 미동기화: outbox rows stuck in failed with attempts < max.
  SELECT COUNT(*) INTO v_notion_stuck
  FROM booking_integrations i
  JOIN bookings b ON b.id = i.booking_id
  JOIN experiments e ON e.id = b.experiment_id
  WHERE e.created_by = p_user_id
    AND i.integration_type IN ('notion', 'notion_survey')
    AND i.status = 'failed'
    AND i.attempts < 5;

  -- Royal 승급 대기: participants in researcher's experiments whose
  -- completed booking count in this lab is >= 15 but current class
  -- isn't yet 'royal' (manual overrides blocked by the sticky guard).
  -- Treated as a signal that the recompute trigger hasn't caught up —
  -- uncommon, but worth surfacing.
  SELECT COUNT(DISTINCT b.participant_id) INTO v_royal_queue
  FROM bookings b
  JOIN experiments e ON e.id = b.experiment_id
  WHERE e.created_by = p_user_id
    AND b.status = 'completed'
  GROUP BY b.participant_id, e.lab_id
  HAVING COUNT(*) >= 15
     AND NOT EXISTS (
       SELECT 1 FROM participant_class_current pcc
       WHERE pcc.participant_id = b.participant_id
         AND pcc.lab_id = e.lab_id
         AND pcc.class IN ('royal', 'vip', 'blacklist')
     );

  IF v_royal_queue IS NULL THEN v_royal_queue := 0; END IF;

  -- 자동완료 최근 7일.
  SELECT COUNT(*) INTO v_auto_completed_7d
  FROM bookings b
  JOIN experiments e ON e.id = b.experiment_id
  WHERE e.created_by = p_user_id
    AND b.auto_completed_at IS NOT NULL
    AND b.auto_completed_at > now() - interval '7 days';

  -- 최근 7일 클래스 변경 이력.
  SELECT COALESCE(jsonb_agg(row_to_json(t.*)), '[]'::jsonb)
  INTO v_class_changes_7d
  FROM (
    SELECT a.participant_id, a.previous_class, a.new_class,
           a.changed_kind, a.created_at
    FROM participant_class_audit a
    JOIN labs l ON l.id = a.lab_id
    WHERE a.created_at > now() - interval '7 days'
      AND EXISTS (
        SELECT 1 FROM experiments e
        WHERE e.created_by = p_user_id AND e.lab_id = a.lab_id
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
