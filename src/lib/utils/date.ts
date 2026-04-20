import { format, parse, addMinutes, isWithinInterval } from "date-fns";
import { toZonedTime, fromZonedTime } from "date-fns-tz";

const KST = "Asia/Seoul";

// Convert UTC Date to KST Date
export function toKST(date: Date): Date {
  return toZonedTime(date, KST);
}

// Convert KST Date to UTC Date
export function fromKST(date: Date): Date {
  return fromZonedTime(date, KST);
}

// Format date for Korean display: 2024년 3월 15일
export function formatDateKR(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const kst = toKST(d);
  return format(kst, "yyyy년 M월 d일");
}

// Format time for Korean display: 14:00
export function formatTimeKR(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const kst = toKST(d);
  return format(kst, "HH:mm");
}

// Format date + time: 2024년 3월 15일 14:00
export function formatDateTimeKR(date: Date | string): string {
  return `${formatDateKR(date)} ${formatTimeKR(date)}`;
}

// Format date as ISO string (YYYY-MM-DD)
export function formatISO(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

// Parse time string "HH:mm" or "HH:mm:ss" on a given date (in KST) and return UTC Date
export function parseTimeOnDate(
  dateStr: string,
  timeStr: string
): Date {
  // Postgres `time` columns serialise as HH:MM:SS; normalise to HH:mm.
  const normalized = timeStr.length >= 5 ? timeStr.slice(0, 5) : timeStr;
  const kstDate = parse(
    `${dateStr} ${normalized}`,
    "yyyy-MM-dd HH:mm",
    new Date()
  );
  return fromKST(kstDate);
}

// Check if two time intervals overlap
export function intervalsOverlap(
  a: { start: Date; end: Date },
  b: { start: Date; end: Date }
): boolean {
  return a.start < b.end && a.end > b.start;
}

// Add minutes to a date
export { addMinutes };
