-- 00082 — drop dead DB objects (hygiene)
--
-- Two objects verified unused (introspection + repo-wide grep):
--
-- 1. notification_log (table, created 00004) — 0 rows in prod, NO writer
--    or reader anywhere in src/ or scripts/ (its only src reference was the
--    generated type in database.ts, removed in the same release). Superseded
--    by the reminders table + booking_integrations outbox pattern. No inbound
--    FK, no view, so DROP TABLE succeeds without CASCADE (its RLS policy +
--    index drop with it). NOTE: the 노쇼 wipe audit uses the NEW
--    booking_wipe_audit table (00079), not this one — no dependency.
--
-- 2. reset_payment_link_dispatch(uuid) (RPC, 00051) — a SECURITY DEFINER
--    "manual resend" entry point with GRANT to authenticated but ZERO
--    callers repo-wide (no .rpc('reset_payment_link_dispatch') anywhere).
--    A state-mutating function reachable by any authenticated user with no
--    caller = needless attack surface. The single-uuid overload is named
--    precisely so the drop is unambiguous.
--
-- DESTRUCTIVE — applied LAST (after all code that could reference these is
-- out of production). Idempotent: DROP ... IF EXISTS.

DROP TABLE IF EXISTS notification_log;

DROP FUNCTION IF EXISTS reset_payment_link_dispatch(uuid);

NOTIFY pgrst, 'reload schema';
