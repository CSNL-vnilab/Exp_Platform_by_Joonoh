-- Extend the platform from offline-only to a hybrid model that also hosts
-- remote JavaScript experiments (Prolific-style). Adds the experiment-mode
-- taxonomy, the runtime-config shape the /run shell reads, the signed-token +
-- per-block progress tracker that participant data uploads authenticate
-- against, and the private Storage bucket receiving the raw JSON blocks.
--
-- Shipping AFTER 00022 (experiment metadata). Stream 1 owns metadata,
-- Stream 2 (this) owns the online runtime.
--
-- Booking state machine gains:
--   confirmed → running    (participant opens the /run page, token issued)
--   running   → completed  (researcher verifies the completion_code)

-- ── experiment_mode ───────────────────────────────────────────────────────
-- offline  — traditional in-lab session (default; preserves existing rows)
-- online   — remote-only, no physical slot needed but we still reuse
--            bookings as the per-session row so reminders/consent flow
--            remain unified
-- hybrid   — starts online (screening + a short online task), then the
--            participant shows up in-lab for the main session. The offline
--            part uses the normal slot picker; the online part uses /run.

CREATE TYPE experiment_mode AS ENUM ('offline', 'online', 'hybrid');

ALTER TABLE experiments
  ADD COLUMN experiment_mode experiment_mode NOT NULL DEFAULT 'offline',
  -- Shape: { entry_url, trial_count, block_count, estimated_minutes,
  --          completion_token_format }. Required when mode != 'offline'.
  ADD COLUMN online_runtime_config jsonb,
  -- Whether the booking flow must show a consent-to-data-collection
  -- checkbox that references irb_document_url. Distinct from precautions
  -- because this is a hard legal gate, not a screening criterion.
  ADD COLUMN data_consent_required boolean NOT NULL DEFAULT false;

-- Shape guard on online_runtime_config: null OR object.
ALTER TABLE experiments
  ADD CONSTRAINT experiments_online_config_shape
    CHECK (
      online_runtime_config IS NULL
      OR jsonb_typeof(online_runtime_config) = 'object'
    );

-- When an experiment is marked online/hybrid we require entry_url; data
-- ingestion is meaningless without a runtime URL to load.
CREATE OR REPLACE FUNCTION experiments_enforce_online_config()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.experiment_mode IN ('online', 'hybrid') THEN
    IF NEW.online_runtime_config IS NULL
       OR NEW.online_runtime_config->>'entry_url' IS NULL
       OR btrim(NEW.online_runtime_config->>'entry_url') = '' THEN
      RAISE EXCEPTION 'online_runtime_config.entry_url is required for mode=%', NEW.experiment_mode
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.data_consent_required = false AND NEW.irb_document_url IS NULL THEN
      -- Soft warning via NOTICE — allow draft rows to exist in an
      -- incomplete state, activation is already gated in 00022.
      RAISE NOTICE 'Online experiment % has no IRB URL and consent not required', NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER experiments_enforce_online_config_trg
  BEFORE INSERT OR UPDATE ON experiments
  FOR EACH ROW
  EXECUTE FUNCTION experiments_enforce_online_config();

-- ── booking status: add 'running' ─────────────────────────────────────────
-- Re-declare the CHECK constraint since the original lived on the bookings
-- table inline. New transition: confirmed → running when /run issues a token;
-- running → completed when researcher verifies the completion code.

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
ALTER TABLE bookings
  ADD CONSTRAINT bookings_status_check
  CHECK (status IN ('confirmed', 'cancelled', 'completed', 'no_show', 'running'));

-- Preserve the partial index from 00003 — status='confirmed' still covers
-- slot-contention checks. No changes needed there.

-- ── experiment_run_progress ───────────────────────────────────────────────
-- One row per booking that uses the online runtime. Tracks:
--   * the hashed signed-token so we can revoke/verify server-side
--   * how many blocks have been submitted (append-only counter)
--   * the completion code shown to the participant at end of run
--   * researcher verification (so status can transition to 'completed')

CREATE TABLE experiment_run_progress (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE UNIQUE,
  -- SHA-256 of the signed token string. Stored so we can revoke without
  -- leaking the original token. Regenerated if researcher issues a fresh
  -- token (e.g. participant lost their link).
  token_hash text NOT NULL,
  token_issued_at timestamptz NOT NULL DEFAULT now(),
  token_revoked_at timestamptz,
  blocks_submitted integer NOT NULL DEFAULT 0,
  last_block_at timestamptz,
  -- Set when the final block arrives. UUID by default; researchers can
  -- override the format via online_runtime_config.completion_token_format.
  completion_code text UNIQUE,
  completion_code_issued_at timestamptz,
  -- Researcher-side verification closes the loop.
  verified_at timestamptz,
  verified_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  -- Rate-limit windows. Simple sliding counters; refreshed in-app per call.
  burst_window_start timestamptz NOT NULL DEFAULT now(),
  burst_count integer NOT NULL DEFAULT 0,
  minute_window_start timestamptz NOT NULL DEFAULT now(),
  minute_count integer NOT NULL DEFAULT 0,
  -- Researcher verification brute-force guard. Each failed /verify POST
  -- bumps verify_attempts; once we pass a threshold (enforced in the
  -- route) the endpoint locks until the researcher clears it by reissuing
  -- or manually resetting.
  verify_attempts integer NOT NULL DEFAULT 0,
  verify_locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (blocks_submitted >= 0)
);

