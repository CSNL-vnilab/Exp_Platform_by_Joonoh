-- Participants table: stores participant information
CREATE TABLE participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  phone text NOT NULL,
  email text NOT NULL,
  gender text CHECK (gender IN ('male', 'female', 'other')),
  birthdate date NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- Same person identified by phone + email combination
CREATE UNIQUE INDEX idx_participants_phone_email ON participants(phone, email);
