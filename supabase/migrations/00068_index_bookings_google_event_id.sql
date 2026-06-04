-- 00068: index bookings.google_event_id for the orphan-availability filter.
--
-- excludeBookingOrphans() (src/lib/google/freebusy-cache.ts) runs, on EVERY
-- availability load (booking-page slots/range, preview-slots, single-day
-- slots, and both reschedule conflict checks):
--
--   SELECT google_event_id FROM bookings
--   WHERE google_event_id IN (<= ~250 ids)        -- the calendar busy ids
--     AND status IN ('cancelled','no_show');       -- orphans only
--
-- to drop stale "orphan" calendar events (cancelled bookings whose
-- cancel-time delete failed) from the busy set so they can't block a slot.
-- Without an index this is a sequential scan per page load — the review that
-- gated this refactor flagged it P0. A PARTIAL index keeps the index tiny:
-- only rows that still carry an event id are ever candidates, and that same
-- predicate is exactly what the gcal-orphan-reaper cron scans
-- (status IN ('cancelled','no_show') AND google_event_id IS NOT NULL), so
-- this index serves both call sites.
--
-- Plain CREATE INDEX (matching every other index migration in this repo —
-- none use CONCURRENTLY) is fine here: the bookings table is small and the
-- build is sub-second. IF NOT EXISTS makes re-application a no-op.

CREATE INDEX IF NOT EXISTS idx_bookings_google_event_id
  ON bookings (google_event_id)
  WHERE google_event_id IS NOT NULL;
