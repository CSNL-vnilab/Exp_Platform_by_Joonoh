// GCal orphan-event reaper.
//
// Why this exists (hidden-couplings #3 #12 #14, 2026-05-30):
//
// Multiple paths can leave a `bookings.google_event_id` set on a row
// whose status is terminal (cancelled / no_show):
//   * PUT /api/bookings cancel — GCal deleteEvent fails (5xx / network
//     hiccup); status flip persists but the event stays on the lab
//     calendar. We DO write a `booking_integrations.gcal` audit row
//     with `last_error`, but no automated retry sweeps it.
//   * Blacklist cascade — bulk-flips future bookings to cancelled
//     without firing the per-row delete (refactor-roadmap notes this
//     intentionally skips notification; the GCal side-effect was an
//     oversight).
//   * Partial-cancel from booking-edit (cancel route) — same first
//     bullet, but participant-facing.
//
// This cron walks the orphan set (`status IN ('cancelled', 'no_show')
// AND google_event_id IS NOT NULL`), tries deleteEvent (idempotent on
// 404/410), and clears `google_event_id` on success. Failed deletes
// stamp `booking_integrations.gcal.last_error` so the next sweep can
// see the retry history without the operator having to grep runtime
// logs.
//
// Bounded to BATCH_LIMIT so a single tick stays under the Vercel
// function timeout even if the orphan set is large. Rows missed in
// this tick get picked up next time.
//
// Auth: shares the cron-secret scheme with every other /api/cron route.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { authorizeCronRequest } from "@/lib/auth/cron-secret";
import { deleteEvent } from "@/lib/google/calendar";
import { invalidateCalendarCache } from "@/lib/google/freebusy-cache";
import { scrubPii } from "@/lib/observability/pii";
import { TERMINAL_NON_PAYABLE } from "@/lib/bookings/status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Defaults — overridable per-call via URL params.
//
// `grace_hours` exists because the reschedule path (`PATCH
// /api/bookings/[id]`) follows a "create new GCal event → DB UPDATE →
// delete old GCal event" sequence. Between the first two steps the
// row briefly satisfies our orphan predicate (status flip is part of
// the same UPDATE, but the picture would be similar for any
// just-cancelled row). A small grace window ensures the legitimate
// in-flight pipeline gets to call deleteEvent itself before this
// background sweep races in.
const DEFAULT_BATCH_LIMIT = 100;
const MAX_BATCH_LIMIT = 500;
const DEFAULT_GRACE_HOURS = 12;
const MAX_GRACE_HOURS = 24 * 30; // 30 days — anything past this is just operator paranoia

function parseIntParam(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!raw) return fallback;
  const v = Number.parseInt(raw, 10);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

async function handle(request: NextRequest) {
  try {
    if (!authorizeCronRequest(request)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const url = new URL(request.url);
    const batchLimit = parseIntParam(
      url.searchParams.get("batch_limit"),
      DEFAULT_BATCH_LIMIT,
      1,
      MAX_BATCH_LIMIT,
    );
    const graceHours = parseIntParam(
      url.searchParams.get("grace_hours"),
      DEFAULT_GRACE_HOURS,
      0,
      MAX_GRACE_HOURS,
    );
    // Window cutoff: only rows updated MORE than `graceHours` ago are
    // candidates. Passes graceHours=0 to disable the window (operator
    // override for a one-shot backlog drain).
    const cutoffIso = new Date(
      Date.now() - graceHours * 60 * 60 * 1000,
    ).toISOString();

    const admin = createAdminClient();

    // Pull a batch of orphan candidates. We sort oldest-first so a
    // backlog drains in chronological order rather than newest-fail
    // first.
    const { data: rows, error: listErr } = await admin
      .from("bookings")
      .select(
        "id, status, google_event_id, updated_at, experiments(google_calendar_id)",
      )
      .in("status", [...TERMINAL_NON_PAYABLE])
      .not("google_event_id", "is", null)
      .lte("updated_at", cutoffIso)
      .order("updated_at", { ascending: true })
      .limit(batchLimit);

    if (listErr) {
      console.error(
        "[GCalOrphanReaper] list query failed:",
        listErr.message,
      );
      return NextResponse.json(
        { error: "List failed", detail: listErr.message },
        { status: 500 },
      );
    }

    const orphans = rows ?? [];
    const fallbackCalendarId = (process.env.GOOGLE_CALENDAR_ID ?? "").trim();

    let cleared = 0;
    let failed = 0;
    let skippedNoCalendar = 0;
    const invalidatedCalendars = new Set<string>();

    for (const r of orphans) {
      const row = r as unknown as {
        id: string;
        status: string;
        google_event_id: string | null;
        updated_at: string;
        experiments: { google_calendar_id: string | null } | null;
      };
      const eventId = row.google_event_id;
      if (!eventId) continue;

      const calendarId = (
        row.experiments?.google_calendar_id ?? fallbackCalendarId
      ).trim();
      if (!calendarId) {
        skippedNoCalendar += 1;
        continue;
      }

      try {
        // deleteEvent is idempotent on 404/410 (event already gone).
        // That's exactly the "successful orphan reap" case for us —
        // someone manually cleaned the calendar but the DB row still
        // pointed at a stale event id.
        await deleteEvent(calendarId, eventId);
        await admin
          .from("bookings")
          .update({ google_event_id: null })
          .eq("id", row.id);
        invalidatedCalendars.add(calendarId);
        cleared += 1;
      } catch (err) {
        failed += 1;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[GCalOrphanReaper] delete failed for booking ${row.id} event ${eventId} on ${calendarId}: ${msg}`,
        );
        // Stamp the audit row so the next sweep + operator log search
        // can see this row's retry history. Same shape PUT /api/bookings
        // uses on the cancel path.
        await admin
          .from("booking_integrations")
          .update({
            status: "failed",
            last_error: scrubPii(
              `orphan-reaper deleteEvent failed for ${eventId}: ${msg}`,
            ).slice(0, 500),
            processed_at: new Date().toISOString(),
          })
          .eq("booking_id", row.id)
          .eq("integration_type", "gcal");
      }
    }

    // Drop the freebusy cache for every calendar we touched so the next
    // participant page load sees the truthier busy intervals. Failures
    // are non-fatal — the cache TTL is short.
    for (const calId of invalidatedCalendars) {
      invalidateCalendarCache(calId).catch(() => {});
    }

    return NextResponse.json({
      ok: true,
      examined: orphans.length,
      cleared,
      failed,
      skipped_no_calendar: skippedNoCalendar,
      batch_limit: batchLimit,
      grace_hours: graceHours,
      cutoff: cutoffIso,
    });
  } catch (err) {
    console.error("[GCalOrphanReaper] error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

export const GET = handle;
export const POST = handle;
