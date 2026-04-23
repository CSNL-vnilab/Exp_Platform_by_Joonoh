-- Notion integration health tracking.
--
-- Two separate concerns, one table because they share the "I ran a
-- background job against the Notion API and here's what happened" shape:
--
-- 1. `check_type = 'schema_drift'` — recorded by /api/cron/notion-health.
--    Fetches the DB properties from the Notion API, diffs against
--    src/lib/notion/schema.ts, writes healthy|unhealthy + report jsonb.
--    Retained for audit; the UI reads the most recent row.
--
-- 2. `check_type = 'retry_sweep'` — recorded by /api/cron/notion-retry.
--    Scans booking_integrations where status='failed' and re-runs the
--    appropriate client call. The row captures how many rows were
--    processed and how many recovered vs still-failed.
--
-- Append-only by design — we never UPDATE or DELETE rows, so even a
-- fix-and-re-break cycle is forensically reconstructible.
--
-- Reverting the migration drops the table; the cron endpoints will fail
-- loudly on insert so it's visible.

CREATE TYPE notion_health_check_type AS ENUM ('schema_drift', 'retry_sweep');

CREATE TABLE notion_health_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_type notion_health_check_type NOT NULL,
  healthy boolean NOT NULL,
  schema_hash text,
  report jsonb NOT NULL DEFAULT '{}'::jsonb,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_notion_health_recent
  ON notion_health_state (check_type, created_at DESC);

-- Read-only for researchers (admins can also read). Writes are service-role
-- only — the cron endpoints use createAdminClient().
ALTER TABLE notion_health_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Researchers read notion health"
  ON notion_health_state FOR SELECT
  USING (
    is_admin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid()
        AND p.disabled = false
        AND p.role IN ('admin', 'researcher')
    )
  );

-- Convenience view: most recent row per check_type.
CREATE OR REPLACE VIEW notion_health_current AS
SELECT DISTINCT ON (check_type)
  id, check_type, healthy, schema_hash, report, duration_ms, created_at
FROM notion_health_state
ORDER BY check_type, created_at DESC;
