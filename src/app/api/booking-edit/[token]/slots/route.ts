import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifyBookingEditTokenOrError } from "@/lib/booking-edit/access";
import {
  readVerifySession,
  BOOKING_EDIT_SESSION_COOKIE,
} from "@/lib/booking-edit/session";
import {
  generateClassifiedSlots,
  type ClassifiedSlot,
  type SlotStatus,
  type BusyInterval,
} from "@/lib/utils/slots";
import { getCachedFreeBusy } from "@/lib/google/freebusy-cache";
import { isValidUUID } from "@/lib/utils/validation";
import { parseTimeOnDate } from "@/lib/utils/date";
import { BOOKING_EDIT_CUTOFF_HOURS } from "@/lib/utils/constants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Token-scoped available-slot engine for the participant reschedule picker.
//
// Why this exists (2026-07): the reschedule UI used a free-form
// `<input type="datetime-local">` — a participant could type any time,
// including one already taken, outside operating hours, on a non-operating
// weekday, or colliding with a Google-Calendar event. Those only surfaced
// (partially) at submit or at experimenter approval. This endpoint feeds an
// available-only week grid (the same one the public booking flow uses), so
// the participant can only pick a slot that is actually bookable.
//
// It mirrors GET /api/experiments/[experimentId]/slots/range but:
//   * Auth is the booking-edit HMAC token + be_session cookie (NOT a public
//     experimentId path) — the token carries only bookingGroupId, so the
//     experiment_id is resolved SERVER-SIDE from the group's bookings and is
//     never accepted from the client.
//   * Uses the service-role admin client (booking-edit is unauthenticated +
//     cookie-gated) so it works even when the experiment isn't `active` and
//     can read confirmed bookings (anon RLS forbids both).
//   * Excludes the booking being rescheduled (?exclude=<bookingId>, validated
//     to belong to the group) from the capacity count, so the participant's
//     own current slot isn't shown as full.
//   * Downgrades slots earlier than now + BOOKING_EDIT_CUTOFF_HOURS to "full"
//     so the grid never offers a slot the reschedule PATCH will reject for
//     the cutoff.
//
// Availability here is ADVISORY (best-effort, cached freebusy). The authority
// is apply_reschedule_request under the book_slot advisory lock at approval
// time; a slot shown available can still be taken before the experimenter
// approves — the server re-checks and the UI surfaces its Korean error.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 90;
const DEFAULT_WINDOW_DAYS = 60;

