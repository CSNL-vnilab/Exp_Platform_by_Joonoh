import { addMinutes, intervalsOverlap, parseTimeOnDate } from "./date";

export interface TimeSlot {
  start: Date;
  end: Date;
  sessionNumber?: number;
}

export interface BusyInterval {
  start: Date;
  end: Date;
}

interface SlotGenerationParams {
  date: string; // YYYY-MM-DD
  dailyStartTime: string; // HH:mm
  dailyEndTime: string; // HH:mm
  sessionDurationMinutes: number;
  breakBetweenSlotsMinutes: number;
  busyIntervals: BusyInterval[]; // from Google Calendar
  maxParticipantsPerSlot: number;
  bookedCountPerSlot?: Map<string, number>; // key: "startISO-endISO", value: count
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
    bookedCountPerSlot,
  } = params;

  const dayStart = parseTimeOnDate(date, dailyStartTime);
  const dayEnd = parseTimeOnDate(date, dailyEndTime);
  const incrementMinutes = sessionDurationMinutes + breakBetweenSlotsMinutes;

  const available: TimeSlot[] = [];
  let current = dayStart;

  while (current < dayEnd) {
    const slotEnd = addMinutes(current, sessionDurationMinutes);

    // Slot must not extend past daily end time
    if (slotEnd > dayEnd) break;

    const slot: TimeSlot = { start: current, end: slotEnd };

    // Check overlap with busy intervals (Google Calendar)
    const isBusy = busyIntervals.some((busy) =>
      intervalsOverlap(slot, busy)
    );

    // Check if fully booked
    const slotKey = `${current.toISOString()}-${slotEnd.toISOString()}`;
    const bookedCount = bookedCountPerSlot?.get(slotKey) ?? 0;
    const isFullyBooked = bookedCount >= maxParticipantsPerSlot;

    if (!isBusy && !isFullyBooked) {
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
    bookedCountPerSlot,
  } = params;

  const dayStart = parseTimeOnDate(date, dailyStartTime);
  const dayEnd = parseTimeOnDate(date, dailyEndTime);
  const incrementMinutes = sessionDurationMinutes + breakBetweenSlotsMinutes;

  const result: ClassifiedSlot[] = [];
  let current = dayStart;

  while (current < dayEnd) {
    const slotEnd = addMinutes(current, sessionDurationMinutes);
    if (slotEnd > dayEnd) break;

    const isBusy = busyIntervals.some((busy) =>
      intervalsOverlap({ start: current, end: slotEnd }, busy),
    );

    const slotKey = `${current.toISOString()}-${slotEnd.toISOString()}`;
    const bookedCount = bookedCountPerSlot?.get(slotKey) ?? 0;
    const isFullyBooked = bookedCount >= maxParticipantsPerSlot;

    const status: SlotStatus = isBusy ? "busy" : isFullyBooked ? "full" : "available";
    result.push({
      start: current,
      end: slotEnd,
      status,
      bookedCount,
      capacity: maxParticipantsPerSlot,
    });

    current = addMinutes(current, incrementMinutes);
  }

  return result;
}
