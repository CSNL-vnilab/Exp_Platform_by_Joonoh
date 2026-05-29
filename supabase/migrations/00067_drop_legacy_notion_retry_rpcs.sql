-- 00067 — drop the legacy notion-specific retry RPC pair.
--
-- Background (refactor-roadmap A5, 2026-05-29):
--
-- Migration 00032 introduced claim_next_notion_retry() and
-- finalize_notion_retry() with notion-specific scoping. Migration 00037
-- generalized them to claim_next_outbox_retry(p_types[]) and
-- finalize_outbox_retry() — same bodies, parameterized type
-- allowlist — and the /api/cron/notion-retry endpoint that exclusively
-- used the legacy pair was retired in favor of /api/cron/outbox-retry.
--
-- The legacy RPCs stayed defined for "backward compatibility" through
-- 2026-05-28 but:
--   * the only caller, notion-retry.service.ts:claimNextRetry, has zero
--     external references (deleted in the same commit as this
--     migration);
--   * notion-retry.service.ts:finalize() now calls
--     finalize_outbox_retry — same body, same write semantics;
--   * keeping two parallel claim functions on the same table risks
--     a future cron wiring (or operator script) double-bumping the
--     attempts column when both are run.
--
-- Drop them now. No data migration needed — both functions only mutate
-- booking_integrations rows in ways the generalized functions already
-- cover, and the table itself is unchanged.

DROP FUNCTION IF EXISTS claim_next_notion_retry();
DROP FUNCTION IF EXISTS finalize_notion_retry(
  uuid, integration_status, text, text
);
