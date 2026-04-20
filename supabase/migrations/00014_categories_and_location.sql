-- Experiments gain two participant-facing attributes:
--   categories: multi-select research categories (shown on booking page)
--   location:   single facility selector used to render directions to the
--               participant after confirmation

ALTER TABLE experiments
  ADD COLUMN categories text[] NOT NULL DEFAULT '{}',
  ADD COLUMN location text CHECK (location IN ('slab', 'snubic'));

-- Enforce allowed categories at DB level so bad values never land in Notion
-- or the timeline exports.
ALTER TABLE experiments
  ADD CONSTRAINT categories_allowed CHECK (
    categories <@ ARRAY[
      'offline_behavioral',
      'mri',
      'brain_stimulation',
      'eye_tracking',
      'online_behavioral'
    ]::text[]
  );

CREATE INDEX idx_experiments_categories ON experiments USING GIN (categories);
CREATE INDEX idx_experiments_location ON experiments (location);
