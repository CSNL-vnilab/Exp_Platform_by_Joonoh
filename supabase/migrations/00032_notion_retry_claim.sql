-- Atomic Notion-retry claim.
--
-- Fixes D1 reviewer findings:
--   C1 (duplicate Notion page race) — multiple cron invocations overlap
--       and both read booking_integrations where status='failed'.
--       Without serialization, both call createBookingPage and create
--       duplicate Notion pages. Fix: SELECT … FOR UPDATE SKIP LOCKED
--       inside the single UPDATE that bumps attempts, so only one worker
--       ever wins the claim on a row.
--   H1 (double-count on recovery) — old `markOutbox` bumped attempts on
--       both success and failure. Fix: bump happens ONCE at claim time.
--       Subsequent finalize-outbox writes status only, not attempts.
--   H2 (backoff bypass on null processed_at) — rows that were seeded but
--       never attempted could be retried every cron tick. Fix: encode
--       backoff in the claim predicate; rows with NULL processed_at are
--       only claimable if attempts=0 (never tried) AND status='failed'
--       (already seeded-and-failed).
--
-- Backoff schedule (minutes since processed_at):
--   attempts=1 → 5
--   attempts=2 → 30
--   attempts=3 → 120
--   attempts=4 → 480
-- attempts=0 is immediately eligible (first retry of a just-failed row).
-- attempts>=5 is the kill threshold (not claimable).
--
-- Called by /api/cron/notion-retry in a loop until it returns null.
-- Each successful claim must eventually be followed by an UPDATE of
-- status (completed|failed) by the caller; we do NOT touch status here
-- — the row stays in 'failed' during the claim window so concurrent
-- workers see the updated attempts+processed_at and back off.

CREATE OR REPLACE FUNCTION claim_next_notion_retry()
RETURNS SETOF booking_integrations
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
    WHERE integration_type IN ('notion', 'notion_survey')
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

-- Finalize outcome helper — the retry cron calls this after the Notion
-- work completes (or errors). No attempts bump here; it happens at claim.
CREATE OR REPLACE FUNCTION finalize_notion_retry(
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
