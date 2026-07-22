import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireExperimentAccess } from "@/lib/auth/experiment-access";
import { deleteEvent } from "@/lib/google/calendar";
import { invalidateCalendarCache } from "@/lib/google/freebusy-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/experiments/[experimentId]/cancel-and-reopen
//
// "실험 전체 취소 & 재실험 준비". Cancels every non-cancelled booking on the
// experiment (completed included), reopens the experiment for re-booking, and
// deletes the freed Google Calendar events so participants can re-apply into
// clean slots.
//
// Order matters, mirroring the wipe route's GCal cleanup shape:
//   1. requireExperimentAccess (owner-or-admin — NOT ownerOnly; an admin
//      running lab ops must be able to reset a study they don't own).
//   2. cancel_experiment_and_reopen RPC (migration 00085) does the atomic
//      cancel + reopen and returns the google_event_ids to clean up.
//   3. Best-effort GCal delete of those events. deleteEvent swallows 404/410,
//      so a stray already-gone event never fails the reset; any other throw is
//      logged but does NOT abort — the DB is already reset and re-running the
//      action would find nothing to cancel, so the calendar reaper is the
//      backstop for a transient GCal outage here.
//   4. Best-effort freebusy cache invalidation.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ experimentId: string }> },
) {
  try {
    const { experimentId } = await params;

    const access = await requireExperimentAccess(experimentId, {
      extraColumns: "google_calendar_id",
    });
    if (access instanceof NextResponse) return access;
    const { admin, experiment } = access;

    // requireExperimentAccess only guarantees id/created_by + the columns we
    // asked for on the returned object; cast to read google_calendar_id.
    const calendarId =
      (
        (experiment as unknown as { google_calendar_id: string | null })
          .google_calendar_id ||
        process.env.GOOGLE_CALENDAR_ID ||
        ""
      ).trim() || null;

    const { data, error } = await admin.rpc("cancel_experiment_and_reopen", {
      p_experiment_id: experimentId,
    });
    if (error) {
      console.error(
        `[CancelAndReopen] RPC failed for ${experimentId}: ${error.message}`,
      );
      return NextResponse.json(
        { error: "실험 취소 처리에 실패했습니다." },
        { status: 500 },
      );
    }

    const eventIds =
      (data as { google_event_ids?: string[] })?.google_event_ids ?? [];

    // Best-effort GCal cleanup — DB is already reset, so don't abort on a
    // transient calendar failure.
    if (calendarId) {
      for (const eventId of eventIds) {
        if (!eventId) continue;
        try {
          await deleteEvent(calendarId, eventId);
        } catch (err) {
          console.error(
            `[CancelAndReopen] deleteEvent failed for ${eventId} on ${calendarId}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
      await invalidateCalendarCache(calendarId).catch(() => {});
    }

    const cancelledCount =
      (data as { cancelled_count?: number })?.cancelled_count ?? 0;
    console.log(
      `[CancelAndReopen] experiment ${experimentId} reset (${cancelledCount} bookings cancelled, ${eventIds.length} events removed)`,
    );
    return NextResponse.json({ ok: true, cancelledCount, reopened: true });
  } catch (err) {
    console.error(
      "[CancelAndReopen] unhandled:",
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
