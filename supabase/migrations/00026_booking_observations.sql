-- Per-booking researcher observations (pre/post surveys, free-form notes).
--
-- Invariant: every observation row hangs off exactly one booking. The row is
-- upserted during the session (pre-survey check), then updated after the
-- session with post-survey + notable observations. Marking the post-survey
-- done on a booking whose slot_end has already passed auto-completes the
-- booking, which then fires recompute_participant_class() via the 00025
-- trigger.
--
-- Reverting this migration drops:
--   * `booking_observations` table + its RLS policies
--   * `submit_booking_observation()` RPC
-- Any UI/API code that writes researcher observations or surfaces survey
-- state will break.

CREATE TABLE booking_observations (
  booking_id uuid PRIMARY KEY REFERENCES bookings(id) ON DELETE CASCADE,
  pre_survey_done boolean NOT NULL DEFAULT false,
  pre_survey_info text,
  post_survey_done boolean NOT NULL DEFAULT false,
  post_survey_info text,
  notable_observations text,
  researcher_id uuid REFERENCES auth.users(id),
  entered_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  notion_page_id text,
  notion_synced_at timestamptz
);

CREATE INDEX idx_booking_observations_researcher
  ON booking_observations (researcher_id);

-- updated_at trigger.
CREATE OR REPLACE FUNCTION trg_booking_observations_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS booking_observations_set_updated_at ON booking_observations;
CREATE TRIGGER booking_observations_set_updated_at
  BEFORE UPDATE ON booking_observations
  FOR EACH ROW
  EXECUTE FUNCTION trg_booking_observations_updated_at();

-- ---------------------------------------------------------------------------
-- RLS: researchers who own the underlying experiment have ALL access.
-- Mirrors booking_integrations policy structure.
-- ---------------------------------------------------------------------------
ALTER TABLE booking_observations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage observations"
  ON booking_observations FOR ALL
  USING (is_admin(auth.uid()))
  WITH CHECK (is_admin(auth.uid()));

CREATE POLICY "Researchers manage own experiment observations"
  ON booking_observations FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM bookings b
      JOIN experiments e ON e.id = b.experiment_id
      WHERE b.id = booking_observations.booking_id
        AND e.created_by = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM bookings b
      JOIN experiments e ON e.id = b.experiment_id
      WHERE b.id = booking_observations.booking_id
        AND e.created_by = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- submit_booking_observation RPC.
--
-- Upserts the observation row and — if post_survey_done flipped to true and
-- the booking is still 'confirmed' with slot_end in the past — transitions
-- the booking to 'completed'. That status change fires the class-recompute
-- trigger installed in 00025.
--
-- SECURITY DEFINER: checked manually against the caller's ownership.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION submit_booking_observation(
  p_booking_id uuid,
  p_observation jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_is_admin boolean;
  v_owner uuid;
  v_slot_end timestamptz;
  v_status text;
  v_should_complete boolean := false;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'UNAUTHENTICATED');
  END IF;

  SELECT is_admin(v_caller) INTO v_is_admin;

  SELECT e.created_by, b.slot_end, b.status::text
    INTO v_owner, v_slot_end, v_status
  FROM bookings b
  JOIN experiments e ON e.id = b.experiment_id
  WHERE b.id = p_booking_id;

  IF v_owner IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'BOOKING_NOT_FOUND');
  END IF;

  IF NOT v_is_admin AND v_owner IS DISTINCT FROM v_caller THEN
    RETURN jsonb_build_object('success', false, 'error', 'FORBIDDEN');
  END IF;

  INSERT INTO booking_observations (
    booking_id,
    pre_survey_done,
    pre_survey_info,
    post_survey_done,
    post_survey_info,
    notable_observations,
    researcher_id,
    notion_page_id,
    notion_synced_at
  ) VALUES (
    p_booking_id,
    COALESCE((p_observation->>'pre_survey_done')::boolean, false),
    p_observation->>'pre_survey_info',
    COALESCE((p_observation->>'post_survey_done')::boolean, false),
    p_observation->>'post_survey_info',
    p_observation->>'notable_observations',
    v_caller,
    p_observation->>'notion_page_id',
    NULLIF(p_observation->>'notion_synced_at', '')::timestamptz
  )
  ON CONFLICT (booking_id) DO UPDATE SET
    pre_survey_done = COALESCE(
      (p_observation->>'pre_survey_done')::boolean,
      booking_observations.pre_survey_done
    ),
    pre_survey_info = COALESCE(
      p_observation->>'pre_survey_info',
      booking_observations.pre_survey_info
    ),
    post_survey_done = COALESCE(
      (p_observation->>'post_survey_done')::boolean,
      booking_observations.post_survey_done
    ),
    post_survey_info = COALESCE(
      p_observation->>'post_survey_info',
      booking_observations.post_survey_info
    ),
    notable_observations = COALESCE(
      p_observation->>'notable_observations',
      booking_observations.notable_observations
    ),
    researcher_id = v_caller,
    notion_page_id = COALESCE(
      p_observation->>'notion_page_id',
      booking_observations.notion_page_id
    ),
    notion_synced_at = COALESCE(
      NULLIF(p_observation->>'notion_synced_at', '')::timestamptz,
      booking_observations.notion_synced_at
    );

  -- Auto-complete when post-survey is done and the slot has passed.
  IF (p_observation->>'post_survey_done') = 'true'
     AND v_status = 'confirmed'
     AND v_slot_end IS NOT NULL
     AND v_slot_end < now() THEN
    v_should_complete := true;
    UPDATE bookings
    SET status = 'completed'
    WHERE id = p_booking_id
      AND status = 'confirmed';
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'booking_id', p_booking_id,
    'auto_completed', v_should_complete
  );
END;
$$;
