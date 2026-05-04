import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  generateClassifiedSlots,
  type ClassifiedSlot,
  type SlotStatus,
} from "@/lib/utils/slots";
import type { BusyInterval } from "@/lib/utils/slots";
import { getCachedFreeBusy } from "@/lib/google/freebusy-cache";
import { isValidUUID, normalizeToISO } from "@/lib/utils/validation";
import { parseTimeOnDate } from "@/lib/utils/date";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 90;

interface RangeSlot {
  slot_start: string;
  slot_end: string;
  status: SlotStatus;
  booked_count: number;
  capacity: number;
  /** Calendar event title that conflicts with this slot, when status="busy".
   *  Null when the freebusy fallback path was used (no titles available). */
  busy_summary?: string | null;
}

function* eachDate(from: string, to: string) {
  const cur = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cur <= end) {
    yield cur.toISOString().slice(0, 10);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ experimentId: string }> },
) {
  const { experimentId } = await params;
  if (!isValidUUID(experimentId)) {
    return NextResponse.json({ error: "Invalid experiment ID" }, { status: 400 });
  }

  const { searchParams } = request.nextUrl;
  const fromParam = searchParams.get("from");
  const toParam = searchParams.get("to");

  const supabase = await createClient();
  const { data: experiment, error } = await supabase
    .from("experiments")
    .select("*")
    .eq("id", experimentId)
    .single();

  if (error || !experiment) {
    return NextResponse.json({ error: "Experiment not found" }, { status: 404 });
  }

  // Default to full experiment range if not specified
  const from = fromParam && DATE_RE.test(fromParam) ? fromParam : experiment.start_date;
  const to = toParam && DATE_RE.test(toParam) ? toParam : experiment.end_date;

  if (from > to) {
    return NextResponse.json({ error: "from은 to보다 이전이어야 합니다" }, { status: 400 });
  }

  const clampedFrom = from < experiment.start_date ? experiment.start_date : from;
  const clampedTo = to > experiment.end_date ? experiment.end_date : to;

  // Guard against huge ranges (90 days max)
  const dayDiff =
    (new Date(`${clampedTo}T00:00:00Z`).getTime() -
      new Date(`${clampedFrom}T00:00:00Z`).getTime()) /
      86_400_000 +
    1;
  if (dayDiff > MAX_DAYS) {
    return NextResponse.json(
      { error: `최대 ${MAX_DAYS}일까지 조회 가능합니다` },
      { status: 400 },
    );
  }

  // Bulk-fetch bookings across the whole range in one query
  const rangeStartUTC = parseTimeOnDate(clampedFrom, "00:00").toISOString();
  const rangeEndUTC = parseTimeOnDate(clampedTo, "23:59").toISOString();

  const { data: bookings, error: bookingsError } = await supabase
    .from("bookings")
    .select("slot_start, slot_end")
    .eq("experiment_id", experimentId)
    .eq("status", "confirmed")
    .gte("slot_start", rangeStartUTC)
    .lte("slot_start", rangeEndUTC);

  if (bookingsError) {
    return NextResponse.json(
      { error: "슬롯 조회 중 오류가 발생했습니다" },
      { status: 500 },
    );
  }

  const bookedCountPerSlot = new Map<string, number>();
  for (const b of bookings ?? []) {
    const key = `${normalizeToISO(b.slot_start)}-${normalizeToISO(b.slot_end)}`;
    bookedCountPerSlot.set(key, (bookedCountPerSlot.get(key) ?? 0) + 1);
  }

  // Single freebusy call across the whole range (best-effort)
  let busyIntervals: BusyInterval[] = [];
  let calendarWarning: string | null = null;
  // Always trim — pasted env values / DB rows often carry stray whitespace
  // that Google's API silently rejects.
  const calendarId = (
    experiment.google_calendar_id || process.env.GOOGLE_CALENDAR_ID || ""
  ).trim() || null;
  const bypassCache = request.nextUrl.searchParams.get("fresh") === "1";
  if (calendarId) {
    try {
      busyIntervals = await getCachedFreeBusy(
        calendarId,
        new Date(rangeStartUTC),
        new Date(rangeEndUTC),
        { force: bypassCache },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "알 수 없는 오류";
      calendarWarning = `연동된 캘린더(${calendarId})의 일정을 조회할 수 없습니다. 표시된 시간이 실제 캘린더와 겹칠 수 있습니다. (원인: ${msg})`;
    }
  } else {
    calendarWarning =
      "연동된 캘린더가 설정되지 않았습니다. 실험 설정에서 Google Calendar를 연결하세요.";
  }

  // Merge in researcher-declared manual blocks for this experiment
  const { data: manualBlocks } = await supabase
    .from("experiment_manual_blocks")
    .select("block_start, block_end")
    .eq("experiment_id", experimentId)
    .gte("block_start", rangeStartUTC)
    .lte("block_end", rangeEndUTC);
  for (const b of manualBlocks ?? []) {
    busyIntervals.push({ start: new Date(b.block_start), end: new Date(b.block_end) });
  }

  // Allowed weekdays in KST (0=Sun..6=Sat). Default to all if not set so
  // pre-migration experiments keep their old behaviour.
  const allowedWeekdays = new Set<number>(
    (experiment.weekdays as number[] | undefined)?.length
      ? (experiment.weekdays as number[])
      : [0, 1, 2, 3, 4, 5, 6],
  );

  const out: RangeSlot[] = [];
  for (const date of eachDate(clampedFrom, clampedTo)) {
    // Drop dates whose KST weekday isn't enabled for this experiment.
    const dow = new Date(`${date}T09:00:00+09:00`).getDay();
    if (!allowedWeekdays.has(dow)) continue;

    const classified: ClassifiedSlot[] = generateClassifiedSlots({
      date,
      dailyStartTime: experiment.daily_start_time,
      dailyEndTime: experiment.daily_end_time,
      sessionDurationMinutes: experiment.session_duration_minutes,
      breakBetweenSlotsMinutes: experiment.break_between_slots_minutes,
      busyIntervals,
      maxParticipantsPerSlot: experiment.max_participants_per_slot,
      bookedCountPerSlot,
    });
    for (const s of classified) {
      out.push({
        slot_start: s.start.toISOString(),
        slot_end: s.end.toISOString(),
        status: s.status,
        booked_count: s.bookedCount,
        capacity: s.capacity,
        busy_summary: s.busy_summary ?? null,
      });
    }
  }

  return NextResponse.json({
    from: clampedFrom,
    to: clampedTo,
    sessionDurationMinutes: experiment.session_duration_minutes,
    breakMinutes: experiment.break_between_slots_minutes,
    dailyStartTime: experiment.daily_start_time,
    dailyEndTime: experiment.daily_end_time,
    calendarId: calendarId ?? null,
    calendarWarning,
    slots: out,
  });
}
