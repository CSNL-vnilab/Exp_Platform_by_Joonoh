-- Roadmap C4 — P0 reproducibility floor.
--
-- Without `exclusion_flag` / `exclusion_reason` / `data_quality` on
-- bookings, a downstream analyst can't tell which sessions to drop.
-- Psych-DS `participants.tsv` + BIDS derivatives convention both
-- assume per-session exclusion metadata. Notion SLab DB's 특이사항
-- field captured free-text rationale but nothing structured, so
-- queries like "which participants were excluded and why" require
-- manual scanning.
--
-- Schema:
--   * exclusion_flag   boolean default false (hard exclude = drop from
--     all aggregate analyses)
--   * exclusion_reason text null (free form; validated non-empty when
--     flag=true via CHECK)
--   * data_quality     enum('good','flag','exclude') default 'good'
--     * good    — normal session, no concerns
--     * flag    — soft concern (attention-check near threshold, mild
--                 researcher unease) — include in analyses but surface
--                 on dashboards for researcher review
--     * exclude — same as exclusion_flag=true, surfaced as an enum
--                 value for join-friendliness
--
-- exclusion_flag is redundant with data_quality='exclude' but BIDS
-- participants.tsv explicitly calls out a boolean "excluded" column;
-- we keep both so the Psych-DS export path (Sprint C) can emit either
-- vocabulary without a CASE.
--
-- Additive only — existing bookings default to data_quality='good'
-- and exclusion_flag=false. No data migration.

CREATE TYPE booking_data_quality AS ENUM ('good', 'flag', 'exclude');

ALTER TABLE bookings
  ADD COLUMN exclusion_flag boolean NOT NULL DEFAULT false,
  ADD COLUMN exclusion_reason text,
  ADD COLUMN data_quality booking_data_quality NOT NULL DEFAULT 'good';

-- Integrity: if you mark a booking excluded, you must explain why.
-- Keeps the dataset self-documenting when we export to Psych-DS.
ALTER TABLE bookings
  ADD CONSTRAINT bookings_exclusion_reason_required_when_flagged
  CHECK (
    (exclusion_flag = false) OR
    (exclusion_reason IS NOT NULL AND length(trim(exclusion_reason)) > 0)
  );

-- data_quality='exclude' should imply the flag. Keep them in sync so
-- downstream tools can key off either.
ALTER TABLE bookings
  ADD CONSTRAINT bookings_exclude_quality_implies_flag
  CHECK (
    (data_quality <> 'exclude') OR (exclusion_flag = true)
  );

COMMENT ON COLUMN bookings.exclusion_flag IS
  'Hard exclude from aggregate analyses. Requires exclusion_reason. Roadmap C4.';
COMMENT ON COLUMN bookings.exclusion_reason IS
  'Free-text rationale. Shown on Notion SLab row + Psych-DS export. Roadmap C4.';
COMMENT ON COLUMN bookings.data_quality IS
  'good=normal · flag=soft concern surface on dashboard · exclude=drop. Roadmap C4.';
