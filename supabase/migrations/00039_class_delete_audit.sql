-- Close the audit-bypass gap for DELETE operations on participant_classes.
--
-- Migration 00029 added a trigger that auto-mirrors INSERTs into
-- participant_class_audit, so direct SQL INSERTs by admins can't
-- bypass the audit trail. DELETEs, however, still go unnoticed. The
-- table is append-only by design, but a rogue or mistaken admin
-- (opening Supabase Studio's SQL editor and running `DELETE FROM
-- participant_classes WHERE id = '…'`) would silently remove an
-- assignment without leaving a forensic trace.
--
-- Fix: BEFORE DELETE trigger that inserts a 'deleted' marker audit row.
-- We reuse the existing participant_class_audit schema with a sentinel
-- new_class equal to the row being deleted (so the schema's NOT NULL
-- constraint is satisfied) and changed_kind='manual', with a distinct
-- reason prefix ("DELETED: …") so readers can distinguish from normal
-- transitions.

CREATE OR REPLACE FUNCTION trg_participant_classes_delete_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO participant_class_audit (
    participant_id,
    lab_id,
    previous_class,
    new_class,
    reason,
    completed_count,
    changed_by,
    changed_kind
  ) VALUES (
    OLD.participant_id,
    OLD.lab_id,
    OLD.class,
    OLD.class,
    'DELETED: row id=' || OLD.id::text ||
      ' (by ' || COALESCE(current_user, '(unknown)') ||
      ') was_valid_from=' || OLD.valid_from::text,
    OLD.completed_count,
    NULL,
    'manual'
  );
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS participant_classes_delete_audit ON participant_classes;
CREATE TRIGGER participant_classes_delete_audit
  BEFORE DELETE ON participant_classes
  FOR EACH ROW
  EXECUTE FUNCTION trg_participant_classes_delete_audit();
