-- Notion relation plumbing: researcher ↔ Members DB + experiment ↔
-- Projects & Chores DB.
--
-- Background: the SLab Notion DB has two relation columns:
--   * 실험자     → Members  (94854705-c91d-4a35-a91e-803c5934745e)
--   * 프로젝트 (관련) → Projects & Chores (76e7c392-127e-47f3-8b7e-212610db9376)
--
-- To populate these relations we need page_ids from those external DBs.
-- This migration adds two lookup-id columns so an admin can map each
-- researcher profile to their Members row AND each experiment to its
-- Projects & Chores row. Unpopulated → relation is written as empty
-- (no-op), so rollout can be incremental.
--
-- A fully automatic name-matching system would be brittle (Members.이름
-- stores initials like "JHR", our profiles have display names in Korean
-- and login emails); storing the explicit page id is more reliable.
-- A follow-up sprint can add a researcher-self-serve UI to link their
-- Notion account (or an admin-side mapper).

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS notion_member_page_id text;

ALTER TABLE experiments
  ADD COLUMN IF NOT EXISTS notion_project_page_id text;

-- Length bounds (Notion page ids are 32-char hex with optional dashes,
-- totaling 32 or 36 chars). 64-char cap is generous.
ALTER TABLE profiles
  ADD CONSTRAINT profiles_notion_member_page_id_len
    CHECK (notion_member_page_id IS NULL OR length(notion_member_page_id) <= 64);
ALTER TABLE experiments
  ADD CONSTRAINT experiments_notion_project_page_id_len
    CHECK (notion_project_page_id IS NULL OR length(notion_project_page_id) <= 64);

COMMENT ON COLUMN profiles.notion_member_page_id IS
  'Notion page id in the CSNL Members database (94854705-...). Populates the 실험자 relation column on SLab booking rows.';
COMMENT ON COLUMN experiments.notion_project_page_id IS
  'Notion page id in Projects & Chores (76e7c392-...). Populates 프로젝트 (관련) relation on SLab booking rows.';
