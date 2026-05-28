-- Lab-wide IRB document URL — set once by admin, prefilled into the
-- per-experiment IRB URL field on /metadata-fill (and any future form
-- that asks for an IRB URL).
--
-- User directive 2026-05-28: IRB 는 admin 이 등록해둔 IRB 구글 드라이브
-- 주소를 불러올 수 있는 편리를 제공해줘야 함.
--
-- Single-string column on labs (one lab in this deployment; extensible
-- to per-lab values when more labs land). NULL = not configured;
-- /metadata-fill hides the "관리자 등록 IRB 사용" button when null.

ALTER TABLE labs
  ADD COLUMN irb_base_url text;

COMMENT ON COLUMN labs.irb_base_url IS
  'Lab-wide IRB document URL (typically a Google Drive folder). Admin sets via /lab-settings; researchers can one-click prefill experiments.irb_document_url from this value on /metadata-fill.';
