-- Admin-owned experiments are always treated as tests.
--
-- User directive 2026-05-28: CSNL 은 연구원이 아니라 관리자 계정이고,
-- csnl 계정 내 실험은 모두 테스트라고 간주해야 한다. The admin account
-- gets used for fixtures, system smoke-tests, manual one-off bookings,
-- and other ops work — none of those are real research projects, so
-- they should never show up in the metadata-fill nag flow.
--
-- This migration enforces the policy in two layers:
--   1. Retroactive UPDATE: every existing experiment where created_by
--      is an admin gets is_project = false.
--   2. BEFORE INSERT trigger: any future experiment whose created_by
--      resolves to an admin profile gets is_project = false even if
--      the INSERT explicitly passed is_project = true. The trigger
--      overrides — admin-owned == test, by policy.
--
-- The reminder cron + interview email lib (`buildResearcherGapInventory`)
-- additionally drop admins entirely from the recipient sweep; this
-- migration handles the *data* side so the UI / weekly cron / any
-- future surface filtering by `is_project=true` also sees admin rows
-- as non-projects.

-- 1. Retroactive update.
UPDATE experiments e
SET is_project = false
FROM profiles p
WHERE e.created_by = p.id
  AND p.role = 'admin'
  AND e.is_project = true;

-- 2. Trigger function. SECURITY DEFINER so the trigger sees the
-- profiles row regardless of which RLS context the INSERT ran under.
CREATE OR REPLACE FUNCTION mark_admin_experiments_as_test()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.created_by IS NULL THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM profiles WHERE id = NEW.created_by AND role = 'admin'
  ) THEN
    NEW.is_project := false;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_admin_experiments_as_test ON experiments;
CREATE TRIGGER trg_admin_experiments_as_test
  BEFORE INSERT ON experiments
  FOR EACH ROW
  EXECUTE FUNCTION mark_admin_experiments_as_test();

COMMENT ON FUNCTION mark_admin_experiments_as_test() IS
  '관리자(role=admin)가 만든 experiments 행을 is_project=false 로 자동 표시. 2026-05-28 directive — admin 계정 작업은 항상 테스트로 간주.';
