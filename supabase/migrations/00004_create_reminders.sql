-- Reminders table: scheduled notification records
CREATE TABLE reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  reminder_type text NOT NULL CHECK (reminder_type IN ('day_before_evening', 'day_of_morning')),
  scheduled_at timestamptz NOT NULL,
  sent_at timestamptz,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  channel text NOT NULL DEFAULT 'both' CHECK (channel IN ('email', 'sms', 'both')),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_reminders_pending ON reminders(scheduled_at, status) WHERE status = 'pending';

-- Notification log: tracks all sent notifications
CREATE TABLE notification_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid REFERENCES bookings(id) ON DELETE SET NULL,
  channel text NOT NULL,
  type text NOT NULL,
  recipient text NOT NULL,
  status text NOT NULL,
  external_id text,
  error_message text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_notification_log_booking ON notification_log(booking_id);
