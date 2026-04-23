-- Stream 3: post-experiment payment settlement (실험참여자비 정산).
--
-- After a participant completes all sessions in a booking group we need to
-- collect the info the lab admin (행정 선생님) requires to actually disburse
-- payment:
--   * 주민등록번호 (RRN) — 13-digit resident reg number, sensitive PII
--   * bank + account + account holder
--   * a drawn e-signature (PNG)
--   * the activity period (derived from bookings)
--
-- That data then powers two Excel files that mirror the existing lab_chore
-- templates (실험참여자비 양식(중견).xlsx + 일회성경비지급자 업로드양식.xlsx).
--
-- Design choices:
--
-- 1. RRN is AES-256-GCM encrypted at rest in three columns (cipher, iv, tag)
--    with a separate key kept in PAYMENT_INFO_KEY env. rrn_key_version lets
--    us rotate the key: new rows use the current version; a background job
--    can decrypt-with-old / encrypt-with-new to migrate. Never decrypted
--    except during Excel export, never surfaced in any UI.
--
-- 2. Token flow follows 00023's Stream 2 pattern: HMAC-SHA256 signed token
--    is issued at booking-confirm time, the SHA-256 hash of that token is
--    persisted here. Verification is stateless (cheap) then the DB is
--    checked (revocation). TTL is 60 days — participants may be slow to
--    fill in RRN, and fees sometimes get paid late.
--
-- 3. One row per booking_group (i.e. one per participant per experiment
--    participation). The row is seeded at booking-confirm time with status
--    'pending_participant' and no PII. Submission fills in the PII and
--    flips status to 'submitted_to_admin'. Researcher marks 'paid' after
--    disbursement.
--
-- 4. Signature PNGs live in a private Storage bucket
--    participant-signatures/{experiment_id}/{booking_group_id}.png with
--    a researcher-only SELECT policy. Writes happen service-role from the
--    submit endpoint (token-gated), never from a participant cookie.
--
-- 5. payment_exports records every Excel generation for audit (who, when,
--    which experiment, how many participants). Visible to researchers of
--    the experiment and admins.
--
-- Ships AFTER 00023 (Stream 2). Stream 1 (00022) owns metadata, Stream 2
-- (00023) owns online-runtime, Stream 3 (this) owns payment settlement.

-- ── enum: payment_status ──────────────────────────────────────────────────
-- State machine:
--   pending_participant
--     → (participant submits form)  → submitted_to_admin
--     → (researcher clicks "참여자비 청구") → claimed
--     → (admin confirms money sent) → paid
--
-- 'claimed' exists so the researcher can always see "who is ready to
-- claim" vs "already claimed but not yet paid"; the bundle endpoint
-- only picks up rows in submitted_to_admin, transitions them to claimed,
-- and writes a payment_claims row.
CREATE TYPE payment_status AS ENUM (
  'pending_participant',
  'submitted_to_admin',
  'claimed',
  'paid'
);

