-- Enable RLS on all tables
ALTER TABLE experiments ENABLE ROW LEVEL SECURITY;
ALTER TABLE participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_log ENABLE ROW LEVEL SECURITY;

-- ============ experiments ============
-- Public: read active experiments
CREATE POLICY "Anyone can read active experiments"
  ON experiments FOR SELECT
  USING (status = 'active');

-- Admin: full access to own experiments
CREATE POLICY "Admins can manage own experiments"
  ON experiments FOR ALL
  USING (auth.uid() = created_by)
  WITH CHECK (auth.uid() = created_by);

-- ============ participants ============
-- Public: can insert (for booking)
CREATE POLICY "Anyone can create participants"
  ON participants FOR INSERT
  WITH CHECK (true);

-- Admin: read participants linked to own experiments (for booking list)
CREATE POLICY "Admins can read participants for own experiments"
  ON participants FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM bookings b
      JOIN experiments e ON e.id = b.experiment_id
      WHERE b.participant_id = participants.id
        AND e.created_by = auth.uid()
    )
  );

-- ============ bookings ============
-- Admin: read bookings for own experiments
CREATE POLICY "Admins can read bookings for own experiments"
  ON bookings FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM experiments
      WHERE experiments.id = bookings.experiment_id
        AND experiments.created_by = auth.uid()
    )
  );

-- Admin: update bookings for own experiments (cancel, etc.)
CREATE POLICY "Admins can update bookings for own experiments"
  ON bookings FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM experiments
      WHERE experiments.id = bookings.experiment_id
        AND experiments.created_by = auth.uid()
    )
  );

-- Bookings are inserted via book_slot RPC (SECURITY DEFINER), not direct insert

-- ============ reminders & notification_log ============
-- Service role only (accessed via service_role key which bypasses RLS)
-- No public policies needed