CREATE INDEX idx_run_progress_booking ON experiment_run_progress(booking_id);
CREATE INDEX idx_run_progress_verified
  ON experiment_run_progress(verified_at)
  WHERE verified_at IS NULL AND completion_code IS NOT NULL;

CREATE TRIGGER experiment_run_progress_updated_at
  BEFORE UPDATE ON experiment_run_progress
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

ALTER TABLE experiment_run_progress ENABLE ROW LEVEL SECURITY;

-- Admins see everything.
CREATE POLICY "Admins read run progress"
  ON experiment_run_progress FOR SELECT
  USING (is_admin(auth.uid()));

-- Researchers see progress for their own experiments (for verification).
CREATE POLICY "Researchers read own run progress"
  ON experiment_run_progress FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM bookings b
      JOIN experiments e ON e.id = b.experiment_id
      WHERE b.id = experiment_run_progress.booking_id
        AND e.created_by = auth.uid()
    )
  );

-- Researchers can flip verified_at/verified_by on their own rows. Other
-- columns (token_hash, blocks_submitted, completion_code, rate-limit
-- windows) are protected by column-level GRANTs below, so even though
-- this RLS policy grants row-level UPDATE permission, only the two
-- verification columns are actually writable by the researcher role.
CREATE POLICY "Researchers verify own run progress"
  ON experiment_run_progress FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM bookings b
      JOIN experiments e ON e.id = b.experiment_id
      WHERE b.id = experiment_run_progress.booking_id
        AND e.created_by = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM bookings b
      JOIN experiments e ON e.id = b.experiment_id
      WHERE b.id = experiment_run_progress.booking_id
        AND e.created_by = auth.uid()
    )
  );

-- Column-level permissions: researcher role (authenticated users acting
-- as researchers) can only update verified_at + verified_by. Everything
-- else — token_hash, blocks_submitted, completion_code, burst/minute
-- counters — is service-role-only. Service role bypasses privilege checks.
REVOKE UPDATE ON experiment_run_progress FROM authenticated;
GRANT UPDATE(verified_at, verified_by) ON experiment_run_progress TO authenticated;
GRANT SELECT ON experiment_run_progress TO authenticated;

-- All other writes — token issue, block counter bump, completion_code mint,
-- rate-limit windows — go through service-role (RLS bypassed) from
-- /api/experiments/:id/data/:bookingId/block.

-- ── Atomic rate-limit + block-counter bump ────────────────────────────────
-- Called by the ingestion route inside a single RPC so the burst/minute
-- windows + blocks_submitted all move under one row-level lock. Uses
-- column-relative UPDATEs (x = x + 1) rather than writing back a snapshot,
-- so any concurrent writer that somehow touched the row (e.g. the
-- rpc_rollback_block function below) is reconciled by the database rather
-- than clobbered.

CREATE OR REPLACE FUNCTION rpc_ingest_block(
  p_booking_id uuid,
  p_block_index integer
)
RETURNS jsonb AS $$
DECLARE
  v_now timestamptz := now();
  v_blocks integer;
  v_revoked timestamptz;
  v_completed text;
  v_burst_start timestamptz;
  v_burst_count integer;
  v_minute_start timestamptz;
  v_minute_count integer;
BEGIN
  -- Lock the row and read just the fields we need for the gate checks.
  SELECT blocks_submitted, token_revoked_at, completion_code,
         burst_window_start, burst_count, minute_window_start, minute_count
    INTO v_blocks, v_revoked, v_completed,
         v_burst_start, v_burst_count, v_minute_start, v_minute_count
    FROM experiment_run_progress
    WHERE booking_id = p_booking_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NO_PROGRESS_ROW' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_revoked IS NOT NULL THEN
    RAISE EXCEPTION 'TOKEN_REVOKED' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_completed IS NOT NULL THEN
    RAISE EXCEPTION 'RUN_ALREADY_COMPLETED' USING ERRCODE = 'unique_violation';
  END IF;
  IF p_block_index <> v_blocks THEN
    RAISE EXCEPTION 'BLOCK_INDEX_MISMATCH' USING ERRCODE = 'invalid_parameter_value',
      DETAIL = format('expected %s, got %s', v_blocks, p_block_index);
  END IF;

  -- Burst window: 1 s, max 1 request per booking.
  IF v_now - v_burst_start > interval '1 second' THEN
    UPDATE experiment_run_progress
      SET burst_window_start = v_now, burst_count = 0
      WHERE booking_id = p_booking_id;
    v_burst_count := 0;
  END IF;
  IF v_burst_count >= 1 THEN
    RAISE EXCEPTION 'RATE_LIMIT_BURST' USING ERRCODE = 'too_many_connections';
  END IF;

  -- Minute window: 60 s, max 100 requests per booking.
  IF v_now - v_minute_start > interval '1 minute' THEN
    UPDATE experiment_run_progress
      SET minute_window_start = v_now, minute_count = 0
      WHERE booking_id = p_booking_id;
    v_minute_count := 0;
  END IF;
  IF v_minute_count >= 100 THEN
    RAISE EXCEPTION 'RATE_LIMIT_MINUTE' USING ERRCODE = 'too_many_connections';
  END IF;

  -- Relative increments so the writes compose cleanly with any concurrent
  -- non-RPC writer that might have touched the row between the SELECT
  -- FOR UPDATE and this UPDATE (in practice none, given the lock).
  UPDATE experiment_run_progress
    SET blocks_submitted = blocks_submitted + 1,
        last_block_at = v_now,
        burst_count = burst_count + 1,
        minute_count = minute_count + 1
    WHERE booking_id = p_booking_id;

  RETURN jsonb_build_object(
    'blocks_submitted', v_blocks + 1,
    'accepted_at', v_now
  );
