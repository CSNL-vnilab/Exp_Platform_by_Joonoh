-- 00079 — wipe_booking_group RPC + booking_wipe_audit
--
-- 노쇼(펑크) 처리 & 기록 삭제 기능. A participant who no-showed leaves a
-- phantom subject_number, a stale recruitment seat, a stuck payment-info
-- row, and cross-study exclusion matches. This RPC lets the experiment
-- owner delete the whole booking group so the participant can re-apply
-- cleanly (subject_number freed, seat freed, exclusion cleared).
--
-- SAFETY: the function is SECURITY DEFINER (bypasses RLS to DELETE, since
-- bookings has no DELETE policy) but has NO ownership check of its own —
-- the route (POST /api/bookings/[bookingId]/wipe) enforces
-- requireBookingAccess(ownerOnly) and only then calls this via the
-- service-role client. Therefore EXECUTE is REVOKEd from PUBLIC/anon/
-- authenticated and GRANTed only to service_role, closing the IDOR where
-- an anon/authenticated PostgREST caller could invoke it directly and wipe
-- another researcher's group (the 00035 IDOR class).
--
-- GUARDS (atomic backstop; the route also pre-checks the same 3 to avoid
-- firing side effects before refusing):
--   1. any 'completed' session in the group  → refuse (real participation)
--   2. payment_info.status ∈ money-moved 4종  → refuse
--   3. EVER-claimed: payment_info.claimed_at IS NOT NULL, OR a payment_claims
--      row references the group  → refuse (audit trail must survive; a
--      claimed→cancelled row keeps claimed_at, 00075)
-- Only pending_participant / never-claimed cancelled / payment_info-absent
-- groups are wipe-eligible.
--
-- Deletes participant_payment_info (no FK to bookings) then bookings; the
-- bookings delete cascades reminders / booking_integrations /
-- booking_observations / experiment_run_progress / online screener rows.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + CREATE OR REPLACE FUNCTION.

CREATE TABLE IF NOT EXISTS booking_wipe_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Identifiers/metadata only — NO name/phone/RRN/bank (data-minimized;
  -- participant_id points at the retained participants row). reason is
  -- free text (the UI warns against typing PII there).
  participant_id uuid,
  experiment_id uuid,
  booking_group_id uuid NOT NULL,
  subject_number integer,
  statuses jsonb,
  google_event_ids text[],
  wiped_by uuid,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE booking_wipe_audit ENABLE ROW LEVEL SECURITY;
-- No policies: the SECURITY DEFINER function (owned by the migration
-- superuser) inserts regardless of RLS; no anon/authenticated read path.

COMMENT ON TABLE booking_wipe_audit IS
  '노쇼 wipe 감사 로그 — 삭제된 booking_group의 식별자/상태 스냅샷. PII(이름/전화/RRN/계좌) 미저장.';

CREATE OR REPLACE FUNCTION wipe_booking_group(
  p_booking_group_id uuid,
  p_wiped_by uuid,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_experiment_id uuid;
  v_participant_id uuid;
  v_subject_number integer;
  v_statuses jsonb;
  v_event_ids text[];
  v_deleted_count integer;
BEGIN
  -- Serialize concurrent wipes of the same group.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_booking_group_id::text, 0));

  SELECT
    max(experiment_id),
    max(participant_id),
    max(subject_number),
    jsonb_agg(jsonb_build_object('id', id, 'status', status)),
    array_remove(array_agg(google_event_id), NULL),
    count(*)::int
  INTO v_experiment_id, v_participant_id, v_subject_number,
       v_statuses, v_event_ids, v_deleted_count
  FROM bookings
  WHERE booking_group_id = p_booking_group_id;

  IF v_experiment_id IS NULL THEN
    RAISE EXCEPTION 'wipe_no_bookings' USING ERRCODE = 'P0002';
  END IF;

  -- Guard 1: real participation happened.
  IF EXISTS (
    SELECT 1 FROM bookings
    WHERE booking_group_id = p_booking_group_id AND status = 'completed'
  ) THEN
    RAISE EXCEPTION 'wipe_blocked_completed' USING ERRCODE = 'P0001';
  END IF;

  -- Guards 2 + 3: money moved, or the group was ever claimed (belt +
  -- suspenders: claimed_at on the row AND a payment_claims reference).
  IF EXISTS (
    SELECT 1 FROM participant_payment_info pi
    WHERE pi.booking_group_id = p_booking_group_id
      AND (
        pi.status IN ('claimed', 'submitted_to_admin', 'paid', 'paid_offline')
        OR pi.claimed_at IS NOT NULL
      )
  ) OR EXISTS (
    SELECT 1 FROM payment_claims pc
    WHERE p_booking_group_id = ANY (pc.booking_group_ids)
  ) THEN
    RAISE EXCEPTION 'wipe_blocked_payment' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO booking_wipe_audit (
    participant_id, experiment_id, booking_group_id, subject_number,
    statuses, google_event_ids, wiped_by, reason
  ) VALUES (
    v_participant_id, v_experiment_id, p_booking_group_id, v_subject_number,
    v_statuses, v_event_ids, p_wiped_by, left(coalesce(p_reason, ''), 500)
  );

  DELETE FROM participant_payment_info WHERE booking_group_id = p_booking_group_id;
  DELETE FROM bookings WHERE booking_group_id = p_booking_group_id;

  RETURN jsonb_build_object(
    'experiment_id', v_experiment_id,
    'participant_id', v_participant_id,
    'subject_number', v_subject_number,
    'google_event_ids', to_jsonb(coalesce(v_event_ids, ARRAY[]::text[])),
    'deleted_count', v_deleted_count
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION wipe_booking_group(uuid, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION wipe_booking_group(uuid, uuid, text) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION wipe_booking_group(uuid, uuid, text) TO service_role;

NOTIFY pgrst, 'reload schema';
