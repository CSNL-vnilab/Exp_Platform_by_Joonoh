-- 00072: atomic reschedule_booking RPC (재검증 finding S3b, confirmed-high).
--
-- 왜 이 마이그레이션이 필요한가
-- ──────────────────────────────
-- 예약 변경(reschedule) 경로는 "capacity SELECT 검사 → (GCal 왕복) →
-- 최종 UPDATE" 순서로, capacity 검사와 슬롯 쓰기가 **비원자적**이었다.
-- advisory lock 밖에서 confirmed-overlap 을 세고, 그 사이 다른
-- reschedule/신규예약이 같은 슬롯을 점유하면 두 요청이 모두 통과해
-- **동시 reschedule 더블부킹**이 났다. (admin PATCH +
-- 참여자 booking-edit reschedule 두 경로 모두 해당.)
--
-- 해법: book_slot(00069) 과 동일한 원자성 패턴을 reschedule 에도 적용한다.
--   - book_slot 과 **같은 advisory 키** hashtext(experiment_id::text)
--     (00069:113) 를 잡아 reschedule 끼리는 물론 신규예약과도 직렬화.
--   - 00069 의 time-OVERLAP capacity 술어를 자기 자신 제외 후 재사용.
--   - status='confirmed' CAS 를 RPC 내부로 흡수 (라우트의 기존
--     .eq("status","confirmed") 가드가 하던 일) — slot 쓰기가
--     completed/cancelled 로 바뀐 행에 착지하는 것을 막는다.
--
-- GCal 이벤트는 라우트가 RPC 호출 **전에** 미리 만들어 p_new_event_id 로
-- 넘긴다 (캘린더 실패 시 DB·캘린더 모두 옛 슬롯에 머무는 기존 순서 유지).
-- RPC 가 거부하면 라우트가 방금 만든 이벤트를 정리한다.
--
-- 적용: 메인 세션이 검토 후 scripts/apply-migration-mgmt.mjs 로 적용.
--   이 RPC 는 admin(service_role) 클라이언트에서만 호출된다.

CREATE OR REPLACE FUNCTION reschedule_booking(
  p_booking_id uuid,
  p_new_start timestamptz,
  p_new_end timestamptz,
  p_new_event_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_experiment_id uuid;
  v_max integer;
  v_conflict_count integer;
  v_updated integer := 0;
BEGIN
  -- 대상 booking 의 experiment 로드 (행이 사라졌으면 NOT_FOUND).
  SELECT b.experiment_id, e.max_participants_per_slot
    INTO v_experiment_id, v_max
    FROM bookings b
    JOIN experiments e ON e.id = b.experiment_id
   WHERE b.id = p_booking_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'NOT_FOUND');
  END IF;

  -- book_slot(00069:113) 과 동일한 키. reschedule 끼리, 그리고 신규예약과도
  -- 직렬화되어 capacity 재검증~slot 쓰기 구간이 원자적으로 보호된다.
  IF NOT pg_try_advisory_xact_lock(hashtext(v_experiment_id::text)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'SLOT_CONTENTION_RETRY');
  END IF;

  -- Time-OVERLAP capacity 검사 (00069 술어 재사용), 자기 자신 제외.
  -- confirmed 만 정원을 점유한다 — book_slot 과 동일 의미.
  SELECT COUNT(*) INTO v_conflict_count
  FROM bookings
  WHERE experiment_id = v_experiment_id
    AND status = 'confirmed'
    AND id <> p_booking_id
    AND slot_start < p_new_end
    AND slot_end > p_new_start;
  IF v_conflict_count >= v_max THEN
    RETURN jsonb_build_object('success', false, 'error', 'SLOT_ALREADY_TAKEN');
  END IF;

  -- status='confirmed' CAS — 라우트에 있던 .eq("status","confirmed") 가드가
  -- 여기로 이동했다. lock 획득 전에 동시 writer 가 completed/cancelled 로
  -- 전이했다면 0행 → STATUS_CHANGED. p_new_event_id 가 주어졌을 때만
  -- google_event_id 를 교체한다.
  UPDATE bookings
     SET slot_start = p_new_start,
         slot_end = p_new_end,
         google_event_id = CASE
           WHEN p_new_event_id IS NOT NULL THEN p_new_event_id
           ELSE google_event_id
         END
   WHERE id = p_booking_id
     AND status = 'confirmed';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'STATUS_CHANGED');
  END IF;

  RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE EXECUTE ON FUNCTION reschedule_booking(uuid, timestamptz, timestamptz, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION reschedule_booking(uuid, timestamptz, timestamptz, text) TO service_role;
