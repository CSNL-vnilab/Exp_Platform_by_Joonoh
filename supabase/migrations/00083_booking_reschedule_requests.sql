-- 00083 — participant reschedule REQUESTS + experimenter approval + revive-capable apply RPC
--
-- User directive 2026-07: participants may request rescheduling of an
-- INDIVIDUAL session (per 회차), regardless of reason (no-show or advance
-- notice). The change is NOT applied immediately — it is emailed to the
-- experimenter (experiments.created_by) and only APPLIED on the
-- experimenter's approval, after which a confirmation email is sent and
-- Google Calendar + DB + future reminders update.
--
-- This converts the existing IMMEDIATE participant booking-edit reschedule
-- into a request→approval flow. Modeled on 00061_participant_blacklist_requests
-- (a light approval queue) for the table + RLS, and on 00072_reschedule_booking
-- for the atomic apply RPC.
--
-- Two objects:
--   1. booking_reschedule_requests — the pending-approval queue (one open
--      request per booking via a partial UNIQUE index).
--   2. apply_reschedule_request(uuid, timestamptz, timestamptz, text) — a
--      revive-capable clone of reschedule_booking(00072). Identical atomic
--      capacity re-check under the SAME advisory key, EXCEPT the CAS matches
--      status IN ('confirmed','no_show','cancelled') and SETs status='confirmed'
--      — so an approved reschedule revives a no-showed OR cancelled session at
--      the new slot (the "전부 취소 후 재예약" and "노쇼 회차 수정" flows). Only
--      completed/running sessions are refused. Called by the approval route via
--      the service-role client only.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE FUNCTION /
-- DROP POLICY IF EXISTS + CREATE.

CREATE TABLE IF NOT EXISTS booking_reschedule_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  booking_group_id uuid,
  experiment_id uuid NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  participant_id uuid,
  -- Requested new slot.
  requested_slot_start timestamptz NOT NULL,
  requested_slot_end timestamptz NOT NULL,
  -- Snapshot of the session AT REQUEST TIME (for the notification email +
  -- audit). The authoritative old slot at apply time is re-read live from
  -- bookings so a concurrent admin move is respected.
  current_slot_start timestamptz,
  current_slot_end timestamptz,
  current_status text,
  reason text CHECK (reason IS NULL OR length(reason) <= 500),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  rejected_reason text,
  -- Notify bookkeeping.
  request_email_sent_at timestamptz,
  decision_email_sent_at timestamptz,
  last_email_error text
);

-- One OPEN request per session; decided rows are unconstrained (full audit).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_pending_reschedule_req_per_booking
  ON booking_reschedule_requests (booking_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_reschedule_req_experiment_pending
  ON booking_reschedule_requests (experiment_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_reschedule_req_status_created
  ON booking_reschedule_requests (status, requested_at DESC);

ALTER TABLE booking_reschedule_requests ENABLE ROW LEVEL SECURITY;

-- The experiment owner sees their experiment's requests; admins see all.
-- INSERT/UPDATE happen via the service-role client in the routes (participants
-- are unauthenticated), so no write policy is needed.
DROP POLICY IF EXISTS reschedule_req_read ON booking_reschedule_requests;
CREATE POLICY reschedule_req_read
  ON booking_reschedule_requests FOR SELECT
  TO authenticated
  USING (
    is_admin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM experiments e
      WHERE e.id = booking_reschedule_requests.experiment_id
        AND e.created_by = auth.uid()
    )
  );

COMMENT ON TABLE booking_reschedule_requests IS
  '참여자가 제출하고 실험자(experiments.created_by)/admin이 승인·반려하는 회차별 일정변경 요청 큐. pending → 승인 시 apply_reschedule_request RPC로 적용(no_show revive 포함) + runReschedulePipeline(캘린더·리마인더·정산·확정메일). 한 회차당 열린 요청 1개(partial UNIQUE).';

-- ── apply_reschedule_request: revive-capable atomic reschedule ────────────
-- Clone of reschedule_booking(00072) with the status CAS relaxed to also
-- accept no_show and to SET status='confirmed'. Same advisory key + capacity
-- recount, so it serializes with book_slot / reschedule_booking.
CREATE OR REPLACE FUNCTION apply_reschedule_request(
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
  SELECT b.experiment_id, e.max_participants_per_slot
    INTO v_experiment_id, v_max
    FROM bookings b
    JOIN experiments e ON e.id = b.experiment_id
   WHERE b.id = p_booking_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'NOT_FOUND');
  END IF;

  -- Same advisory key as book_slot(00069)/reschedule_booking(00072).
  IF NOT pg_try_advisory_xact_lock(hashtext(v_experiment_id::text)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'SLOT_CONTENTION_RETRY');
  END IF;

  -- Time-overlap capacity check (confirmed occupy capacity), self excluded.
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

  -- Revive-capable CAS: accept confirmed (advance-notice reschedule),
  -- no_show (reschedule a missed session), OR cancelled (re-book a
  -- cancelled session — the "전부 취소 후 재예약" flow), and always land on
  -- confirmed. completed/running are refused (real/in-flight sessions).
  UPDATE bookings
     SET slot_start = p_new_start,
         slot_end = p_new_end,
         status = 'confirmed',
         google_event_id = CASE
           WHEN p_new_event_id IS NOT NULL THEN p_new_event_id
           ELSE google_event_id
         END
   WHERE id = p_booking_id
     AND status IN ('confirmed', 'no_show', 'cancelled');
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN
    -- completed/running (or vanished) — not reschedulable.
    RETURN jsonb_build_object('success', false, 'error', 'STATUS_CHANGED');
  END IF;

  RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE EXECUTE ON FUNCTION apply_reschedule_request(uuid, timestamptz, timestamptz, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION apply_reschedule_request(uuid, timestamptz, timestamptz, text) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION apply_reschedule_request(uuid, timestamptz, timestamptz, text) TO service_role;

NOTIFY pgrst, 'reload schema';
