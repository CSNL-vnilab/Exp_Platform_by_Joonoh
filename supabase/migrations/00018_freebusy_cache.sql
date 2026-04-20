-- Cache Google Calendar FreeBusy results. Keyed by (calendar, range bounds)
-- to dedupe repeated participant page loads within the TTL. Invalidated on
-- experiment create/update/cancel so researcher actions propagate instantly.
--
-- busy_intervals stores raw [{start, end}] ISO tuples so the app can avoid
-- decoding a gigantic Google API response on every cache read.

CREATE TABLE calendar_freebusy_cache (
  calendar_id text NOT NULL,
  range_from timestamptz NOT NULL,
  range_to timestamptz NOT NULL,
  busy_intervals jsonb NOT NULL DEFAULT '[]'::jsonb,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (calendar_id, range_from, range_to)
);

CREATE INDEX idx_freebusy_cache_calendar ON calendar_freebusy_cache(calendar_id);
CREATE INDEX idx_freebusy_cache_fetched ON calendar_freebusy_cache(fetched_at DESC);

ALTER TABLE calendar_freebusy_cache ENABLE ROW LEVEL SECURITY;
-- Service role only. No user-facing policies.
