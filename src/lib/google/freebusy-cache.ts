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
  busy_intervals: Array<{ start: string; end: string; summary?: string | null }>;
  fetched_at: string;
}

function intervalsFromDb(
  rows: Array<{ start: string; end: string; summary?: string | null }>,
): BusyInterval[] {
  return rows.map((r) => ({
    start: new Date(r.start),
    end: new Date(r.end),
    summary: r.summary ?? null,
  }));
}

function intervalsToDb(
  rows: BusyInterval[],
): Array<{ start: string; end: string; summary?: string | null }> {
  return rows.map((r) => ({
    start: r.start.toISOString(),
    end: r.end.toISOString(),
    summary: r.summary ?? null,
  }));
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
      if (age < TTL_MS) return intervalsFromDb(cached.busy_intervals);
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

  return fresh;
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
