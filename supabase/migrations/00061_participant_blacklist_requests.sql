-- Researcher-initiated blacklist requests with admin approval.
--
-- User directive 2026-05-20: blacklist class assignment was previously
-- admin-only (see /api/participants/[id]/class). Going forward,
-- researchers may select participants on the 참여자 관리 page, enter a
-- short reason, and submit a PENDING request. Admin approves (or
-- rejects); on approval the blacklist class fires via the existing
-- assign_participant_class_manual RPC and the participants.phone
-- column is overwritten with the supplied last-4 digits (privacy: only
-- the trailing 4 are stored / displayed).
--
-- One row per request. Idempotency: a partial UNIQUE INDEX prevents
-- two simultaneous PENDING requests for the same (participant, lab) —
-- approved/rejected rows are unconstrained so historical attempts are
-- preserved.

CREATE TABLE participant_blacklist_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  lab_id uuid NOT NULL REFERENCES labs(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(reason) BETWEEN 2 AND 500),
  -- Last-4 digits of the contact number supplied by the requester so
  -- the admin can identify the right person at approval time. Optional
  -- — when blank, approval falls back to whatever participants.phone
  -- already holds.
  phone_last4 text CHECK (phone_last4 IS NULL OR phone_last4 ~ '^[0-9]{4}$'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  approved_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  approved_at timestamptz,
  rejected_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One pending request per (participant, lab). Approved/rejected rows
-- stay unrestricted so audit history is full.
CREATE UNIQUE INDEX uniq_pending_blacklist_req_per_participant
  ON participant_blacklist_requests (participant_id, lab_id)
  WHERE status = 'pending';

CREATE INDEX idx_blacklist_req_status_created
  ON participant_blacklist_requests (status, created_at DESC);

CREATE INDEX idx_blacklist_req_requester
  ON participant_blacklist_requests (requested_by, created_at DESC);

ALTER TABLE participant_blacklist_requests ENABLE ROW LEVEL SECURITY;

-- Researchers see their own requests; admins see all.
CREATE POLICY blacklist_req_read
  ON participant_blacklist_requests FOR SELECT
  TO authenticated
  USING (
    requested_by = auth.uid()
    OR EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid() AND role = 'admin' AND disabled = false
    )
  );

COMMENT ON TABLE participant_blacklist_requests IS
  '연구원이 제출하고 관리자가 승인/반려하는 블랙리스트 등록 요청. pending → admin 승인 시 assign_participant_class_manual 발동 + participants.phone에 last-4 stamping. 라이트한 모더레이션 큐.';
COMMENT ON COLUMN participant_blacklist_requests.phone_last4 IS
  '식별용 last-4 digits만 저장. 승인 시 participants.phone에 복사 (UNIQUE(phone,email)는 email로 분리되므로 충돌 없음).';
