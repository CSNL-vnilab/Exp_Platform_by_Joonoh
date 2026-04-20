-- Transactional outbox for external integrations (Google Calendar, Notion,
-- email, SMS). The post-booking pipeline inserts one 'pending' row per
-- integration for each new booking, then processes them and flips the status
-- to 'completed' (or 'failed' with an error). A retry worker can later poll
-- failed rows without risking duplicate side effects.

CREATE TYPE integration_type AS ENUM ('gcal', 'notion', 'email', 'sms');
CREATE TYPE integration_status AS ENUM ('pending', 'completed', 'failed', 'skipped');

CREATE TABLE booking_integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  integration_type integration_type NOT NULL,
  status integration_status NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  external_id text,          -- e.g. Google event id, Notion page id
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (booking_id, integration_type)
);

CREATE INDEX idx_booking_integrations_status
  ON booking_integrations (status)
  WHERE status IN ('pending', 'failed');

CREATE INDEX idx_booking_integrations_booking
  ON booking_integrations (booking_id);

ALTER TABLE booking_integrations ENABLE ROW LEVEL SECURITY;

-- Admin or the experiment owner can read rows for bookings on their experiments.
CREATE POLICY "Admins read all integrations"
  ON booking_integrations FOR SELECT
  USING (is_admin(auth.uid()));

CREATE POLICY "Researchers read own experiment integrations"
  ON booking_integrations FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM bookings b
      JOIN experiments e ON e.id = b.experiment_id
      WHERE b.id = booking_integrations.booking_id
        AND e.created_by = auth.uid()
    )
  );
-- Writes are service-role only (RLS bypassed).
