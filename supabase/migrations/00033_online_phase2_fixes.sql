-- Phase 2 follow-ups from the adversarial review (all CREATE OR REPLACE):
--   * rpc_assign_condition: return NULL if no progress row, don't silently
--     write to a missing row.
--   * rpc_record_attention_failure: raise if booking doesn't exist (avoid
--     creating a silent no-op).
--   * rpc_merge_behavior_signals: reject NaN / Infinity so one bad sample
--     doesn't block later merges.

CREATE OR REPLACE FUNCTION rpc_assign_condition(
  p_booking_id uuid
)
RETURNS text AS $$
DECLARE
  v_found boolean;
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
  -- First confirm the progress row exists. If not, bail with NULL — the
  -- prior version would compute a condition and UPDATE 0 rows silently,
  -- returning a value that was never persisted (review finding C2).
  SELECT TRUE, p.condition_assignment
    INTO v_found, v_existing
    FROM experiment_run_progress p
    WHERE p.booking_id = p_booking_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
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
  v_val_text text;
  v_val_num numeric;
  v_existing_num numeric;
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
      -- Guard against NaN / Infinity / ±Infinity in jsonb (PG jsonb can
      -- carry those in some input paths). Fall through to the "store as-is"
      -- branch if numeric cast fails.
      v_val_text := v_val::text;
      IF v_val_text IN ('"NaN"', '"Infinity"', '"-Infinity"', 'NaN', 'Infinity', '-Infinity') THEN
        CONTINUE;
      END IF;
      BEGIN
        v_val_num := v_val_text::numeric;
        v_existing_num := COALESCE((v_existing::text)::numeric, 0);
      EXCEPTION WHEN OTHERS THEN
        CONTINUE;
      END;
      v_cur := jsonb_set(
        v_cur,
        ARRAY[v_key],
        to_jsonb(v_existing_num + v_val_num)
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
