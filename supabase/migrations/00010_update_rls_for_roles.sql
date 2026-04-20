-- Extend existing policies so admins see everything, researchers stay scoped
-- to their own experiments (same behavior as before). Disabled accounts lose
-- access even to their own data.

-- ============ experiments ============
DROP POLICY IF EXISTS "Admins can manage own experiments" ON experiments;

CREATE POLICY "Researchers manage own experiments"
  ON experiments FOR ALL
  USING (
    auth.uid() = created_by
    AND NOT EXISTS (
      SELECT 1 FROM profiles WHERE id = auth.uid() AND disabled = true
    )
  )
  WITH CHECK (auth.uid() = created_by);

CREATE POLICY "Admins manage all experiments"
  ON experiments FOR ALL
  USING (is_admin(auth.uid()))
  WITH CHECK (is_admin(auth.uid()));

-- ============ participants ============
DROP POLICY IF EXISTS "Admins can read participants for own experiments" ON participants;

CREATE POLICY "Researchers read participants for own experiments"
  ON participants FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM bookings b
      JOIN experiments e ON e.id = b.experiment_id
      WHERE b.participant_id = participants.id
        AND e.created_by = auth.uid()
    )
  );

CREATE POLICY "Admins read all participants"
  ON participants FOR SELECT
  USING (is_admin(auth.uid()));

-- ============ bookings ============
DROP POLICY IF EXISTS "Admins can read bookings for own experiments" ON bookings;
DROP POLICY IF EXISTS "Admins can update bookings for own experiments" ON bookings;

CREATE POLICY "Researchers read bookings for own experiments"
  ON bookings FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM experiments
      WHERE experiments.id = bookings.experiment_id
        AND experiments.created_by = auth.uid()
    )
  );

CREATE POLICY "Admins read all bookings"
  ON bookings FOR SELECT
  USING (is_admin(auth.uid()));

CREATE POLICY "Researchers update bookings for own experiments"
  ON bookings FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM experiments
      WHERE experiments.id = bookings.experiment_id
        AND experiments.created_by = auth.uid()
    )
  );

CREATE POLICY "Admins update any booking"
  ON bookings FOR UPDATE
  USING (is_admin(auth.uid()))
  WITH CHECK (is_admin(auth.uid()));
