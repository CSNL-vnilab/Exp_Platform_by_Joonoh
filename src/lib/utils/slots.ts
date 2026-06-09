import { addMinutes, intervalsOverlap, parseTimeOnDate } from "./date";

export interface TimeSlot {
  start: Date;
  end: Date;
  sessionNumber?: number;
}

export interface BusyInterval {
  start: Date;
  end: Date;
  /** Event title from Google Calendar — surfaced in the picker UI so
   *  the researcher knows *why* a slot is busy ("정원 회의" vs anonymous
   *  "busy"). Optional because the freebusy.query fallback path can't
   *  return titles. */
  summary?: string | null;
  /** Google Calendar event id (from events.list). Lets the availability
   *  layer recognise the lab's OWN booking events and drop the ones that
   *  belong to cancelled/no_show bookings — stale "orphan" events whose
   *  cancel-time delete failed. Without this an orphan keeps a slot
   *  showing "busy" forever (see freebusy-cache.excludeBookingOrphans).
   *  Null on the freebusy.query fallback path (no ids available). */
  id?: string | null;
}

interface SlotGenerationParams {
  date: string; // YYYY-MM-DD
  dailyStartTime: string; // HH:mm
  dailyEndTime: string; // HH:mm
  sessionDurationMinutes: number;
  breakBetweenSlotsMinutes: number;
  busyIntervals: BusyInterval[]; // from Google Calendar
  maxParticipantsPerSlot: number;
  /** Confirmed bookings as raw intervals. A candidate slot is "full" when
   *  the count of intervals OVERLAPPING it (slot_start < int.end AND
   *  slot_end > int.start) reaches maxParticipantsPerSlot. This mirrors
   *  book_slot's overlap-conflict gate (migration 00069) — without it, a
   *  fine slotIncrementMinutes painted phantom-available cells that the
   *  RPC then rejected at submit ("버튼 클릭 후 차단", 2026-06-09 report).
   *  For non-overlapping experiments the answer is identical to the old
   *  exact-key map (each booking's interval only overlaps the exact slot
   *  it's on). */
  bookedIntervals?: Array<{ start: Date; end: Date }>;
  /** Grid step between slot START times, in minutes. When set (and > 0) it
   *  overrides the default `sessionDuration + break` increment so an
   *  experiment can offer e.g. 30-min start steps for a 60-min session —
   *  the resulting slots OVERLAP, which book_slot's overlap-conflict check
   *  (migration 00069) handles. Null/undefined = legacy increment. */
  slotIncrementMinutes?: number | null;
}

function countOverlappingBookings(
  slotStart: Date,
  slotEnd: Date,
  intervals: Array<{ start: Date; end: Date }> | undefined,
): number {
  if (!intervals || intervals.length === 0) return 0;
  let count = 0;
  const slotStartMs = slotStart.getTime();
  const slotEndMs = slotEnd.getTime();
  for (const b of intervals) {
    if (slotStartMs < b.end.getTime() && slotEndMs > b.start.getTime()) count += 1;
  }
  return count;
}

/**
 * Generate available time slots for a given date.
 *
 * 1. Create candidate slots from daily start to end time in duration + break increments
 * 2. Remove slots that overlap with Google Calendar busy intervals
 * 3. Remove slots that are fully booked (confirmed count >= max)
 */