-- ── participant_payment_info ──────────────────────────────────────────────
CREATE TABLE participant_payment_info (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  experiment_id  uuid NOT NULL REFERENCES experiments(id)  ON DELETE CASCADE,
  -- Exactly one payment row per booking group (multi-session = one row
  -- spanning N bookings). UNIQUE enforces the 1:1 invariant.
  booking_group_id uuid NOT NULL UNIQUE,

  -- RRN encrypted-at-rest triple + key version for rotation.
  rrn_cipher      bytea,
  rrn_iv          bytea,
  rrn_tag         bytea,
  rrn_key_version smallint NOT NULL DEFAULT 1,

  -- Bank info — not classified as strictly as RRN, but still only exposed
  -- to researchers who own the experiment. Stored plaintext so the admin
  -- UI can confirm "did participant X submit already" without a decrypt
  -- round-trip.
  bank_name      text,
  account_number text,
  account_holder text,  -- 예금주 (defaults to participant name)

  -- Institution (소속) — defaults to 서울대학교 but the participant can
  -- override on the form. Needed for the Excel "소속" column (D16).
  institution text,

  -- Signature path in the Storage bucket (not the raw bytes).
  signature_path text,
  signed_at      timestamptz,

  -- Bank book scan (통장사본) uploaded by the participant. PDF / PNG / JPEG.
  -- Stored in the participant-bankbooks bucket as
  --   participant-bankbooks/{experiment_id}/{booking_group_id}.{ext}
  -- so a folder-per-experiment RLS policy can scope access to the
  -- experiment's owner and to admins.
  bankbook_path      text,
  bankbook_mime_type text,

  -- Activity period — populated from MIN/MAX of booking slot_start/slot_end
  -- at seed time, so researcher can generate the Excel even after bookings
  -- are edited.
  period_start date,
  period_end   date,

  -- 지급액 in KRW. Default = sum of experiment.participation_fee across the
  -- confirmed sessions in this booking group; researcher can override on
  -- the admin UI.
  amount_krw integer NOT NULL DEFAULT 0,

  -- Signed-token scheme (Stream 2 pattern). Only the SHA-256 hash of the
  -- plaintext token is stored — revocable, non-reversible.
  token_hash       text NOT NULL,
  token_issued_at  timestamptz NOT NULL DEFAULT now(),
  token_expires_at timestamptz NOT NULL,
  token_revoked_at timestamptz,

  status payment_status NOT NULL DEFAULT 'pending_participant',
  submitted_at timestamptz,

  -- "청구" — researcher grouped this participant into a claim bundle to
  -- hand to 행정 선생님. claimed_in points to payment_claims.id so we can
  -- regenerate the same Excel bundle later if admin asks for a copy.
  claimed_at   timestamptz,
  claimed_by   uuid REFERENCES profiles(id) ON DELETE SET NULL,
  claimed_in   uuid,

  paid_at      timestamptz,
  paid_by      uuid REFERENCES profiles(id) ON DELETE SET NULL,

  -- Whether the amount was manually overridden by the researcher. Used by
  -- the researcher UI to flag "this no longer matches fee × sessions" so
  -- nobody is confused. The override value lives in amount_krw.
  amount_overridden boolean NOT NULL DEFAULT false,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- Shape sanity: if any part of the RRN blob is set, all three must be.
  CONSTRAINT payment_info_rrn_complete CHECK (
    (rrn_cipher IS NULL AND rrn_iv IS NULL AND rrn_tag IS NULL)
    OR (rrn_cipher IS NOT NULL AND rrn_iv IS NOT NULL AND rrn_tag IS NOT NULL)
  ),
  -- If submitted, we must have the full PII bundle (incl. bankbook image).
  CONSTRAINT payment_info_submitted_requires_pii CHECK (
    status = 'pending_participant'
    OR (
      rrn_cipher IS NOT NULL
      AND bank_name IS NOT NULL
      AND account_number IS NOT NULL
      AND signature_path IS NOT NULL
      AND signed_at IS NOT NULL
      AND bankbook_path IS NOT NULL
    )
  ),
  CONSTRAINT payment_info_claimed_has_claim CHECK (
    (status IN ('claimed', 'paid'))
      = (claimed_at IS NOT NULL)
  ),
  CONSTRAINT payment_info_amount_nonneg CHECK (amount_krw >= 0)
);

CREATE INDEX idx_payment_info_token_hash ON participant_payment_info(token_hash);
CREATE INDEX idx_payment_info_experiment ON participant_payment_info(experiment_id);
CREATE INDEX idx_payment_info_participant ON participant_payment_info(participant_id);
CREATE INDEX idx_payment_info_status
  ON participant_payment_info(experiment_id, status);

CREATE TRIGGER participant_payment_info_updated_at
  BEFORE UPDATE ON participant_payment_info
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE participant_payment_info ENABLE ROW LEVEL SECURITY;

-- Admins: full control.
CREATE POLICY "Admins manage payment info"
  ON participant_payment_info FOR ALL
  USING (is_admin(auth.uid()))
  WITH CHECK (is_admin(auth.uid()));

-- Researchers: SELECT + UPDATE for their own experiments. Participant
-- submission goes through service-role (token-gated), not through RLS.
CREATE POLICY "Researchers read own payment info"
  ON participant_payment_info FOR SELECT
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM experiments e
    WHERE e.id = participant_payment_info.experiment_id
      AND e.created_by = auth.uid()
  ));

CREATE POLICY "Researchers update own payment info"
  ON participant_payment_info FOR UPDATE
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM experiments e
    WHERE e.id = participant_payment_info.experiment_id
      AND e.created_by = auth.uid()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM experiments e
    WHERE e.id = participant_payment_info.experiment_id
      AND e.created_by = auth.uid()
  ));

