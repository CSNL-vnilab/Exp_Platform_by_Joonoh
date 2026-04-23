-- Add 'outbox_retry_sweep' to the notion_health_check_type enum so the
-- unified /api/cron/outbox-retry route (D6 service layer) can log its
-- sweep summary into notion_health_state without the INSERT failing
-- with `invalid input value for enum …`.
--
-- Postgres docs: ADD VALUE has to run OUTSIDE a transaction on some
-- servers. Use `IF NOT EXISTS` so this migration is safe to replay.

ALTER TYPE notion_health_check_type ADD VALUE IF NOT EXISTS 'outbox_retry_sweep';
