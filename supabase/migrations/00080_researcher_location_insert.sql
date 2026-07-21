-- 00080 — let researchers CREATE experiment locations (address entry fix)
--
-- 실험 생성/등록 시 주소 입력이 안 되던 버그의 DB 절반. Before this, the
-- only policy on experiment_locations was "Admins manage locations"
-- (FOR ALL, admin-only, 00019), so a non-admin researcher creating an
-- experiment could pick an existing location from a dropdown but had NO
-- way to add a new address — the "+ 새 장소" link dead-ended at the
-- admin-gated /locations page. The app half (a shared inline modal in the
-- wizard) lands with the address fix; this migration opens INSERT so that
-- modal's POST /api/locations succeeds for researchers.
--
-- Split the single FOR ALL policy into UPDATE + DELETE (admin-only, as
-- before) and add an INSERT policy for any authenticated user that pins
-- created_by = auth.uid(). This does NOT over-grant: participants never
-- obtain a Supabase auth session in this app (accounts are created only by
-- admin approval; there is no self-serve signUp / anonymous sign-in), so
-- `authenticated` = researchers + admins only. POST /api/locations already
-- sets created_by = me.id, satisfying the WITH CHECK.
--
-- Also harden naver_url at the DB layer: now that any researcher can write
-- a location row (and its naver_url is rendered as an <a href> on the
-- participant confirm page), reject non-http(s) schemes (javascript:, etc.)
-- so a crafted row can't become stored XSS even via a direct PostgREST
-- write that bypasses the app's zod check. Added NOT VALID so the migration
-- never fails on any pre-existing prod row; it is enforced for every new /
-- updated row from here on (which is where the researcher-writable risk is).
--
-- Idempotent: DROP POLICY IF EXISTS before each CREATE; DROP CONSTRAINT
-- IF EXISTS before ADD.

DROP POLICY IF EXISTS "Admins manage locations" ON experiment_locations;

DROP POLICY IF EXISTS "Admins update locations" ON experiment_locations;
CREATE POLICY "Admins update locations" ON experiment_locations
  FOR UPDATE USING (is_admin(auth.uid())) WITH CHECK (is_admin(auth.uid()));

DROP POLICY IF EXISTS "Admins delete locations" ON experiment_locations;
CREATE POLICY "Admins delete locations" ON experiment_locations
  FOR DELETE USING (is_admin(auth.uid()));

DROP POLICY IF EXISTS "Researchers create locations" ON experiment_locations;
CREATE POLICY "Researchers create locations" ON experiment_locations
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL AND created_by = auth.uid());

-- The existing "Anyone reads locations" SELECT policy (00019) is left
-- untouched — public read is needed for the participant booking page.

ALTER TABLE experiment_locations
  DROP CONSTRAINT IF EXISTS experiment_locations_naver_url_scheme;
ALTER TABLE experiment_locations
  ADD CONSTRAINT experiment_locations_naver_url_scheme
  CHECK (naver_url IS NULL OR naver_url ~* '^https?://') NOT VALID;

NOTIFY pgrst, 'reload schema';
