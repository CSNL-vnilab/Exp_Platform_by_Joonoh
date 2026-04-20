-- Two admin-managed tables:
--   experiment_locations — formerly hard-coded 'slab' / 'snubic' enum values.
--     Researchers now pick from a dynamic list the admin maintains.
--   experiment_manual_blocks — researcher can black out specific time ranges
--     (beyond whatever Google Calendar already says is busy). Merged into the
--     slot generator alongside GCal FreeBusy.

CREATE TABLE experiment_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  address_lines text[] NOT NULL DEFAULT '{}',
  naver_url text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER experiment_locations_updated_at
  BEFORE UPDATE ON experiment_locations
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

ALTER TABLE experiment_locations ENABLE ROW LEVEL SECURITY;

-- Anyone can read locations (needed by public booking pages to resolve the
-- address displayed on the confirmation screen).
CREATE POLICY "Anyone reads locations"
  ON experiment_locations FOR SELECT
  USING (true);

-- Only admins mutate.
CREATE POLICY "Admins manage locations"
  ON experiment_locations FOR ALL
  USING (is_admin(auth.uid()))
  WITH CHECK (is_admin(auth.uid()));

-- Seed: the two hard-coded locations replace 'slab' / 'snubic'. Slab is
-- renamed to the correct room label.
INSERT INTO experiment_locations (id, name, address_lines, naver_url)
VALUES
  (
    'aaaaaaaa-aaaa-aaaa-aaaa-000000000001'::uuid,
    '본관 305호 행동실험실',
    ARRAY['건물 A 3층', '305호 행동실험실'],
    NULL
  ),
  (
    'aaaaaaaa-aaaa-aaaa-aaaa-000000000002'::uuid,
    '영상센터',
    ARRAY['건물 B 1층', '뇌영상센터'],
    NULL
  );

-- Add location_id to experiments while keeping the legacy `location` enum
-- column around until all rows are migrated. New code reads from
-- location_id first, falls back to location for legacy entries.
ALTER TABLE experiments
  ADD COLUMN location_id uuid REFERENCES experiment_locations(id) ON DELETE SET NULL;

-- Backfill: map legacy enum strings to the seed UUIDs.
UPDATE experiments
SET location_id = 'aaaaaaaa-aaaa-aaaa-aaaa-000000000001'::uuid
WHERE location = 'slab';

UPDATE experiments
SET location_id = 'aaaaaaaa-aaaa-aaaa-aaaa-000000000002'::uuid
WHERE location = 'snubic';

CREATE INDEX idx_experiments_location_id ON experiments(location_id);

-- ─────────────────────────────────────────────────────────────────────────
-- Manual blocks — researcher-declared busy intervals on their experiment.
-- Cascades on experiment delete so hard-deleting an experiment cleans up.

CREATE TABLE experiment_manual_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  block_start timestamptz NOT NULL,
  block_end timestamptz NOT NULL,
  reason text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (block_end > block_start)
);

CREATE INDEX idx_manual_blocks_experiment ON experiment_manual_blocks(experiment_id);
CREATE INDEX idx_manual_blocks_range ON experiment_manual_blocks(block_start, block_end);

ALTER TABLE experiment_manual_blocks ENABLE ROW LEVEL SECURITY;

-- Public read (same as experiments) so the booking page slot-generator can
-- include manual blocks for participants.
CREATE POLICY "Anyone reads manual blocks"
  ON experiment_manual_blocks FOR SELECT
  USING (true);

CREATE POLICY "Researchers manage own experiment blocks"
  ON experiment_manual_blocks FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM experiments
      WHERE experiments.id = experiment_manual_blocks.experiment_id
        AND experiments.created_by = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM experiments
      WHERE experiments.id = experiment_manual_blocks.experiment_id
        AND experiments.created_by = auth.uid()
    )
  );

CREATE POLICY "Admins manage all manual blocks"
  ON experiment_manual_blocks FOR ALL
  USING (is_admin(auth.uid()))
  WITH CHECK (is_admin(auth.uid()));
