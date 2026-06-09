import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { generateAvailableSlots, serializeSlot } from "@/lib/utils/slots";
import type { BusyInterval } from "@/lib/utils/slots";
import { getFreeBusy } from "@/lib/google/calendar";
import { excludeBookingOrphans } from "@/lib/google/freebusy-cache";
import { isValidUUID } from "@/lib/utils/validation";
import { parseTimeOnDate } from "@/lib/utils/date";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ experimentId: string }> }
) {
  try {
    const { experimentId } = await params;

    if (!isValidUUID(experimentId)) {
      return NextResponse.json({ error: "Invalid experiment ID" }, { status: 400 });
    }

    const { searchParams } = request.nextUrl;
    const date = searchParams.get("date");

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json(
        { error: "Query param ?date=YYYY-MM-DD is required" },
        { status: 400 }
      );
    }

    const supabase = await createClient();

    // Fetch experiment
    const { data: experiment, error: experimentError } = await supabase
      .from("experiments")
      .select("*")
      .eq("id", experimentId)
      .single();

    if (experimentError || !experiment) {
      return NextResponse.json({ error: "Experiment not found" }, { status: 404 });
    }

    // Validate date is within experiment range
    if (date < experiment.start_date || date > experiment.end_date) {
      return NextResponse.json({ error: "선택한 날짜가 실험 기간 범위를 벗어납니다" }, { status: 400 });
    }

    // KST-aware day boundaries: convert the requested date's daily window to UTC
    const dayStartUTC = parseTimeOnDate(date, "00:00");
    const dayEndUTC = parseTimeOnDate(date, "23:59");
    const dayStart = dayStartUTC.toISOString();
    const dayEnd = dayEndUTC.toISOString();

    const { data: bookings, error: bookingsError } = await supabase
      .from("bookings")
      .select("slot_start, slot_end")
      .eq("experiment_id", experimentId)
      .eq("status", "confirmed")
      .gte("slot_start", dayStart)
      .lte("slot_start", dayEnd);

    if (bookingsError) {
      return NextResponse.json({ error: "슬롯 조회 중 오류가 발생했습니다" }, { status: 500 });
    }

    // Overlap-aware capacity input (see range/route.ts for rationale).
    const bookedIntervals = (bookings ?? []).map((b) => ({
      start: new Date(b.slot_start),
      end: new Date(b.slot_end),
    }));

    // Fetch Google Calendar busy intervals
    let busyIntervals: BusyInterval[] = [];
    const calendarId =
      experiment.google_calendar_id || process.env.GOOGLE_CALENDAR_ID;

    if (calendarId) {
      try {
        busyIntervals = await excludeBookingOrphans(
          await getFreeBusy(calendarId, new Date(dayStart), new Date(dayEnd)),
        );
      } catch {
        // GCal is best-effort — continue with empty busy intervals
      }
    }

    const slots = generateAvailableSlots({
      date,
      dailyStartTime: experiment.daily_start_time,
      dailyEndTime: experiment.daily_end_time,
      sessionDurationMinutes: experiment.session_duration_minutes,
      breakBetweenSlotsMinutes: experiment.break_between_slots_minutes,
      busyIntervals,
      maxParticipantsPerSlot: experiment.max_participants_per_slot,
      bookedIntervals,
      slotIncrementMinutes: experiment.slot_increment_minutes,
    });

    return NextResponse.json({ slots: slots.map(serializeSlot) });
  } catch (err) {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
