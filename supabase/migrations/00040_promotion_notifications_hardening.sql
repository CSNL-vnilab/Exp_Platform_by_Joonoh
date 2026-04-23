-- D8 reviewer hardening.
--
-- Fixes to migration 00038 surfaced by strict review round:
--   * H1 (failure treated as delivered) — cron inserts a
--     class_promotion_notifications row on Gmail transient errors with
--     error_message set. The RPC's NOT EXISTS dedup didn't filter on
--     error_message, so a 429'd send was permanently recorded as
--     processed. Add `AND cpn.error_message IS NULL` so failed rows
--     are revisited on next sweep.
--   * H7 (persistent skip) — same issue for missing researcher email.
--     Instead of inserting a tracking row with empty email_to (which
--     then sticks forever even after the researcher fills contact_email),
--     return those rows to the caller; the application layer decides
--     not to insert a tracking row for missing-email cases. Add
--     `AND researcher_contact_email IS NOT NULL` to the RPC predicate
--     so the researcher-without-email rows simply don't appear as
--     candidates until contact_email is set.
--   * M3 (7-day audit window too short) — widen to 30 days. Dedup
--     via the tracking table is authoritative; window is only a safety
--     bound against infinite scans.
--   * L9 (RLS disabled-researcher hole) — add disabled=false gate to
--     the SELECT policy on class_promotion_notifications, matching
--     participant_lab_identity / notion_health_state convention.
--
-- Idempotent — drops + recreates the function and policy.

CREATE OR REPLACE FUNCTION pending_promotion_notifications()
RETURNS TABLE (
  audit_id uuid,
  participant_id uuid,
  lab_id uuid,
  lab_code text,
  new_class participant_class,
  previous_class participant_class,
  audit_created_at timestamptz,
  researcher_user_id uuid,
  researcher_contact_email text,
  researcher_display_name text,
  public_code text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH auto_royals AS (
    SELECT a.id AS audit_id,
           a.participant_id,
           a.lab_id,
           a.previous_class,
           a.new_class,
           a.created_at AS audit_created_at
    FROM participant_class_audit a
    WHERE a.changed_kind = 'auto'
      AND a.new_class = 'royal'
      AND a.created_at > now() - interval '30 days'   -- M3: widened
  ),
  lab_meta AS (
    SELECT id, code FROM labs
  ),
  audit_x_researcher AS (
    SELECT DISTINCT
      ar.audit_id, ar.participant_id, ar.lab_id,
      ar.previous_class, ar.new_class, ar.audit_created_at,
      e.created_by AS researcher_user_id
    FROM auto_royals ar
    JOIN experiments e ON e.lab_id = ar.lab_id
    WHERE e.created_by IS NOT NULL
  )
  SELECT
    axr.audit_id,
    axr.participant_id,
    axr.lab_id,
    lm.code AS lab_code,
    axr.new_class,
    axr.previous_class,
    axr.audit_created_at,
    axr.researcher_user_id,
    COALESCE(p.contact_email, p.email) AS researcher_contact_email,
    p.display_name AS researcher_display_name,
    pli.public_code
  FROM audit_x_researcher axr
  JOIN profiles p ON p.id = axr.researcher_user_id
  JOIN lab_meta lm ON lm.id = axr.lab_id
  LEFT JOIN participant_lab_identity pli
    ON pli.participant_id = axr.participant_id AND pli.lab_id = axr.lab_id
  WHERE NOT EXISTS (
    SELECT 1 FROM class_promotion_notifications cpn
    WHERE cpn.audit_id = axr.audit_id
      AND cpn.researcher_user_id = axr.researcher_user_id
      AND cpn.error_message IS NULL          -- H1: only skip delivered rows
  )
    AND COALESCE(p.disabled, false) = false
    -- H7: missing researcher email = not a candidate. If the researcher
    -- sets contact_email later, the row reappears naturally.
    AND COALESCE(p.contact_email, p.email) IS NOT NULL
    AND length(btrim(COALESCE(p.contact_email, p.email))) > 0
  ORDER BY axr.audit_created_at ASC;
$$;

-- L9: tighten RLS to match the disabled-researcher convention.
DROP POLICY IF EXISTS "Researchers read their own promotion notifications"
  ON class_promotion_notifications;

CREATE POLICY "Researchers read their own promotion notifications"
  ON class_promotion_notifications FOR SELECT
  USING (
    (
      researcher_user_id = auth.uid()
      AND EXISTS (
        SELECT 1 FROM profiles
        WHERE id = auth.uid() AND disabled = false
      )
    )
    OR is_admin(auth.uid())
  );

-- Grant execute stays unchanged (service_role only).
REVOKE EXECUTE ON FUNCTION pending_promotion_notifications()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pending_promotion_notifications()
  TO service_role;
