-- Add optional phone number to registration_requests and profiles.
-- phone is carried from the signup form → stored in registration_requests
-- → written to profiles.phone at approval time.

ALTER TABLE registration_requests
  ADD COLUMN IF NOT EXISTS phone text;

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS phone text;
