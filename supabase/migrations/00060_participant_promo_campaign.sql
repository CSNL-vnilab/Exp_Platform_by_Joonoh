-- Participant recruitment ("홍보") email campaign log.
--
-- Admins pick an active experiment + a checkbox set of existing
-- participants on the 참여자 관리 page and fire a recruitment email to
-- each selected person's address. This table records one row per
-- (experiment, participant) attempt so that:
--
--   1. the send is auditable (what address, when, by whom, message-id);
--   2. the UI can grey out / warn on participants who were already
--      mailed for the same experiment, preventing accidental
--      double-blasts when an admin re-opens the modal;
--   3. failures keep their own row (status='failed' + error) instead
--      of vanishing into Vercel runtime logs.
--
-- Writes are service-role only — the /api/participants/promo-email
-- route uses createAdminClient(). Reads are admin-only (the feature
-- itself is admin-gated; researchers never see participant emails).

CREATE TABLE participant_promo_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  email text NOT NULL,
  status text NOT NULL CHECK (status IN ('sent', 'failed')),
  message_id text,
  error text,
  sent_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Dedup / "already mailed for this experiment?" lookup is keyed on
-- (experiment, participant); newest-first so the UI reads the latest
-- attempt's status.
CREATE INDEX idx_participant_promo_sends_exp_participant
  ON participant_promo_sends (experiment_id, participant_id, created_at DESC);

ALTER TABLE participant_promo_sends ENABLE ROW LEVEL SECURITY;

CREATE POLICY participant_promo_sends_read_admin
  ON participant_promo_sends FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

COMMENT ON TABLE participant_promo_sends IS
  '참여자 홍보 메일 발송 감사 로그. /api/participants/promo-email 가 (experiment, participant) 별 1행씩 기록. 중복 발송 방지 + 감사용.';
COMMENT ON COLUMN participant_promo_sends.email IS
  '발송 시점의 참여자 이메일 스냅샷 (이후 변경되어도 감사 추적 가능).';
COMMENT ON COLUMN participant_promo_sends.status IS
  'sent = Gmail SMTP 수락, failed = 전송 실패(error 컬럼 참조).';
COMMENT ON COLUMN participant_promo_sends.sent_by IS
  '발송을 트리거한 관리자 profiles.id.';