export function generateAvailableSlots(
  params: SlotGenerationParams
): TimeSlot[] {
  const {
    date,
    dailyStartTime,
    dailyEndTime,
    sessionDurationMinutes,
    breakBetweenSlotsMinutes,
    busyIntervals,
    maxParticipantsPerSlot,
    bookedIntervals,
  } = params;

  const dayStart = parseTimeOnDate(date, dailyStartTime);
  const dayEnd = parseTimeOnDate(date, dailyEndTime);
  const incrementMinutes =
    params.slotIncrementMinutes && params.slotIncrementMinutes > 0
      ? params.slotIncrementMinutes
      : sessionDurationMinutes + breakBetweenSlotsMinutes;

  const available: TimeSlot[] = [];
  let current = dayStart;

  const now = new Date();
  while (current < dayEnd) {
    const slotEnd = addMinutes(current, sessionDurationMinutes);

    // Slot must not extend past daily end time
    if (slotEnd > dayEnd) break;

    const slot: TimeSlot = { start: current, end: slotEnd };

    // Check overlap with busy intervals (Google Calendar)
    const isBusy = busyIntervals.some((busy) =>
      intervalsOverlap(slot, busy)
    );

    // Capacity check — overlap-aware so it matches book_slot's RPC gate.
    const bookedCount = countOverlappingBookings(current, slotEnd, bookedIntervals);
    const isFullyBooked = bookedCount >= maxParticipantsPerSlot;

    // Past slots cannot be booked — DB-layer guard returns 400 ("이미 지난
    // 시간대는 예약할 수 없습니다"); pre-filter here so the picker doesn't
    // show selectable cells the API will reject.
    const isPast = current < now;

    if (!isBusy && !isFullyBooked && !isPast) {
      available.push(slot);
    }

    current = addMinutes(current, incrementMinutes);
  }

  return available;
}

/**
 * Serialize a slot for API response / client display.
 */
export function serializeSlot(slot: TimeSlot) {
  return {
    slot_start: slot.start.toISOString(),
    slot_end: slot.end.toISOString(),
    session_number: slot.sessionNumber,
  };
}

export type SlotStatus = "available" | "busy" | "full";

export interface ClassifiedSlot {
  start: Date;
  end: Date;
  status: SlotStatus;
  bookedCount: number;
  capacity: number;
  /** When status="busy", the title of the conflicting calendar event
   *  (if available). Lets the picker tooltip explain *why* the slot
   *  is taken instead of just rendering it gray. */
  busy_summary?: string | null;
}

/**
 * Variant of generateAvailableSlots that classifies every candidate slot
 * (available / calendar-busy / fully-booked) instead of filtering. Used by
 * the week-timetable view so the researcher-facing grid can show all cells.
 */
export function generateClassifiedSlots(
  params: SlotGenerationParams,
): ClassifiedSlot[] {
  const {
    date,
    dailyStartTime,
    dailyEndTime,
    sessionDurationMinutes,
    breakBetweenSlotsMinutes,
    busyIntervals,
    maxParticipantsPerSlot,
    bookedIntervals,
  } = params;

  const dayStart = parseTimeOnDate(date, dailyStartTime);
  const dayEnd = parseTimeOnDate(date, dailyEndTime);
  const incrementMinutes =
    params.slotIncrementMinutes && params.slotIncrementMinutes > 0
      ? params.slotIncrementMinutes
      : sessionDurationMinutes + breakBetweenSlotsMinutes;

  const result: ClassifiedSlot[] = [];
  let current = dayStart;
  const now = new Date();

  while (current < dayEnd) {
    const slotEnd = addMinutes(current, sessionDurationMinutes);
    if (slotEnd > dayEnd) break;

    const overlapping = busyIntervals.find((busy) =>
      intervalsOverlap({ start: current, end: slotEnd }, busy),
    );
    const isBusy = !!overlapping;

    // Capacity check — overlap-aware so it matches book_slot's RPC gate.
    const bookedCount = countOverlappingBookings(current, slotEnd, bookedIntervals);
    const isFullyBooked = bookedCount >= maxParticipantsPerSlot;

    // A slot whose start is in the past is unbookable — keep "full" status
    // so the picker renders it as gray/disabled. Backend already rejects.
    const isPast = current < now;

    const status: SlotStatus = isPast
      ? "full"
      : isBusy
        ? "busy"
        : isFullyBooked
          ? "full"
          : "available";
    result.push({
      start: current,
      end: slotEnd,
      status,
      bookedCount,
      capacity: maxParticipantsPerSlot,
      busy_summary: isBusy ? overlapping.summary ?? null : null,
    });

    current = addMinutes(current, incrementMinutes);
  }

  return result;
}
