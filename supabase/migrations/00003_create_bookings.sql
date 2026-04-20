-- Bookings table: stores reservation records
CREATE TABLE bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  slot_start timestamptz NOT NULL,
  slot_end timestamptz NOT NULL,
  session_number integer DEFAULT 1,
  booking_group_id uuid,
  status text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled', 'completed', 'no_show')),
  google_event_id text,
  notion_page_id text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Performance index for slot conflict checks (NOT unique — max_participants_per_slot
-- may be > 1; concurrency is handled by advisory locks in book_slot())
CREATE INDEX idx_bookings_confirmed_slot
  ON bookings(experiment_id, slot_start, slot_end)
  WHERE status = 'confirmed';

-- For duplicate participation checks
CREATE INDEX idx_bookings_experiment_participant
  ON bookings(experiment_id, participant_id);

-- For reminder queries
CREATE INDEX idx_bookings_slot_start ON bookings(slot_start);

-- For booking group lookups (multi-session)
CREATE INDEX idx_bookings_group ON bookings(booking_group_id) WHERE booking_group_id IS NOT NULL;

-- Auto-update updated_at
CREATE TRIGGER bookings_updated_at
  BEFORE UPDATE ON bookings
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();