function todayKST(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function addDaysISO(dateIso: string, days: number): string {
  const d = new Date(`${dateIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function maxDate(a: string, b: string): string {
  return a > b ? a : b;
}
function minDate(a: string, b: string): string {
  return a < b ? a : b;
}

function* eachDate(from: string, to: string) {
  const cur = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cur <= end) {
    yield cur.toISOString().slice(0, 10);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
}

interface RangeSlot {
  slot_start: string;
  slot_end: string;
  status: SlotStatus;
  booked_count: number;
  capacity: number;
  busy_summary?: string | null;
}

interface ExperimentConfig {
  start_date: string;
  end_date: string;
  daily_start_time: string;
  daily_end_time: string;
  session_duration_minutes: number;
  break_between_slots_minutes: number;
  slot_increment_minutes: number | null;
  max_participants_per_slot: number;
  weekdays: number[] | null;
  google_calendar_id: string | null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;

  // 1. Token gate (HMAC, 60-day TTL). verifyBookingEditTokenOrError returns a
  //    NextResponse on failure with the participant-facing Korean copy.
  const tokenResult = verifyBookingEditTokenOrError(token);
  if (tokenResult instanceof NextResponse) return tokenResult;
  const verified = tokenResult;

  // 2. Identity gate — the be_session cookie must be present and scoped to
  //    this token's booking group (same check the page + reschedule route use).
  const cookieJar = await cookies();
  const session = readVerifySession(
    cookieJar.get(BOOKING_EDIT_SESSION_COOKIE)?.value,
    verified.bookingGroupId,
  );
  if (!session) {
    return NextResponse.json(
      { error: "본인 확인이 필요합니다. 페이지를 새로고침해 주세요." },
      { status: 401 },
    );
  }

  const admin = createAdminClient();

  // 3. Resolve the experiment + its config FROM THE GROUP — never from the
  //    client. The token only encodes bookingGroupId.
  const { data: groupRow, error: groupErr } = await admin
    .from("bookings")
    .select(
      "experiment_id, experiments(start_date, end_date, daily_start_time, daily_end_time, session_duration_minutes, break_between_slots_minutes, slot_increment_minutes, max_participants_per_slot, weekdays, google_calendar_id)",
    )
    .eq("booking_group_id", verified.bookingGroupId)
    .limit(1)
    .maybeSingle();

  const group = groupRow as unknown as {
    experiment_id: string;
    experiments: ExperimentConfig | null;
  } | null;

  if (groupErr || !group || !group.experiments) {
    return NextResponse.json(
      { error: "실험 정보를 찾을 수 없습니다" },
      { status: 404 },
    );
  }

  const experimentId = group.experiment_id;
  const exp = group.experiments;

  // 4. Optional self-exclusion: the booking being rescheduled. Validated to
  //    belong to this group before use so a participant can't drop someone
  //    else's booking from the capacity count.
  const excludeParam = request.nextUrl.searchParams.get("exclude");
  let excludeBookingId: string | null = null;
  if (excludeParam && isValidUUID(excludeParam)) {
    const { data: own } = await admin
      .from("bookings")
      .select("id, experiment_id")
      .eq("id", excludeParam)
      .eq("booking_group_id", verified.bookingGroupId)
      .maybeSingle();
    // Belongs to the group AND to this experiment before we let it drop a row
    // from the experiment-scoped capacity count (makes the one-group-per-
    // experiment invariant load-bearing-explicit rather than incidental).
    if (own && (own as { experiment_id: string }).experiment_id === experimentId) {
      excludeBookingId = excludeParam;
    }
  }

  // 5. Window: anchor at today (KST), never before start_date; default 60-day
  //    window, hard cap 90. Past weeks are never fetched.
  const { searchParams } = request.nextUrl;
  const fromParam = searchParams.get("from");
  const toParam = searchParams.get("to");
  const today = todayKST();
  const defaultFrom = maxDate(today, exp.start_date);
  // Anchor the default window on the requested `from` (when `to` is omitted)
  // so a future-week scroll request returns that week, not an empty envelope
  // anchored back near today.
  const windowAnchor =
    fromParam && DATE_RE.test(fromParam)
      ? maxDate(fromParam, defaultFrom)
      : defaultFrom;
  const defaultTo = minDate(
    exp.end_date,
    addDaysISO(windowAnchor, DEFAULT_WINDOW_DAYS - 1),
  );
  const from = fromParam && DATE_RE.test(fromParam) ? fromParam : defaultFrom;
  const to = toParam && DATE_RE.test(toParam) ? toParam : defaultTo;
  let clampedFrom = maxDate(from, exp.start_date);
  clampedFrom = maxDate(clampedFrom, today);
  const clampedTo = minDate(to, exp.end_date);

  const emptyEnvelope = {
    from: clampedFrom,
    to: clampedTo,
    sessionDurationMinutes: exp.session_duration_minutes,
    breakMinutes: exp.break_between_slots_minutes,
    dailyStartTime: exp.daily_start_time,
    dailyEndTime: exp.daily_end_time,
    calendarId: null as string | null,
    calendarWarning: null as string | null,
    slots: [] as RangeSlot[],
  };

  if (clampedFrom > clampedTo) {
    return NextResponse.json(emptyEnvelope);
  }

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

  const rangeStartUTC = parseTimeOnDate(clampedFrom, "00:00").toISOString();
  const rangeEndUTC = parseTimeOnDate(clampedTo, "23:59").toISOString();

  // 6. Confirmed bookings for capacity — self-excluded so the participant's
  //    own current slot doesn't count as taken.
  let bookingsQuery = admin
    .from("bookings")
    .select("slot_start, slot_end")
    .eq("experiment_id", experimentId)
    .eq("status", "confirmed")
    .gte("slot_start", rangeStartUTC)
    .lte("slot_start", rangeEndUTC);
  if (excludeBookingId) {
    bookingsQuery = bookingsQuery.neq("id", excludeBookingId);
  }
  const { data: bookings, error: bookingsError } = await bookingsQuery;

  if (bookingsError) {
    return NextResponse.json(
      { error: "슬롯 조회 중 오류가 발생했습니다" },
      { status: 500 },
    );
  }

  const bookedIntervals = (bookings ?? []).map((b) => ({
    start: new Date(b.slot_start),
    end: new Date(b.slot_end),
  }));

  // 7. Google Calendar free/busy (best-effort) + researcher manual blocks.
  let busyIntervals: BusyInterval[] = [];
  let calendarWarning: string | null = null;
  const calendarId =
    (exp.google_calendar_id || process.env.GOOGLE_CALENDAR_ID || "").trim() ||
    null;
  const bypassCache = searchParams.get("fresh") === "1";
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
      calendarWarning = `연동된 캘린더의 일정을 조회할 수 없습니다. 표시된 시간이 실제 캘린더와 겹칠 수 있습니다. (원인: ${msg})`;
    }
  } else {
    calendarWarning =
      "연동된 캘린더가 설정되지 않아 캘린더 겹침이 반영되지 않을 수 있습니다.";
  }

  // Overlap semantics (not containment): a block that STARTS before the
  // window or ENDS after it still overlaps slots inside the window. Matches
  // the confirmed-booking overlap gate; a straddling/overnight block would
  // otherwise be dropped and its slots shown available.
  const { data: manualBlocks } = await admin
    .from("experiment_manual_blocks")
    .select("block_start, block_end")
    .eq("experiment_id", experimentId)
    .lt("block_start", rangeEndUTC)
    .gt("block_end", rangeStartUTC);
  for (const b of manualBlocks ?? []) {
    busyIntervals.push({
      start: new Date(b.block_start),
      end: new Date(b.block_end),
    });
  }

  const allowedWeekdays = new Set<number>(
    exp.weekdays?.length ? exp.weekdays : [0, 1, 2, 3, 4, 5, 6],
  );

  // The reschedule PATCH rejects a NEW slot earlier than now + cutoff. Mark
  // any such slot "full" so the grid greys it out (never offers a slot the
  // server will refuse). generateClassifiedSlots already marks past slots
  // full; this extends the floor to the cutoff.
  const cutoffMs = Date.now() + BOOKING_EDIT_CUTOFF_HOURS * 60 * 60 * 1000;

  const out: RangeSlot[] = [];
  for (const date of eachDate(clampedFrom, clampedTo)) {
    const dow = new Date(`${date}T09:00:00+09:00`).getDay();
    if (!allowedWeekdays.has(dow)) continue;

    const classified: ClassifiedSlot[] = generateClassifiedSlots({
      date,
      dailyStartTime: exp.daily_start_time,
      dailyEndTime: exp.daily_end_time,
      sessionDurationMinutes: exp.session_duration_minutes,
      breakBetweenSlotsMinutes: exp.break_between_slots_minutes,
      busyIntervals,
      maxParticipantsPerSlot: exp.max_participants_per_slot,
      bookedIntervals,
      slotIncrementMinutes: exp.slot_increment_minutes ?? undefined,
    });
    for (const s of classified) {
      const withinCutoff =
        s.status === "available" && s.start.getTime() < cutoffMs;
      out.push({
        slot_start: s.start.toISOString(),
        slot_end: s.end.toISOString(),
        status: withinCutoff ? "full" : s.status,
        booked_count: s.bookedCount,
        capacity: s.capacity,
        busy_summary: s.busy_summary ?? null,
      });
    }
  }

  return NextResponse.json({
    from: clampedFrom,
    to: clampedTo,
    sessionDurationMinutes: exp.session_duration_minutes,
    breakMinutes: exp.break_between_slots_minutes,
    dailyStartTime: exp.daily_start_time,
    dailyEndTime: exp.daily_end_time,
    calendarId,
    calendarWarning,
    slots: out,
  });
}
