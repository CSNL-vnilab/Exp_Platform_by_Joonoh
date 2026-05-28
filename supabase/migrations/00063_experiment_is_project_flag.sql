-- "Is this a real project?" opt-out flag for experiments.
--
-- User directive 2026-05-28: researchers sometimes book SLab slots for
-- pilot runs, equipment tests, and other one-off uses that aren't a
-- standalone project. Those rows still show up as experiments with
-- empty metadata, so they keep getting nagged by the daily
-- /api/cron/db-quality-check reminder + listed on /metadata-fill.
--
-- This flag lets a researcher mark such an experiment as "not a real
-- project" — the metadata-fill page hides it, the cron sweep excludes
-- it from the gap inventory, and the experiment list card surfaces a
-- small badge so it's still visible but obviously deprioritised.
--
-- Default true keeps every existing row in the standard project flow;
-- opt-out is per-row researcher action.

ALTER TABLE experiments
  ADD COLUMN is_project boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN experiments.is_project IS
  'False = pilot / 장비 테스트 / one-off, opted out of the metadata-fill nag flow. /metadata-fill and /api/cron/db-quality-check filter these out. Default true preserves the existing nag for every legacy row.';
