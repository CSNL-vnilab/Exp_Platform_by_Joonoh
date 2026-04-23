-- Phase 2 for online experiments (Stream 2 follow-up to 00023).
-- Adds the features benchmarked against Prolific / Pavlovia / Gorilla that are
-- missing for a lab-grade deployment: pilot mode, counterbalancing, richer
-- screening, attention checks, preflight, SRI version pinning, behavior
-- signals, and live-dashboard hooks.
--
-- All changes are scoped to online-experiment structures (experiment_run_progress,
-- online_runtime_config jsonb field, new experiment_online_screeners table).
-- Offline tables, columns, and flows are untouched.

-- ── experiment_run_progress: pilot flag + condition + attention/behavior ──
-- These columns only matter when the booking's experiment has mode != 'offline'.
-- Offline bookings never get an experiment_run_progress row so the new
-- columns are invisible to them.

ALTER TABLE experiment_run_progress
  -- Pilot runs don't consume subject_number and are stored under a separate
  -- storage prefix. Researchers use this during study validation.
  ADD COLUMN is_pilot boolean NOT NULL DEFAULT false,
  -- Counterbalanced condition assigned at session-endpoint time, deterministic
  -- from subject_number + online_runtime_config.counterbalance_spec. Stored so
  -- the condition stays stable across reloads.
  ADD COLUMN condition_assignment text,
  -- Running total of attention-check failures. The /run shell injects checks
  -- between blocks per online_runtime_config.attention_checks; any failure
  -- bumps this counter. Researchers can act on the aggregate post-hoc.
  ADD COLUMN attention_fail_count integer NOT NULL DEFAULT 0,
  -- Aggregate behavior signals (focus_loss_count, paste_count, avg_typing_ms,
  -- etc.) sent by the shell at end of each block. Opt-in (requires participant
  -- consent). Never contains raw text — only aggregates.
  ADD COLUMN behavior_signals jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Tracks the entry_url's integrity hash the participant actually loaded,
  -- for post-hoc audit ("did this participant run the same build as that one?").
  ADD COLUMN entry_url_sri text;

ALTER TABLE experiment_run_progress
  ADD CONSTRAINT experiment_run_progress_behavior_is_object
    CHECK (jsonb_typeof(behavior_signals) = 'object');

CREATE INDEX idx_run_progress_pilot
  ON experiment_run_progress(is_pilot)
  WHERE is_pilot = true;

-- ── experiment_online_screeners ──────────────────────────────────────────
-- Richer per-experiment screening than the existing precautions (yes/no only).
-- Supports numeric ranges, single/multi choice, with per-question validation.
-- Only consulted when the experiment is online/hybrid.
--
-- Shape of validation_config by kind:
--   'yes_no'        → { required_answer: true | false }
--   'numeric'       → { min?: number, max?: number, integer?: boolean }
--   'single_choice' → { options: string[], accepted: string[] }
--   'multi_choice'  → { options: string[], min_selected?: number,
--                       max_selected?: number, accepted_all?: string[] }

CREATE TABLE experiment_online_screeners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  position integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('yes_no','numeric','single_choice','multi_choice')),
  question text NOT NULL CHECK (length(btrim(question)) > 0),
  help_text text,
  validation_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  required boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(validation_config) = 'object'),
  UNIQUE (experiment_id, position)
);

CREATE INDEX idx_online_screeners_exp ON experiment_online_screeners(experiment_id, position);

CREATE TRIGGER experiment_online_screeners_updated_at
  BEFORE UPDATE ON experiment_online_screeners
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE experiment_online_screeners ENABLE ROW LEVEL SECURITY;

-- Public read: participants need to see screener questions during /run
-- before their booking has an auth session.
CREATE POLICY "Anyone reads online screeners"
  ON experiment_online_screeners FOR SELECT
  USING (true);

CREATE POLICY "Researchers manage own screeners"
  ON experiment_online_screeners FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM experiments e
      WHERE e.id = experiment_online_screeners.experiment_id
        AND e.created_by = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM experiments e
      WHERE e.id = experiment_online_screeners.experiment_id
        AND e.created_by = auth.uid()
    )
  );

CREATE POLICY "Admins manage all screeners"
  ON experiment_online_screeners FOR ALL
  USING (is_admin(auth.uid()))
  WITH CHECK (is_admin(auth.uid()));

-- ── experiment_online_screener_responses ─────────────────────────────────
-- Participant's answers. Append-only per booking — a participant fails the
-- screener only if their CURRENT submission's answers don't satisfy every
-- required question's validation_config. We still record the attempt so
-- researchers can see who dropped off where.

CREATE TABLE experiment_online_screener_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  screener_id uuid NOT NULL REFERENCES experiment_online_screeners(id) ON DELETE CASCADE,
  answer jsonb NOT NULL,
  passed boolean NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (booking_id, screener_id)
);

CREATE INDEX idx_screener_responses_booking
  ON experiment_online_screener_responses(booking_id);

ALTER TABLE experiment_online_screener_responses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins read all screener responses"
  ON experiment_online_screener_responses FOR SELECT
  USING (is_admin(auth.uid()));

CREATE POLICY "Researchers read own screener responses"
  ON experiment_online_screener_responses FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM bookings b
      JOIN experiments e ON e.id = b.experiment_id
      WHERE b.id = experiment_online_screener_responses.booking_id
        AND e.created_by = auth.uid()
    )
  );

