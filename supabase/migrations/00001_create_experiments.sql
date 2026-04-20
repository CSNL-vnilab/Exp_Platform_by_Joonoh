-- Experiments table: stores all experiment configurations
CREATE TABLE experiments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  description text,
  start_date date NOT NULL,
  end_date date NOT NULL,
  session_duration_minutes integer NOT NULL,
  max_participants_per_slot integer NOT NULL DEFAULT 1,
  participation_fee integer DEFAULT 0,
  session_type text NOT NULL DEFAULT 'single' CHECK (session_type IN ('single', 'multi')),
  required_sessions integer DEFAULT 1,
  daily_start_time time NOT NULL,
  daily_end_time time NOT NULL,
  break_between_slots_minutes integer DEFAULT 0,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'completed', 'cancelled')),
  google_calendar_id text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER experiments_updated_at
  BEFORE UPDATE ON experiments
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- Indexes
CREATE INDEX idx_experiments_status ON experiments(status);
CREATE INDEX idx_experiments_created_by ON experiments(created_by);
CREATE INDEX idx_experiments_dates ON experiments(start_date, end_date);
