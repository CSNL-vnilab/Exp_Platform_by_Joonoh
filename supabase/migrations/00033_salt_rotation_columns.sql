-- Add columns supporting salt rotation for labs.participant_id_salt.
--
-- Operational motivation: 00030 locked service-role-only access to the
-- salt, but if the service role key is ever leaked we need a rotation
-- path that doesn't require a schema migration. Record the previous salt
-- alongside the new one so transient dual-read logic can validate HMACs
-- across the rotation window.
--
-- Rotation runbook lives at docs/salt-rotation.md. In summary:
--   1. generate 32 fresh bytes
--   2. UPDATE labs SET participant_id_salt_previous = participant_id_salt,
--                     participant_id_salt = <new>,
--                     salt_rotated_at = now()
--   3. for each row in participant_lab_identity, recompute identity_hmac
--      using the new salt + the participant's canonical inputs
--      (phone/birthdate/name) as defined in src/lib/participants/identity.ts
--   4. leave participant_id_salt_previous populated for 30d as a grace
--      window; then NULL it out in a follow-up rotation
--
-- Nothing in the app layer changes behaviour until the scripts/
-- salt-rotate.mjs runbook is executed. Adding the columns is
-- backward-compatible.

ALTER TABLE labs
  ADD COLUMN IF NOT EXISTS participant_id_salt_previous bytea,
  ADD COLUMN IF NOT EXISTS salt_rotated_at timestamptz;

-- Privilege inheritance: the 00030 REVOKE was on the whole labs table
-- then GRANT on specific columns. The new columns inherit the default
-- GRANT behaviour, which on Supabase means authenticated + anon CAN
-- read them. That re-introduces the 00029/00030 exposure. Fix: REVOKE
-- just the new column too.
REVOKE SELECT (participant_id_salt_previous) ON labs FROM anon, authenticated;

-- salt_rotated_at is non-sensitive — it's just a timestamp — so leave
-- readable by authenticated/anon. Useful for the /participants UI if we
-- ever want to surface "last rotated N days ago".
