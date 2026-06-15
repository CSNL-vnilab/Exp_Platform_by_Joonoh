-- 00073 — mark_group_completed: 가드를 slot_end<now() → slot_start<now() 로 완화
--
-- 버그: 정산 패널 "회차 완료로 표시" 버튼을 눌러도 "안내 메일 발송"
-- 버튼이 안 뜸. 원인은 00070 이 mark_group_completed 에 추가한
-- `slot_end < now()` 가드 — 참여자가 예약 슬롯의 종료시각(slot_end)
-- 이전에 실험을 끝냈거나(조기 종료) 연구원이 세션 도중/직후에 정산을
-- 처리하면, 해당 booking 의 slot_end 가 아직 미래라 RPC 가 0건만
-- flip 한다. 그러면 allBookingsCompleted 가 계속 false 라 발송 버튼이
-- 영영 활성화되지 않는다(패널은 "세션 종료 대기" 로 잠김).
--
-- 00070 이 slot_end 가드를 넣은 정당한 이유: "아직 시작도 안 한 미래
-- 세션" 을 완료로 만들면 그 슬롯이 풀려 더블부킹되고(book_slot 의
-- 오버랩 충돌 카운트는 status='confirmed' 만 셈 — 00069:87, 즉 completed
-- 는 슬롯을 비움) 리마인더 혼선이 생긴다. 그 우려는 *시작 전* 미래
-- 세션에만 유효하다.
--
-- 수정: 경계를 slot_end → slot_start 로. 이미 *시작된* 세션
-- (slot_start < now: 참여자가 와서 진행 중/방금 끝낸 세션)은 연구원의
-- 명시적 완료 처리를 허용하고, *아직 시작도 안 한* 미래 세션
-- (slot_start >= now)은 그대로 confirmed 로 두어 슬롯 보호 + 리마인더
-- 정합을 유지한다(00070 의 핵심 우려는 보존). 시작된 세션의 슬롯은
-- 이미 그 시간이 지났으므로 비워져도 실질적 더블부킹 위험이 없다.
--
-- 권한·반환·다른 동작은 00070 과 동일. 이 RPC 는 수동 버튼
-- (/api/experiments/[id]/payment-info/[bgId]/mark-completed) 만 호출한다.
-- 자동 sweep 은 별도 함수 auto_complete_stale_bookings(과거+grace) 라
-- 영향 없음.

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

  -- Started-only (00073, was slot_end<now in 00070): the explicit manual
  -- "회차 완료로 표시" attestation may run before the booked slot_end (early
  -- finish / processing mid-session). Complete any confirmed/running session
  -- that has already STARTED; leave not-yet-started future sessions
  -- 'confirmed' so their slots stay reserved (book_slot overlap counts only
  -- 'confirmed' — completing a not-yet-started slot would free it).
  UPDATE bookings
     SET status = 'completed'
   WHERE booking_group_id = p_booking_group_id
     AND status IN ('confirmed', 'running')
     AND slot_start < now();
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  RETURN jsonb_build_object('success', true, 'updated', v_updated);
END;
$$;

REVOKE EXECUTE ON FUNCTION mark_group_completed(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION mark_group_completed(uuid) TO authenticated;
