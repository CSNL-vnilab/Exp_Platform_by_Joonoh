-- Blind review follow-ups.
--
-- C1: reject non-HTTP(S) entry_url at the DB so service-role writes
--     can't install `javascript:` or `data:` scripts into the /run shim.
-- H7: cap individual behavior_signals keys so a runaway participant's
--     rAF jitter accumulator doesn't overflow numeric precision.

ALTER TABLE experiments
  ADD CONSTRAINT experiments_online_entry_url_is_http
    CHECK (
      online_runtime_config IS NULL
      OR online_runtime_config->>'entry_url' IS NULL
      OR (online_runtime_config->>'entry_url') ~* '^https?://'
    );

-- Numeric cap: 1e12 ≈ 31 years of 32 μs jitter per frame — way beyond
-- any real session. Caps silently (clip, don't raise) so a long-running
-- session doesn't trigger RPC errors at the integrity layer.
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
  v_sum numeric;
  v_cap CONSTANT numeric := 1e12;
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
      v_sum := LEAST(v_existing_num + v_val_num, v_cap);
      v_cur := jsonb_set(v_cur, ARRAY[v_key], to_jsonb(v_sum));
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
