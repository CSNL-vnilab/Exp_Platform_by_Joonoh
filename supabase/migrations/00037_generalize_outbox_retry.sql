-- Generalise the Notion retry claim to cover all integration_type
-- values (gcal, email, sms, notion, notion_survey, notion_experiment).
--
-- Previously `claim_next_notion_retry()` was hardcoded to filter by
-- ('notion','notion_survey'). Gmail / Google Calendar / Solapi SMS
-- failures lived in `booking_integrations` with status='failed' but
-- no worker ever ran — a transient Gmail rate limit could mean a
-- participant silently never gets their confirmation email.
--
-- Design:
--   * New `claim_next_outbox_retry(p_types integration_type[])`
--     parameterised function — same SELECT … FOR UPDATE SKIP LOCKED
--     pattern as 00032, but the caller provides the type filter.
--   * Backoff schedule reused from 00032. GCal / email are flakier
--     upstreams; we'd tune per-type later if needed.
--   * `claim_next_notion_retry` is kept as a thin wrapper for
--     backward-compatibility with the existing /api/cron/notion-retry
--     until that cron is replaced by the generic outbox-retry cron.
--   * `finalize_notion_retry` (00032) is rebranded to
--     `finalize_outbox_retry` — same function, just drop the "notion"
--     scoping name.
--
-- No data migration needed; this is pure DDL.

CREATE OR REPLACE FUNCTION claim_next_outbox_retry(
  p_types integration_type[]
) RETURNS SETOF booking_integrations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE booking_integrations
  SET attempts = attempts + 1,
      processed_at = now()
  WHERE id = (
    SELECT id FROM booking_integrations
    WHERE integration_type = ANY(p_types)
      AND status = 'failed'
      AND attempts < 5
      AND (
        processed_at IS NULL
        OR processed_at < now() - (
          CASE attempts
            WHEN 1 THEN interval '5 minutes'
            WHEN 2 THEN interval '30 minutes'
            WHEN 3 THEN interval '120 minutes'
            WHEN 4 THEN interval '480 minutes'
            ELSE interval '0'
          END
        )
      )
    ORDER BY processed_at ASC NULLS FIRST, created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING *;
END;
$$;

-- Rename for semantic clarity. Same body as 00032 finalize_notion_retry.
CREATE OR REPLACE FUNCTION finalize_outbox_retry(
  p_integration_id uuid,
  p_status integration_status,
  p_external_id text,
  p_last_error text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE booking_integrations
  SET status = p_status,
      external_id = COALESCE(p_external_id, external_id),
      last_error = p_last_error,
      processed_at = now()
  WHERE id = p_integration_id;
END;
$$;

-- Backward-compatible wrappers so /api/cron/notion-retry (which this
-- migration does NOT modify) keeps working until we swap it.
CREATE OR REPLACE FUNCTION claim_next_notion_retry()
RETURNS SETOF booking_integrations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY SELECT * FROM claim_next_outbox_retry(
    ARRAY['notion', 'notion_survey']::integration_type[]
  );
END;
$$;

-- Privileges: claim/finalize RPCs are internal only — no API route
-- should call these without an already-authenticated cron secret check.
REVOKE EXECUTE ON FUNCTION claim_next_outbox_retry(integration_type[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_next_outbox_retry(integration_type[])
  TO service_role;

REVOKE EXECUTE ON FUNCTION finalize_outbox_retry(uuid, integration_status, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION finalize_outbox_retry(uuid, integration_status, text, text)
  TO service_role;

-- claim_next_notion_retry already in the wild — lock it down too.
REVOKE EXECUTE ON FUNCTION claim_next_notion_retry()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_next_notion_retry()
  TO service_role;

REVOKE EXECUTE ON FUNCTION finalize_notion_retry(uuid, integration_status, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION finalize_notion_retry(uuid, integration_status, text, text)
  TO service_role;