-- ── payment_exports: audit log of every Excel generation ──────────────────
CREATE TABLE payment_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  exported_by   uuid REFERENCES profiles(id) ON DELETE SET NULL,
  -- Which flavour of Excel was generated:
  --   individual_form — 실험참여자비 양식_이름.xlsx (per participant)
  --   upload_form     — 일회성경비지급자 업로드양식_작성.xlsx (combined)
  --   both            — zipped bundle of all of the above
  export_kind text NOT NULL CHECK (
    export_kind IN ('individual_form', 'upload_form', 'both', 'claim_bundle')
  ),
  participant_count integer NOT NULL DEFAULT 0,
  participant_ids   uuid[]  NOT NULL DEFAULT '{}',
  file_name text,
  exported_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_payment_exports_experiment
  ON payment_exports(experiment_id, exported_at DESC);
CREATE INDEX idx_payment_exports_by
  ON payment_exports(exported_by, exported_at DESC);

ALTER TABLE payment_exports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins read all export logs"
  ON payment_exports FOR SELECT
  USING (is_admin(auth.uid()));

CREATE POLICY "Researchers read own export logs"
  ON payment_exports FOR SELECT
  TO authenticated
  USING (
    exported_by = auth.uid()
    OR EXISTS (
      SELECT 1 FROM experiments e
      WHERE e.id = payment_exports.experiment_id
        AND e.created_by = auth.uid()
    )
  );

-- ── payment_claims: one row per "참여자비 청구" click ────────────────────
-- Each row records a researcher's claim event — which experiment, who
-- clicked, how many participants, and the list of booking_group_ids. The
-- claim row is the source of truth for "re-download this exact bundle"
-- later; payment_info rows link back via claimed_in.
CREATE TABLE payment_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  claimed_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  booking_group_ids uuid[] NOT NULL DEFAULT '{}',
  participant_count integer NOT NULL DEFAULT 0,
  total_krw bigint NOT NULL DEFAULT 0,
  file_name text,
  notes text
);

CREATE INDEX idx_payment_claims_experiment
  ON payment_claims(experiment_id, claimed_at DESC);

ALTER TABLE payment_claims ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins read all claims"
  ON payment_claims FOR SELECT
  USING (is_admin(auth.uid()));

CREATE POLICY "Researchers read own claims"
  ON payment_claims FOR SELECT
  TO authenticated
  USING (
    claimed_by = auth.uid()
    OR EXISTS (
      SELECT 1 FROM experiments e
      WHERE e.id = payment_claims.experiment_id
        AND e.created_by = auth.uid()
    )
  );

-- Back-fill FK (after the table exists).
ALTER TABLE participant_payment_info
  ADD CONSTRAINT participant_payment_info_claimed_in_fkey
  FOREIGN KEY (claimed_in) REFERENCES payment_claims(id) ON DELETE SET NULL;

-- ── Storage bucket: participant-signatures ────────────────────────────────
-- Private, PNG-only, 512 KiB cap — drawn signatures are a few KB.
-- Object path: participant-signatures/{experiment_id}/{booking_group_id}.png
-- Writes are service-role only (token-gated submit endpoint).

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'participant-signatures',
  'participant-signatures',
  false,
  524288,
  ARRAY['image/png']
)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Researchers read own participant signatures"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'participant-signatures'
    AND EXISTS (
      SELECT 1 FROM experiments e
      WHERE e.id::text = (storage.foldername(name))[1]
        AND (e.created_by = auth.uid() OR is_admin(auth.uid()))
    )
  );

-- ── Storage bucket: participant-bankbooks ─────────────────────────────────
-- Private, PDF/PNG/JPEG, 5 MiB cap — bank book scans are typically a
-- single page.
-- Object path: participant-bankbooks/{experiment_id}/{booking_group_id}.{ext}
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'participant-bankbooks',
  'participant-bankbooks',
  false,
  5242880, -- 5 MiB
  ARRAY['image/png', 'image/jpeg', 'application/pdf']
)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Researchers read own participant bankbooks"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'participant-bankbooks'
    AND EXISTS (
      SELECT 1 FROM experiments e
      WHERE e.id::text = (storage.foldername(name))[1]
        AND (e.created_by = auth.uid() OR is_admin(auth.uid()))
    )
  );
