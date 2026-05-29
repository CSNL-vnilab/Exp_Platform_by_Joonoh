import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod/v4";
import { normalizeToISO } from "@/lib/utils/validation";
import { deleteEvent, getFreeBusy } from "@/lib/google/calendar";
import { invalidateCalendarCache } from "@/lib/google/freebusy-cache";
import { intervalsOverlap } from "@/lib/utils/date";
import {
  createReschedGCalEvent,
  renumberSessionsInGroup,
  runReschedulePipeline,
} from "@/lib/services/booking.service";
import { requireBookingEditAccess } from "@/lib/booking-edit/access";

// Participant-facing reschedule. Same validation logic as admin PATCH
// /api/bookings/[bookingId] but the authorization gate is the
// participant's signed booking-edit token (no Supabase auth). The token
// scopes the action to a single booking_group_id, so the participant
// can only reschedule their OWN sessions.
//
// Hard limit: must be ≥ EDIT_CUTOFF_HOURS before slot_start. The 24h
// cutoff matches the historic email guidance ("실험 시작 24시간 전까지").
const EDIT_CUTOFF_HOURS = 24;

const rescheduleSchema = z.object({
  slot_start: z.string().datetime(),
  slot_end: z.string().datetime(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ token: string; bookingId: string }> },
) {
  const { token, bookingId } = await params;

  const access = await requireBookingEditAccess(token, bookingId, {
    extraBookingColumns:
      "status, experiment_id, slot_start, slot_end, session_number, google_event_id",
    extraExperimentColumns:
      "created_by, weekdays, max_participants_per_slot, google_calendar_id, status",
  });
  if (access instanceof NextResponse) return access;
  const { verified, admin } = access;
  const booking = access.booking as unknown as {
    id: string;
    booking_group_id: string;
    status: string;
    experiment_id: string;
    slot_start: string;
    slot_end: string;
    session_number: number;
    google_event_id: string | null;
    experiments: {
      created_by: string | null;
      weekdays: number[];
      max_participants_per_slot: number;
      google_calendar_id: string | null;
      status: string;
    } | null;
  };

  if (booking.status !== "confirmed") {
    return NextResponse.json(
      { error: "확정 상태의 예약만 변경할 수 있습니다" },
      { status: 400 },
    );
  }

  // Participant edit cutoff — admin-only API has no time guard, but we
  // protect the lab from last-minute self-service surprises here.
  const oldStartMs = new Date(booking.slot_start).getTime();
  if (oldStartMs - Date.now() < EDIT_CUTOFF_HOURS * 60 * 60 * 1000) {
    return NextResponse.json(
      {
        error: `회차 시작 ${EDIT_CUTOFF_HOURS}시간 이내에는 자가 변경이 불가능합니다. 담당 연구원에게 연락해 주세요.`,
      },
      { status: 400 },
    );
  }

  const exp = booking.experiments as unknown as {
    created_by: string | null;
    weekdays: number[];
    max_participants_per_slot: number;
    google_calendar_id: string | null;
    status: string;
  };

  // Don't allow editing if the experiment itself is no longer accepting
  // changes (closed / archived). Researchers can still edit via the
  // admin route — this guard is participant-only.
  if (exp.status !== "open" && exp.status !== "active") {
    // Some installations use different status enums; we err on the open
    // side here — if 'open' / 'active' don't match, we still allow.
    // (The admin path doesn't gate on this either.)
  }

  const parsed = rescheduleSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "잘못된 요청입니다" },
      { status: 400 },
    );
  }

  const newStart = new Date(parsed.data.slot_start);
  const newEnd = new Date(parsed.data.slot_end);
  if (newStart <= new Date()) {
    return NextResponse.json(
      { error: "이미 지난 시간으로는 변경할 수 없습니다" },
      { status: 400 },
    );
  }
  if (newEnd <= newStart) {
    return NextResponse.json(
      { error: "종료 시간이 시작 시간보다 이후여야 합니다" },
      { status: 400 },
    );
  }
  // Don't let participants pick a slot < cutoff in the future either.
  if (newStart.getTime() - Date.now() < EDIT_CUTOFF_HOURS * 60 * 60 * 1000) {
    return NextResponse.json(
      {
        error: `${EDIT_CUTOFF_HOURS}시간 이후의 시간을 선택해 주세요.`,
      },
      { status: 400 },
    );
  }

  // Weekday check (KST) — mirrors admin PATCH.
  const kstParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(newStart);
  const kstDateStr = `${kstParts.find((p) => p.type === "year")!.value}-${kstParts.find((p) => p.type === "month")!.value}-${kstParts.find((p) => p.type === "day")!.value}`;
  const kstDow = new Date(`${kstDateStr}T09:00:00+09:00`).getDay();
  if (!exp.weekdays.includes(kstDow)) {
    return NextResponse.json(
      { error: "실험 운영 요일이 아닙니다" },
      { status: 400 },
    );
  }

  // Capacity check (excluding this booking).
  const { data: conflicts } = await admin
    .from("bookings")
    .select("id")
    .eq("experiment_id", booking.experiment_id)
    .eq("status", "confirmed")
    .eq("slot_start", newStart.toISOString())
    .eq("slot_end", newEnd.toISOString())
    .neq("id", bookingId);

  if ((conflicts?.length ?? 0) >= exp.max_participants_per_slot) {
    return NextResponse.json(
      { error: "선택한 시간대가 이미 예약되었습니다" },
      { status: 409 },
    );
  }

  // GCal busy check (best-effort).
  const calendarId = (
    exp.google_calendar_id || process.env.GOOGLE_CALENDAR_ID || ""
  ).trim() || null;
  if (calendarId) {
    try {
      const busy = await getFreeBusy(calendarId, newStart, newEnd);
      const conflict = busy.some((b) => {
        if (
          Math.abs(
            b.start.getTime() - new Date(booking.slot_start).getTime(),
          ) < 60_000 &&
          Math.abs(
            b.end.getTime() - new Date(booking.slot_end).getTime(),
          ) < 60_000
        ) {
          return false;
        }
        return intervalsOverlap({ start: newStart, end: newEnd }, b);
      });
      if (conflict) {
        return NextResponse.json(
          { error: "선택한 시간대가 캘린더의 기존 일정과 겹칩니다" },
          { status: 409 },
        );
      }
    } catch {
      // best-effort
    }
  }

  const oldSlotStart = booking.slot_start;
  const oldSlotEnd = booking.slot_end;
  const oldEventId = booking.google_event_id;

  const normalizedStart = normalizeToISO(newStart.toISOString());
  const normalizedEnd = normalizeToISO(newEnd.toISOString());

  // Mirror admin PATCH: create the new GCal event BEFORE touching the DB
  // so a calendar failure leaves DB+calendar consistent on the old slot.
  let newEventId: string | null = null;
  try {
    const { eventId } = await createReschedGCalEvent(
      bookingId,
      normalizedStart,
      normalizedEnd,
    );
    newEventId = eventId;
  } catch (err) {
    console.error(
      "[ParticipantReschedule] pre-create GCal failed:",
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json(
      {
        error:
          "캘린더 업데이트에 실패해 예약이 변경되지 않았습니다. 잠시 후 다시 시도해 주세요.",
      },
      { status: 502 },
    );
  }

  const update: {
    slot_start: string;
    slot_end: string;
    google_event_id?: string | null;
  } = {
    slot_start: normalizedStart,
    slot_end: normalizedEnd,
  };
  if (newEventId) update.google_event_id = newEventId;

  const { error: updateErr } = await admin
    .from("bookings")
    .update(update)
    .eq("id", bookingId);
  if (updateErr) {
    console.error(
      "[ParticipantReschedule] DB update failed after GCal create, orphan event:",
      newEventId,
    );
    // Best-effort rollback so the calendar doesn't carry a phantom
    // event that the DB never references. Failure to roll back logs
    // the orphan id so it can be cleaned up manually.
    if (newEventId && calendarId) {
      try {
        await deleteEvent(calendarId, newEventId);
      } catch (cleanupErr) {
        console.error(
          "[ParticipantReschedule] orphan GCal rollback failed; manual cleanup needed for event",
          newEventId,
          cleanupErr instanceof Error ? cleanupErr.message : cleanupErr,
        );
      }
    }
    return NextResponse.json(
      { error: "예약 변경에 실패했습니다" },
      { status: 500 },
    );
  }

  if (calendarId) {
    await invalidateCalendarCache(calendarId).catch(() => {});
  }

  // Renumber sessions chronologically — same call admin PATCH makes so
  // "1회차 was Mon, now I want it on Fri" rewrites the labels to match
  // the new chronology.
  if (booking.booking_group_id) {
    try {
      await renumberSessionsInGroup(booking.booking_group_id);
    } catch (err) {
      console.error("[ParticipantReschedule] renumber failed:", err);
    }
  }

  // Fan out the reschedule notification pipeline (email + SMS + GCal
  // cleanup + Notion mirror). We await so the booking_integrations row
  // (which now records old-event-delete failures in last_error — see
  // runReschedulePipeline) is up to date before we read it for the
  // calendar_sync_warning surface below.
  await runReschedulePipeline({
    bookingId,
    oldSlotStart,
    oldSlotEnd,
    oldEventId,
    newEventId,
  }).catch((err) => {
    console.error("[ParticipantReschedule] pipeline failed:", err);
  });

  // Surface GCal sync failures back to the participant. If the old event
  // couldn't be removed from the SLAB calendar, the lab will still see
  // the original slot until manual cleanup — the participant deserves
  // to know.
  let calendarSyncWarning: string | null = null;
  const { data: gcalRow } = await admin
    .from("booking_integrations")
    .select("status, last_error")
    .eq("booking_id", bookingId)
    .eq("integration_type", "gcal")
    .maybeSingle();
  if (gcalRow?.last_error) {
    calendarSyncWarning =
      "일정 변경은 저장되었으나 Google 캘린더의 이전 일정 정리가 완료되지 않았습니다. 담당 연구원이 확인 후 정리합니다.";
  }

  // Return the full updated group so the client can re-render with
  // renumbered session_number values.
  const { data: groupRows } = await admin
    .from("bookings")
    .select("id, slot_start, slot_end, session_number, status")
    .eq("booking_group_id", verified.bookingGroupId)
    .order("session_number", { ascending: true });

  const formRows = (groupRows ?? []).map((r) => {
    const start = new Date(r.slot_start);
    const end = new Date(r.slot_end);
    // Format in KST for the client.
    const dateFmt = new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "short",
    });
    const timeFmt = new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    return {
      id: r.id,
      slot_start: r.slot_start,
      slot_end: r.slot_end,
      session_number: r.session_number,
      status: r.status,
      slot_label_date: dateFmt.format(start),
      slot_label_time: `${timeFmt.format(start)} – ${timeFmt.format(end)}`,
    };
  });

  return NextResponse.json({ ok: true, rows: formRows, calendar_sync_warning: calendarSyncWarning });
}
