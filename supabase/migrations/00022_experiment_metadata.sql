-- Force researchers to declare per-experiment research metadata:
--   code_repo_url          — GitHub URL or server path for analysis code
--   data_path              — storage location for raw data
--   parameter_schema       — array of { key, type, default?, options? }
--   pre_experiment_checklist — array of { item, required, checked?, checked_at? }
--
-- Activation rule (DB-level safety net): status cannot transition to 'active'
-- unless code_repo_url AND data_path are non-empty. Form-level validation
-- hits first but the trigger guards against API/bulk-update paths.
--
-- Notion mirror: notion_experiment_page_id lets us idempotently push/update
-- the experiment-level Notion page on draft→active.
--
-- Booking gate: checklist_completed_at is the timestamp when all *required*
-- checklist items were last ticked. /book/:id refuses new reservations while
-- the experiment has any required items and checklist_completed_at is null
-- (or older than the latest edit to the checklist — handled in application
-- logic by clearing the timestamp when the checklist schema changes).

ALTER TABLE experiments
  ADD COLUMN code_repo_url text,
  ADD COLUMN data_path text,
  ADD COLUMN parameter_schema jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN pre_experiment_checklist jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN checklist_completed_at timestamptz,
  ADD COLUMN notion_experiment_page_id text,
  ADD COLUMN notion_experiment_sync_attempted_at timestamptz;

-- Shape guard: must be arrays (jsonb_typeof returns 'array' / 'null' / ...).
ALTER TABLE experiments
  ADD CONSTRAINT experiments_parameter_schema_is_array
    CHECK (jsonb_typeof(parameter_schema) = 'array'),
  ADD CONSTRAINT experiments_checklist_is_array
    CHECK (jsonb_typeof(pre_experiment_checklist) = 'array');

-- Gate: an active experiment must always have code_repo_url + data_path.
-- We deliberately re-validate on *every* INSERT/UPDATE where the new status
-- is 'active' (not just transitions) because:
--   1) pre-existing rows already at status='active' from before this migration
--      would otherwise silently keep a NULL code/data path forever;
--   2) completed→active / cancelled→active reactivations must satisfy the
--      same guard as draft→active.
CREATE OR REPLACE FUNCTION experiments_enforce_activation_metadata()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'active' THEN
    IF NEW.code_repo_url IS NULL OR btrim(NEW.code_repo_url) = '' THEN
      RAISE EXCEPTION 'code_repo_url is required to activate experiment'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.data_path IS NULL OR btrim(NEW.data_path) = '' THEN
      RAISE EXCEPTION 'data_path is required to activate experiment'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS experiments_enforce_activation_metadata_trg ON experiments;
CREATE TRIGGER experiments_enforce_activation_metadata_trg
  BEFORE INSERT OR UPDATE ON experiments
  FOR EACH ROW
  EXECUTE FUNCTION experiments_enforce_activation_metadata();

-- Safety backfill: any pre-existing experiment already at status='active' but
-- missing code_repo_url or data_path would otherwise be unable to be updated
-- (the new trigger would reject any future UPDATE because NEW.status is still
-- 'active'). Flip those rows back to 'draft' so researchers can fill in the
-- metadata and re-activate through the normal path.
-- We bypass the trigger on this single row-level update by temporarily
-- disabling it for the duration of the UPDATE; safe because we ourselves
-- are moving the row OUT of 'active', not into it.
ALTER TABLE experiments DISABLE TRIGGER experiments_enforce_activation_metadata_trg;
UPDATE experiments
SET status = 'draft'
WHERE status = 'active'
  AND (
    code_repo_url IS NULL OR btrim(code_repo_url) = '' OR
    data_path IS NULL OR btrim(data_path) = ''
  );
ALTER TABLE experiments ENABLE TRIGGER experiments_enforce_activation_metadata_trg;

-- Index: admin dashboards often filter by "experiments missing data_path" etc.
CREATE INDEX idx_experiments_missing_code_repo
  ON experiments (id) WHERE code_repo_url IS NULL OR btrim(code_repo_url) = '';
CREATE INDEX idx_experiments_missing_data_path
  ON experiments (id) WHERE data_path IS NULL OR btrim(data_path) = '';