END;
$$ LANGUAGE plpgsql;

-- Rollback a failed ingestion (storage upload error). Decrements only the
-- block counter AND the rate-limit usage, so a failed upload does not
-- leave the counters desynced nor waste a participant's quota slot.
-- Only callable with service role (no RLS on functions; but it's also
-- behaviorally safe to call as researcher if they needed to reset state).

CREATE OR REPLACE FUNCTION rpc_rollback_block(
  p_booking_id uuid,
  p_expected_blocks integer
)
RETURNS jsonb AS $$
DECLARE
  v_blocks integer;
BEGIN
  SELECT blocks_submitted INTO v_blocks
    FROM experiment_run_progress
    WHERE booking_id = p_booking_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NO_PROGRESS_ROW' USING ERRCODE = 'no_data_found';
  END IF;
  -- Only roll back if the counter is in the expected state. Guards
  -- against rolling back a bump from a different concurrent request.
  IF v_blocks <> p_expected_blocks THEN
    RETURN jsonb_build_object('rolled_back', false, 'blocks_submitted', v_blocks);
  END IF;
  UPDATE experiment_run_progress
    SET blocks_submitted = GREATEST(blocks_submitted - 1, 0),
        burst_count = GREATEST(burst_count - 1, 0),
        minute_count = GREATEST(minute_count - 1, 0)
    WHERE booking_id = p_booking_id;
  RETURN jsonb_build_object('rolled_back', true, 'blocks_submitted', v_blocks - 1);
END;
$$ LANGUAGE plpgsql;

-- Mint + reveal the completion code once the last block is in. Called in a
-- second RPC so the storage upload in between doesn't hold the progress
-- row's lock.
CREATE OR REPLACE FUNCTION rpc_mint_completion_code(
  p_booking_id uuid,
  p_code text
)
RETURNS jsonb AS $$
DECLARE
  v_row experiment_run_progress%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM experiment_run_progress
    WHERE booking_id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NO_PROGRESS_ROW' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_row.completion_code IS NOT NULL THEN
    -- Idempotent: same participant hits the final block twice (retry) — we
    -- return the already-minted code so the UI can still display it.
    RETURN jsonb_build_object('completion_code', v_row.completion_code, 'reissued', true);
  END IF;
  UPDATE experiment_run_progress
    SET completion_code = p_code,
        completion_code_issued_at = now()
    WHERE booking_id = p_booking_id;
  -- Also flip the booking status to 'running' if still 'confirmed'.
  -- (Participant started the run but hasn't been verified yet.)
  UPDATE bookings
    SET status = 'running'
    WHERE id = p_booking_id
      AND status = 'confirmed';
  RETURN jsonb_build_object('completion_code', p_code, 'reissued', false);
END;
$$ LANGUAGE plpgsql;

-- ── Storage bucket: experiment-data ───────────────────────────────────────
-- Private bucket. Service-role writes (from the ingestion route) are the
-- only path in; researchers read through the admin API, never directly.
-- Object path convention: experiment-data/{experiment_id}/{subject_number}/block_{N}.json
--
-- We use INSERT ... ON CONFLICT DO NOTHING so re-running the migration
-- during local dev doesn't error.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'experiment-data',
  'experiment-data',
  false,
  10485760, -- 10 MiB per block — generous ceiling for a typical JS experiment
  ARRAY['application/json']
)
ON CONFLICT (id) DO NOTHING;

-- Researchers can SELECT objects for experiments they own. Writes stay
-- service-role-only; this read policy is purely for the admin UI download
-- endpoint (which uses the user cookie, not the service role, so policies
-- apply).
CREATE POLICY "Researchers read own experiment data"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'experiment-data'
    AND EXISTS (
      SELECT 1 FROM experiments e
      WHERE e.id::text = (storage.foldername(name))[1]
        AND (e.created_by = auth.uid() OR is_admin(auth.uid()))
    )
  );