-- ── rpc_assign_condition ──────────────────────────────────────────────────
-- Deterministic counterbalanced condition assignment. Called by the session
-- endpoint on first access. If the booking's progress row already has a
-- condition_assignment, returns it unchanged (idempotent across reloads).
-- Otherwise computes based on online_runtime_config.counterbalance_spec:
--
--   { kind: 'latin_square', conditions: ['A','B','C','D'] }
--     → conditions[(subject_number - 1) % length]
--   { kind: 'block_rotation', conditions: [...] , block_size: N }
--     → conditions[floor((subject_number - 1) / N) % length]
--   { kind: 'random', conditions: [...], seed?: string }
--     → deterministic hash(subject_number + seed) mod length
--   Missing / invalid spec → returns null (researcher's JS handles it).

CREATE OR REPLACE FUNCTION rpc_assign_condition(
  p_booking_id uuid
)
RETURNS text AS $$
DECLARE
  v_existing text;
  v_sbj integer;
  v_spec jsonb;
  v_kind text;
  v_conds jsonb;
  v_block_size integer;
  v_seed text;
  v_idx integer;
  v_hash text;
  v_len integer;
BEGIN
  SELECT p.condition_assignment INTO v_existing
    FROM experiment_run_progress p
    WHERE p.booking_id = p_booking_id FOR UPDATE;
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;

  SELECT b.subject_number, e.online_runtime_config->'counterbalance_spec'
    INTO v_sbj, v_spec
    FROM bookings b
    JOIN experiments e ON e.id = b.experiment_id
    WHERE b.id = p_booking_id;

  IF v_spec IS NULL OR v_sbj IS NULL THEN RETURN NULL; END IF;

  v_kind := v_spec->>'kind';
  v_conds := v_spec->'conditions';
  IF v_conds IS NULL OR jsonb_typeof(v_conds) <> 'array' THEN RETURN NULL; END IF;
  v_len := jsonb_array_length(v_conds);
  IF v_len = 0 THEN RETURN NULL; END IF;

  IF v_kind = 'latin_square' THEN
    v_idx := ((v_sbj - 1) % v_len + v_len) % v_len;
  ELSIF v_kind = 'block_rotation' THEN
    v_block_size := GREATEST(COALESCE((v_spec->>'block_size')::int, 1), 1);
    v_idx := (((v_sbj - 1) / v_block_size) % v_len + v_len) % v_len;
  ELSIF v_kind = 'random' THEN
    v_seed := COALESCE(v_spec->>'seed', '');
    v_hash := md5(v_seed || '.' || v_sbj::text);
    v_idx := ('x' || substring(v_hash, 1, 8))::bit(32)::int;
    v_idx := ((v_idx % v_len) + v_len) % v_len;
  ELSE
    RETURN NULL;
  END IF;

  UPDATE experiment_run_progress
    SET condition_assignment = (v_conds->>v_idx)
    WHERE booking_id = p_booking_id;

  RETURN v_conds->>v_idx;
END;
$$ LANGUAGE plpgsql;

-- ── rpc_record_attention_failure ─────────────────────────────────────────
-- Bumps the attention_fail_count atomically. Called by the shell when an
-- attention check in the current block returned the wrong answer. Kept as
-- its own RPC (not folded into rpc_ingest_block) so the shell can report
-- failures even during a block that the researcher's JS might still decide
-- to submit — we track the failure signal either way.

CREATE OR REPLACE FUNCTION rpc_record_attention_failure(
  p_booking_id uuid,
  p_delta integer DEFAULT 1
)
RETURNS integer AS $$
DECLARE
  v_new integer;
BEGIN
  UPDATE experiment_run_progress
    SET attention_fail_count = attention_fail_count + GREATEST(p_delta, 1)
    WHERE booking_id = p_booking_id
    RETURNING attention_fail_count INTO v_new;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NO_PROGRESS_ROW' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN v_new;
END;
$$ LANGUAGE plpgsql;

-- ── rpc_merge_behavior_signals ───────────────────────────────────────────
-- Merges a block's behavior aggregate into the booking's cumulative tallies.
-- Example input: { focus_loss: 1, paste_count: 0, typing_ms_samples: 4200 }
-- We add numeric values and overwrite string values.

CREATE OR REPLACE FUNCTION rpc_merge_behavior_signals(
  p_booking_id uuid,
  p_delta jsonb
)
RETURNS jsonb AS $$
DECLARE
  v_cur jsonb;
  v_key text;
  v_val jsonb;
  v_existing jsonb;
BEGIN
  IF p_delta IS NULL OR jsonb_typeof(p_delta) <> 'object' THEN
    RETURN '{}'::jsonb;
  END IF;
  SELECT behavior_signals INTO v_cur
    FROM experiment_run_progress WHERE booking_id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NO_PROGRESS_ROW' USING ERRCODE = 'no_data_found';
  END IF;

  FOR v_key, v_val IN SELECT * FROM jsonb_each(p_delta) LOOP
    v_existing := v_cur -> v_key;
    IF jsonb_typeof(v_val) = 'number' AND
       (v_existing IS NULL OR jsonb_typeof(v_existing) = 'number') THEN
      v_cur := jsonb_set(
        v_cur,
        ARRAY[v_key],
        to_jsonb(
          COALESCE((v_existing::text)::numeric, 0)
          + (v_val::text)::numeric
        )
      );
    ELSE
      v_cur := jsonb_set(v_cur, ARRAY[v_key], v_val);
    END IF;
  END LOOP;

  UPDATE experiment_run_progress
    SET behavior_signals = v_cur
    WHERE booking_id = p_booking_id;
  RETURN v_cur;
END;
$$ LANGUAGE plpgsql;

-- ── Column-level grants — researchers can mark pilot, nothing else ───────
-- Researchers already had UPDATE on verified_at/verified_by via 00023.
-- Extend to is_pilot so the admin UI's pilot toggle works under RLS.
GRANT UPDATE(is_pilot) ON experiment_run_progress TO authenticated;
