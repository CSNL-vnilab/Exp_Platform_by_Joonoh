-- registration_requests: researcher signup requests awaiting admin approval.
-- Password is stored encrypted (AES-256-GCM) so the admin approval path can
-- recover it and hand it to supabase.auth.admin.createUser. On approval or
-- rejection, the row is deleted.

CREATE TYPE registration_status AS ENUM ('pending', 'approved', 'rejected');

CREATE TABLE registration_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL,
  display_name text NOT NULL,
  password_cipher text NOT NULL,  -- base64(AES-256-GCM ciphertext)
  password_iv text NOT NULL,      -- base64(12-byte IV)
  password_tag text NOT NULL,     -- base64(GCM auth tag)
  status registration_status NOT NULL DEFAULT 'pending',
  requested_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  processed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  rejection_reason text,
  CONSTRAINT username_format CHECK (username ~ '^[a-z]{3,4}$'),
  CONSTRAINT display_name_length CHECK (char_length(display_name) BETWEEN 1 AND 60)
);

-- Only one pending request per username at a time.
CREATE UNIQUE INDEX idx_registration_requests_pending_username
  ON registration_requests (username)
  WHERE status = 'pending';

CREATE INDEX idx_registration_requests_status ON registration_requests(status);

ALTER TABLE registration_requests ENABLE ROW LEVEL SECURITY;

-- No public read/write. Service role (used in API handlers) bypasses RLS and
-- is the only path for insert/approve/reject. Admins read via service role
-- in admin API endpoints as well; we still add a policy so logged-in admins
-- can SELECT directly if ever needed.
CREATE POLICY "Admins read all registration requests"
  ON registration_requests FOR SELECT
  USING (is_admin(auth.uid()));
