import { createAdminClient } from "@/lib/supabase/admin";
import { getFreeBusy } from "@/lib/google/calendar";
import type { BusyInterval } from "@/lib/utils/slots";

// Cache Google Calendar FreeBusy responses to dedupe hits. Avoids blasting
// the Google API every time a participant loads the booking page.
//
// - Key: (calendarId, range_from, range_to).
// - TTL: 30 minutes. Cache is refreshed lazily on the next request.
// - Invalidation: explicit, via `invalidateCalendarCache(calendarId)`.
//   Called whenever a researcher creates/updates/cancels an experiment
//   bound to that calendar.

// Keep cache just long enough to dedupe burst traffic (e.g. a cohort of
// participants opening the booking link at the same time) without masking
// events a researcher added directly in Google Calendar.
const TTL_MS = 5 * 60 * 1000;

interface CacheRow {
  busy_intervals: Array<{
    start: string;
    end: string;
    summary?: string | null;
    id?: string | null;
  }>;
  fetched_at: string;
}

function intervalsFromDb(
  rows: Array<{ start: string; end: string; summary?: string | null; id?: string | null }>,
): BusyInterval[] {
  return rows.map((r) => ({
    start: new Date(r.start),
    end: new Date(r.end),
    summary: r.summary ?? null,
    id: r.id ?? null,
  }));
}

function intervalsToDb(
  rows: BusyInterval[],
): Array<{ start: string; end: string; summary?: string | null; id?: string | null }> {
  return rows.map((r) => ({
    start: r.start.toISOString(),
    end: r.end.toISOString(),
    summary: r.summary ?? null,
    id: r.id ?? null,
  }));
}

/**
 * Drop busy intervals that belong to the lab's OWN cancelled / no_show
 * bookings — "orphan" calendar events whose cancel-time delete failed (or
 * was skipped, e.g. blacklist cascade) so the event lingers on the shared
 * calendar and keeps showing the slot as busy.
 *
 * Why this is the real fix (not just the reaper): the bookings table is the
 * single source of truth for the lab's own slot occupancy — the slot grid
 * already counts CONFIRMED bookings from the DB. A calendar event that maps
 * to a CANCELLED/NO_SHOW booking therefore must never block a slot, even if
 * the event still physically exists. We match by google_event_id, which the
 * cancelled row keeps until the orphan-reaper (or a later cancel) clears it,
 * so this works on pre-existing orphans too — no calendar migration needed.
 *
 * SAFETY: only CANCELLED/NO_SHOW rows are excluded. A CONFIRMED booking's
 * event is kept (a genuine room/calendar conflict, including cross-experiment
 * ones on a shared calendar). And book_slot remains the authoritative gate —
 * availability is advisory, so a stale exclusion can at worst surface a slot
 * the RPC then rejects, never a silent double-book.
 */
export async function excludeBookingOrphans(
  intervals: BusyInterval[],
): Promise<BusyInterval[]> {
  const ids = intervals
    .map((i) => i.id)
    .filter((x): x is string => typeof x === "string" && x.length > 0);
  if (ids.length === 0) return intervals;

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("bookings")
    .select("google_event_id")
    .in("google_event_id", ids)
    .in("status", ["cancelled", "no_show"]);

  // Fail OPEN on a query error: keep all intervals (the pre-fix behaviour)
  // rather than risk hiding a real external conflict.
  if (error || !data || data.length === 0) return intervals;

  const orphanIds = new Set(
    data.map((r) => (r as { google_event_id: string }).google_event_id),
  );
  return intervals.filter((i) => !i.id || !orphanIds.has(i.id));
}

export async function getCachedFreeBusy(
  calendarId: string,
  rangeFrom: Date,
  rangeTo: Date,
  options: { force?: boolean } = {},
): Promise<BusyInterval[]> {
  const supabase = createAdminClient();
  const keyFrom = rangeFrom.toISOString();
  const keyTo = rangeTo.toISOString();

  if (!options.force) {
    const { data: row } = await supabase
      .from("calendar_freebusy_cache")
      .select("busy_intervals, fetched_at")
      .eq("calendar_id", calendarId)
      .eq("range_from", keyFrom)
      .eq("range_to", keyTo)
      .maybeSingle();

    const cached = row as CacheRow | null;
    if (cached) {
      const age = Date.now() - new Date(cached.fetched_at).getTime();
      // Orphan-exclusion runs AFTER the cache read (not before the upsert)
      // so the cache always stores Google's raw truth and a booking
      // cancelled mid-TTL is reflected on the very next page load.
      if (age < TTL_MS)
        return excludeBookingOrphans(intervalsFromDb(cached.busy_intervals));
    }
  }

  // Miss or forced — fetch from Google, then upsert.
  const fresh = await getFreeBusy(calendarId, rangeFrom, rangeTo);

  await supabase
    .from("calendar_freebusy_cache")
    .upsert(
      {
        calendar_id: calendarId,
        range_from: keyFrom,
        range_to: keyTo,
        busy_intervals: intervalsToDb(fresh),
        fetched_at: new Date().toISOString(),
      },
      { onConflict: "calendar_id,range_from,range_to" },
    );

  return excludeBookingOrphans(fresh);
}

/**
 * Invalidate all cached FreeBusy entries for a calendar. Called when an
 * experiment linked to that calendar is created, updated, or cancelled so
 * researchers see changes without waiting for the TTL.
 */
export async function invalidateCalendarCache(calendarId: string | null | undefined) {
  if (!calendarId) return;
  const supabase = createAdminClient();
  await supabase.from("calendar_freebusy_cache").delete().eq("calendar_id", calendarId);
}
