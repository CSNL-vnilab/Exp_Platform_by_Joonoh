import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { z } from "zod/v4";
import { isValidUUID, normalizeToISO } from "@/lib/utils/validation";
import { getFreeBusy, deleteEvent } from "@/lib/google/calendar";
import { invalidateCalendarCache } from "@/lib/google/freebusy-cache";
import { intervalsOverlap } from "@/lib/utils/date";
import {
  createReschedGCalEvent,
  runReschedulePipeline,
} from "@/lib/services/booking.service";

// Valid status transitions: prevents going back from terminal states.
// 'running' is set automatically when /run mints a completion code —
// researchers typically only transition running → completed (after verifying
// the completion code) or running → cancelled (participant abandoned the run).
const VALID_TRANSITIONS: Record<string, string[]> = {
  confirmed: ["cancelled", "completed", "no_show", "running"],
  running: ["cancelled", "completed", "no_show"],
  cancelled: [],
  completed: [],
  no_show: [],
};

const bookingStatusSchema = z.object({
  status: z.enum(["confirmed", "cancelled", "completed", "no_show", "running"]),
});

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ bookingId: string }> }
) {
  try {
    const { bookingId } = await params;

    if (!isValidUUID(bookingId)) {
      return NextResponse.json({ error: "Invalid booking ID" }, { status: 400 });
    }

    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Fetch booking with experiment data to check ownership
    const { data: booking, error: bookingError } = await supabase
      .from("bookings")
      .select("*, experiments(created_by)")
      .eq("id", bookingId)
      .single();

    if (bookingError || !booking) {
      return NextResponse.json({ error: "Booking not found" }, { status: 404 });
    }

    const experiment = booking.experiments as { created_by: string | null } | null;
    if (!experiment || experiment.created_by !== user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    return NextResponse.json({ booking });
  } catch (err) {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ bookingId: string }> }
) {
  try {
    const { bookingId } = await params;

    if (!isValidUUID(bookingId)) {
      return NextResponse.json({ error: "Invalid booking ID" }, { status: 400 });
    }

    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Fetch booking with experiment to verify admin ownership. Also pull
    // google_event_id + calendar id so a cancellation can clean up GCal.
    const { data: booking, error: bookingError } = await supabase
      .from("bookings")
      .select(
        "id, status, google_event_id, experiments(created_by, google_calendar_id)",
      )
      .eq("id", bookingId)
      .single();

    if (bookingError || !booking) {
      return NextResponse.json({ error: "Booking not found" }, { status: 404 });
    }

    const experiment = booking.experiments as
      | { created_by: string | null; google_calendar_id: string | null }
      | null;
    if (!experiment || experiment.created_by !== user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const result = bookingStatusSchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        { error: "Validation failed", issues: result.error.issues },
        { status: 400 }
      );
    }

    const { status } = result.data;

    // Validate status transition
    const allowed = VALID_TRANSITIONS[booking.status] ?? [];
    if (!allowed.includes(status)) {
      return NextResponse.json(
        { error: `상태를 '${booking.status}'에서 '${status}'(으)로 변경할 수 없습니다` },
        { status: 400 }
      );
    }

    const { data: updated, error: updateError } = await supabase
      .from("bookings")
      .update({ status })
      .eq("id", bookingId)
      .select()
      .single();

    if (updateError) {
      return NextResponse.json({ error: "상태 업데이트 중 오류가 발생했습니다" }, { status: 500 });
    }

    // When a booking is cancelled, delete the Google Calendar event (if any)
    // so participants don't see a stale invite; also invalidate freebusy cache.
    if (status === "cancelled" && booking.google_event_id) {
      const calId = (
        experiment.google_calendar_id || process.env.GOOGLE_CALENDAR_ID || ""
      ).trim();
      if (calId) {
        try {
          await deleteEvent(calId, booking.google_event_id);
          await supabase
            .from("bookings")
            .update({ google_event_id: null })
            .eq("id", bookingId);
          await invalidateCalendarCache(calId).catch(() => {});
        } catch (err) {
          console.error(
            "[CancelBooking] deleteEvent failed:",
            err instanceof Error ? err.message : err,
          );
        }
      }
    }

    // Pending reminders are already guarded at send time: reminder.service skips
    // bookings with status='cancelled' and marks them 'sent', so no update needed.

    return NextResponse.json({ booking: updated });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// PATCH — reschedule an existing booking to a different slot. Admin or the
// experiment owner (researcher) may reschedule. New slot must be in the
// future, land on an allowed weekday, not clash with another confirmed
// booking, and not overlap a busy interval on the experiment's calendar.
const rescheduleSchema = z.object({
  slot_start: z.string().datetime(),
  slot_end: z.string().datetime(),
  session_number: z.number().int().min(1).optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ bookingId: string }> },
) {
  const { bookingId } = await params;
  if (!isValidUUID(bookingId)) {
    return NextResponse.json({ error: "잘못된 예약 ID입니다" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data: booking, error: fetchErr } = await admin
    .from("bookings")
    .select(
      "id, status, experiment_id, slot_start, slot_end, session_number, google_event_id, experiments(created_by, weekdays, max_participants_per_slot, google_calendar_id, status)",
    )
    .eq("id", bookingId)
    .single();

  if (fetchErr || !booking) {
    return NextResponse.json({ error: "예약을 찾을 수 없습니다" }, { status: 404 });
  }

  const exp = booking.experiments as unknown as {
    created_by: string | null;
    weekdays: number[];
    max_participants_per_slot: number;
    google_calendar_id: string | null;
    status: string;
  };

  const { data: profile } = await admin
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  const isAdmin = profile?.role === "admin";
  if (!isAdmin && exp.created_by !== user.id) {
    return NextResponse.json({ error: "권한이 없습니다" }, { status: 403 });
  }

  if (booking.status !== "confirmed") {
    return NextResponse.json(
      { error: "확정 상태의 예약만 변경할 수 있습니다" },
      { status: 400 },
    );
  }

  const parsed = rescheduleSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "잘못된 요청입니다" },
      { status: 400 },
    );
  }

  const newStart = new Date(parsed.data.slot_start);
  const newEnd = new Date(parsed.data.slot_end);
  if (newStart <= new Date()) {
    return NextResponse.json({ error: "이미 지난 시간으로는 변경할 수 없습니다" }, { status: 400 });
  }
  if (newEnd <= newStart) {
    return NextResponse.json({ error: "종료 시간이 시작 시간보다 이후여야 합니다" }, { status: 400 });
  }

  // Weekday check (KST)
  const kstParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(newStart);
  const kstDateStr = `${kstParts.find((p) => p.type === "year")!.value}-${kstParts.find((p) => p.type === "month")!.value}-${kstParts.find((p) => p.type === "day")!.value}`;
  const kstDow = new Date(`${kstDateStr}T09:00:00+09:00`).getDay();
  if (!exp.weekdays.includes(kstDow)) {
    return NextResponse.json({ error: "실험 운영 요일이 아닙니다" }, { status: 400 });
  }

  // Capacity check (excluding this booking)
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

  // GCal busy check (best-effort, ignore the booking's own event)
  const calendarId = (exp.google_calendar_id || process.env.GOOGLE_CALENDAR_ID || "").trim() || null;
  if (calendarId) {
    try {
      const busy = await getFreeBusy(calendarId, newStart, newEnd);
      const conflict = busy.some((b) => {
        // Skip busy intervals that coincide with this booking's existing event
        // (we'll delete that event anyway)
        if (
          Math.abs(b.start.getTime() - new Date(booking.slot_start).getTime()) < 60_000 &&
          Math.abs(b.end.getTime() - new Date(booking.slot_end).getTime()) < 60_000
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

  // Atomicity (P2-1): create the new GCal event BEFORE touching the DB.
  // If GCal fails synchronously, DB and calendar both stay on the old slot
  // so the researcher can retry without being in an in-between state. Worst
  // case is a spare calendar event (if the DB update later fails), which is
  // preferable to a missing one.
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
      "[Reschedule] pre-create GCal failed:",
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
    session_number?: number;
    google_event_id?: string | null;
  } = {
    slot_start: normalizedStart,
    slot_end: normalizedEnd,
  };
  if (parsed.data.session_number !== undefined) {
    update.session_number = parsed.data.session_number;
  }
  if (newEventId) {
    update.google_event_id = newEventId;
  }

  const { error: updateErr } = await admin.from("bookings").update(update).eq("id", bookingId);
  if (updateErr) {
    // DB update failed AFTER new GCal event created. Best we can do is log
    // the orphan id and return the error — next outbox sweep or a manual
    // cleanup has to fix it. Participant sees old time (DB unchanged);
    // orphan event on calendar is the lesser evil.
    console.error(
      "[Reschedule] DB update failed after GCal create, orphan event:",
      newEventId,
    );
    return NextResponse.json({ error: "예약 변경에 실패했습니다" }, { status: 500 });
  }

  await runReschedulePipeline({
    bookingId,
    oldSlotStart,
    oldSlotEnd,
    oldEventId,
    newEventId,
  }).catch((err) => {
    console.error("[Reschedule] pipeline failed:", err);
  });

  return NextResponse.json({ ok: true });
}
