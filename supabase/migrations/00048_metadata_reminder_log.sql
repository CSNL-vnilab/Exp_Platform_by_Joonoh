-- Researcher-facing metadata reminder cron log. Complements the
-- dashboard banner added in commit 961c5b2 (in-app) by sending an
-- email push so researchers don't need to open the dashboard to
-- notice missing code_repo_url / data_path / pre_experiment_checklist
-- on their experiments.
--
-- One row per (researcher, sent_at) — lets us rate-limit to "at most
-- one email per researcher per 7 days" so a weekly cron doesn't
-- deluge researchers whose gaps stay open for multiple cycles.
--
-- Payload stored so audits can confirm what was sent.

CREATE TABLE metadata_reminder_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  researcher_user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  sent_at timestamptz NOT NULL DEFAULT now(),
  email_to text NOT NULL,
  experiment_count integer NOT NULL,
  gap_summary jsonb NOT NULL
);

CREATE INDEX idx_metadata_reminder_log_recent
  ON metadata_reminder_log (researcher_user_id, sent_at DESC);

-- RLS: researchers see their own rows; admins see all. Writes are
-- service-role only (cron route uses createAdminClient()).
ALTER TABLE metadata_reminder_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY metadata_reminder_log_read_own
  ON metadata_reminder_log FOR SELECT
  TO authenticated
  USING (
    researcher_user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

COMMENT ON TABLE metadata_reminder_log IS
  'Audit + rate-limit log for /api/cron/metadata-reminders. Roadmap C4-adjacent — surfaces roadmap P0 gaps to researchers out-of-band.';
