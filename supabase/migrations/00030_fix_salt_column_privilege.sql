-- 00029 issued column-level REVOKEs to keep `labs.participant_id_salt`
-- unreadable by anon/authenticated, but Supabase grants table-wide SELECT
-- on every public table to those roles by default. Column-level REVOKE
-- cannot override a table-level GRANT in Postgres — only column-level
-- GRANTs override. `has_column_privilege('authenticated', 'labs.participant_id_salt', 'SELECT')`
-- returned true post-00029 confirming the REVOKE was a no-op.
--
-- Fix: REVOKE the table-wide SELECT and re-GRANT column-by-column,
-- excluding `participant_id_salt`. service_role keeps its implicit grant
-- (it is SUPERUSER-like in Supabase) so createAdminClient() reads of the
-- salt continue to work for server-side identity generation.
--
-- Idempotent: REVOKE + GRANT operations commute and can be reapplied.

REVOKE SELECT ON TABLE labs FROM anon, authenticated;

GRANT SELECT (id, code, name, created_at) ON TABLE labs TO anon, authenticated;
