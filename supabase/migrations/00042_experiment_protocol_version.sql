-- Add `experiments.protocol_version` so researchers can stamp each
-- experiment with a version label (e.g. "v1.2", "protocol-2026-03-rev2")
-- that propagates to every Notion booking row as 버전넘버.
--
-- Scope is per-experiment, not per-booking. When a researcher iterates
-- the protocol mid-run (rare but it happens — stimulus set swap,
-- trigger-timing fix), they bump the field and every new booking
-- captures the updated string. Existing Notion rows keep their original
-- 버전넘버 because the page is created at booking time, not re-synced.

ALTER TABLE experiments
  ADD COLUMN IF NOT EXISTS protocol_version text;

-- Back-compat: nullable + no default. Existing rows just have NULL which
-- surfaces as "-" in UI and empty string in Notion.

-- Optional length bound so researchers can't paste an essay.
ALTER TABLE experiments
  ADD CONSTRAINT experiments_protocol_version_length
    CHECK (protocol_version IS NULL OR length(protocol_version) <= 64);
