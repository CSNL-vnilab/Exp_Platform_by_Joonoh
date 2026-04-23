-- D8 reviewer MED #2 — tighten the audit × researcher join so we only
-- notify researchers who actually ran sessions with the promoted
-- participant, not every researcher in the lab.
--
-- Before (00038 / 00040): `JOIN experiments e ON e.lab_id = audit.lab_id`
-- returned one candidate per (audit, every researcher with ≥1 exp in
-- the lab). A CSNL lab with 5 researchers → 5 emails per promotion,
-- 4 of them to people who never saw the participant.
--
-- After: join through bookings so only researchers with ≥1 completed
-- booking of the promoted participant (on an experiment they own)
-- surface as candidates. One email per relevant researcher.
--
-- Additional guards:
--   * booking.status = 'completed' — only researchers whose sessions
--     actually counted toward the promotion.
--   * DISTINCT(audit × researcher) — one email per researcher even if
--     they ran multiple of the participant's sessions.

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
      AND a.created_at > now() - interval '30 days'
  ),
  lab_meta AS (
    SELECT id, code FROM labs
  ),
  -- Only researchers whose experiments the participant actually ran
  -- sessions on (status='completed'). One row per (audit, researcher).
  audit_x_researcher AS (
    SELECT DISTINCT
      ar.audit_id, ar.participant_id, ar.lab_id,
      ar.previous_class, ar.new_class, ar.audit_created_at,
      e.created_by AS researcher_user_id
    FROM auto_royals ar
    JOIN bookings b
      ON b.participant_id = ar.participant_id
     AND b.status = 'completed'
    JOIN experiments e
      ON e.id = b.experiment_id
     AND e.lab_id = ar.lab_id
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
      AND cpn.error_message IS NULL
  )
    AND COALESCE(p.disabled, false) = false
    AND COALESCE(p.contact_email, p.email) IS NOT NULL
    AND length(btrim(COALESCE(p.contact_email, p.email))) > 0
  ORDER BY axr.audit_created_at ASC;
$$;

REVOKE EXECUTE ON FUNCTION pending_promotion_notifications()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pending_promotion_notifications()
  TO service_role;
