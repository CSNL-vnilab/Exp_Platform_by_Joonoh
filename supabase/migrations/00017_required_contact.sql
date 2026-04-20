-- Researchers must provide real contact info (phone + email) when their
-- account is created. The login "email" in profiles is synthetic
-- (`<username>@lab.local`), so a separate `contact_email` column holds
-- the real address surfaced on the booking confirmation page.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS contact_email text NOT NULL DEFAULT '';

-- Backfill phone if null (from the earlier migration that added it nullable)
UPDATE profiles SET phone = '' WHERE phone IS NULL;
ALTER TABLE profiles
  ALTER COLUMN phone SET NOT NULL,
  ALTER COLUMN phone SET DEFAULT '';

-- Registration-request carries them too so the approver can copy to the
-- profile in one shot.
ALTER TABLE registration_requests
  ADD COLUMN IF NOT EXISTS contact_email text NOT NULL DEFAULT '';

-- phone in registration_requests was added previously as nullable — keep it
-- nullable in case a request was already filed without one; enforce at API.
