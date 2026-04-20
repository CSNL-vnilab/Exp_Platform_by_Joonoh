-- profiles: one row per auth.users, carries display_name + role.
-- New signups default to 'researcher'. Admins can be promoted manually
-- (via admin UI) or by a bootstrap script.

CREATE TYPE user_role AS ENUM ('admin', 'researcher');

CREATE TABLE profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text NOT NULL,
  display_name text,
  role user_role NOT NULL DEFAULT 'researcher',
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_profiles_role ON profiles(role);
CREATE INDEX idx_profiles_email ON profiles(email);

CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- Auto-provision a profile row whenever a user signs up.
-- display_name is pulled from raw_user_meta_data.display_name when present.
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO profiles (id, email, display_name)
  VALUES (
    NEW.id,
    NEW.email,
    NULLIF(NEW.raw_user_meta_data->>'display_name', '')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION handle_new_user();

-- is_admin: convenience helper usable in RLS policies.
-- SECURITY DEFINER so policies can consult it without leaking profiles.
CREATE OR REPLACE FUNCTION is_admin(uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE profiles.id = uid
      AND profiles.role = 'admin'
      AND profiles.disabled = false
  );
$$;

-- Backfill profiles for any auth.users created before this migration.
INSERT INTO profiles (id, email, display_name)
SELECT u.id, u.email, u.raw_user_meta_data->>'display_name'
FROM auth.users u
ON CONFLICT (id) DO NOTHING;

-- profiles RLS
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own profile"
  ON profiles FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "Admins read all profiles"
  ON profiles FOR SELECT
  USING (is_admin(auth.uid()));

CREATE POLICY "Users update own display_name"
  ON profiles FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (
    auth.uid() = id
    AND role = (SELECT role FROM profiles WHERE id = auth.uid())
    AND disabled = (SELECT disabled FROM profiles WHERE id = auth.uid())
  );

-- Admins can modify role/disabled on any profile. Direct profile inserts
-- are disabled; creation flows exclusively through the auth.users trigger.
CREATE POLICY "Admins update any profile"
  ON profiles FOR UPDATE
  USING (is_admin(auth.uid()))
  WITH CHECK (is_admin(auth.uid()));
