import { NextResponse } from "next/server";
import { google } from "googleapis";
import { getGoogleAuth } from "@/lib/google/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/auth/role";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Admin-facing probe for Google Calendar + cache state. Used to verify
// long-running sync health: "can we still see Slab Calendar, and how fresh
// is our cache?"
export async function GET() {
  await requireAdmin();

  const calendarId = process.env.GOOGLE_CALENDAR_ID ?? null;
  const out: Record<string, unknown> = {
    calendarId,
    serviceAccountEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ?? null,
    time: new Date().toISOString(),
  };

  if (!calendarId) {
    out.ok = false;
    out.error = "GOOGLE_CALENDAR_ID is not set";
    return NextResponse.json(out, { status: 503 });
  }

  try {
    const auth = getGoogleAuth();
    const calendar = google.calendar({ version: "v3", auth });
    const { data: meta } = await calendar.calendars.get({ calendarId });
    out.calendar = { summary: meta.summary, timeZone: meta.timeZone };

    // One-week freebusy probe — cheap round-trip that verifies read access.
    const now = new Date();
    const weekLater = new Date(now.getTime() + 7 * 86_400_000);
    const { data: fb } = await calendar.freebusy.query({
      requestBody: {
        timeMin: now.toISOString(),
        timeMax: weekLater.toISOString(),
        items: [{ id: calendarId }],
      },
    });
    const busy = fb.calendars?.[calendarId]?.busy ?? [];
    out.freebusyOk = true;
    out.busyCountNext7Days = busy.length;
  } catch (err) {
    out.freebusyOk = false;
    out.error = err instanceof Error ? err.message : String(err);
    return NextResponse.json(out, { status: 502 });
  }

  // Cache freshness
  const supabase = createAdminClient();
  const { data: cacheRows } = await supabase
    .from("calendar_freebusy_cache")
    .select("range_from, range_to, fetched_at")
    .eq("calendar_id", calendarId)
    .order("fetched_at", { ascending: false })
    .limit(5);
  out.cacheEntries = cacheRows?.length ?? 0;
  if (cacheRows?.[0]) {
    const ageSec = Math.round((Date.now() - new Date(cacheRows[0].fetched_at).getTime()) / 1000);
    out.latestCacheAgeSec = ageSec;
  }

  out.ok = true;
  return NextResponse.json(out);
}
