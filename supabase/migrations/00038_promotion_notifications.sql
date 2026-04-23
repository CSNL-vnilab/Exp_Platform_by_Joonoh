-- D8: outbox for auto-promotion notification emails.
--
-- Participants auto-promote to Royal when they hit 15 completed bookings
-- in a lab (migration 00025 recompute trigger). Today this is silent —
-- researchers only find out by opening the participant detail page.
-- This migration adds a tracking table so a cron can identify un-notified
-- auto-promotions and send one email per researcher per day.
--
-- Design:
--   * Source of truth is participant_class_audit (already append-only).
--     We don't duplicate the transition data here.
--   * `class_promotion_notifications` has one row per audit row we've
--     sent an email about. Unique on (audit_id, researcher_user_id) so
--     if an experiment has N researchers we can notify each independently.
--   * Cron query: audit rows from last 7 days where (changed_kind='auto'
--     AND new_class='royal'), not yet notified for the caller.
--
-- Reverting: drops the tracking table. Past notifications stay sent; the
-- cron just can't tell which audit rows it handled, so re-running it
-- would double-send. Mitigation: wait 7+ days before re-enabling (the
-- source audit window is 7d).

CREATE TABLE class_promotion_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id uuid NOT NULL REFERENCES participant_class_audit(id) ON DELETE CASCADE,
  researcher_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  sent_at timestamptz NOT NULL DEFAULT now(),
  email_to text NOT NULL,
  error_message text,
  UNIQUE (audit_id, researcher_user_id)
);

CREATE INDEX idx_cpn_researcher_sent
  ON class_promotion_notifications (researcher_user_id, sent_at DESC);

ALTER TABLE class_promotion_notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Researchers read their own promotion notifications"
  ON class_promotion_notifications FOR SELECT
  USING (researcher_user_id = auth.uid() OR is_admin(auth.uid()));

-- Writes are service-role only (cron inserts after SMTP sends).

-- Helper: pending-notification candidates. Returns one row per audit ×
-- researcher combination where the email hasn't been sent yet.
-- Used by /api/cron/promotion-notifications to build its work list.
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
      AND a.created_at > now() - interval '7 days'
  ),
  lab_meta AS (
    SELECT id, code FROM labs
  ),
  -- One row per (audit, researcher-owner-of-any-experiment-in-the-lab)
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
  )
    AND COALESCE(p.disabled, false) = false
  ORDER BY axr.audit_created_at ASC;
$$;

REVOKE EXECUTE ON FUNCTION pending_promotion_notifications()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pending_promotion_notifications()
  TO service_role;
