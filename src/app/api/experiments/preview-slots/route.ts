import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod/v4";
import { requireUser } from "@/lib/auth/role";
import {
  generateClassifiedSlots,
  type BusyInterval,
  type SlotStatus,
} from "@/lib/utils/slots";
import { getCachedFreeBusy } from "@/lib/google/freebusy-cache";
import { parseTimeOnDate } from "@/lib/utils/date";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_DAYS = 90;

const bodySchema = z.object({
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  daily_start_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  daily_end_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  session_duration_minutes: z.number().int().min(5).max(480),
  break_between_slots_minutes: z.number().int().min(0).max(240).default(0),
  max_participants_per_slot: z.number().int().min(1).default(1),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).default([0, 1, 2, 3, 4, 5, 6]),
  google_calendar_id: z.string().optional().nullable(),
});

interface PreviewSlot {
  slot_start: string;
  slot_end: string;
  status: SlotStatus;
  booked_count: number;
  capacity: number;
}

function* eachDate(from: string, to: string) {
  const cur = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cur <= end) {
    yield cur.toISOString().slice(0, 10);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
}

export async function POST(request: NextRequest) {
  await requireUser();

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "입력값을 확인해 주세요" },
      { status: 400 },
    );
  }

  const cfg = parsed.data;
  if (cfg.start_date > cfg.end_date) {
    return NextResponse.json({ error: "start_date는 end_date 이전이어야 합니다" }, { status: 400 });
  }

  const dayDiff =
    (new Date(`${cfg.end_date}T00:00:00Z`).getTime() -
      new Date(`${cfg.start_date}T00:00:00Z`).getTime()) /
      86_400_000 +
    1;
  if (dayDiff > MAX_DAYS) {
    return NextResponse.json({ error: `최대 ${MAX_DAYS}일까지 미리보기 가능합니다` }, { status: 400 });
  }

  const rangeStartUTC = parseTimeOnDate(cfg.start_date, "00:00").toISOString();
  const rangeEndUTC = parseTimeOnDate(cfg.end_date, "23:59").toISOString();

  let busyIntervals: BusyInterval[] = [];
  let calendarWarning: string | null = null;
  const calendarId = cfg.google_calendar_id || process.env.GOOGLE_CALENDAR_ID;
  if (calendarId) {
    try {
      // Preview is researcher-initiated; force a fresh fetch so they see
      // their own newly-added events in the calendar immediately.
      busyIntervals = await getCachedFreeBusy(
        calendarId,
        new Date(rangeStartUTC),
        new Date(rangeEndUTC),
        { force: true },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "알 수 없는 오류";
      calendarWarning = `캘린더(${calendarId}) 조회 실패 — 미리보기가 실제 예약 가능 슬롯과 다를 수 있습니다. (${msg})`;
    }
  } else {
    calendarWarning = "연결된 캘린더가 없습니다. 선택하면 실제 빈 시간 기준으로 미리볼 수 있습니다.";
  }

  const allowed = new Set(cfg.weekdays);
  const out: PreviewSlot[] = [];
  for (const date of eachDate(cfg.start_date, cfg.end_date)) {
    const dow = new Date(`${date}T09:00:00+09:00`).getDay();
    if (!allowed.has(dow)) continue;
    const classified = generateClassifiedSlots({
      date,
      dailyStartTime: cfg.daily_start_time,
      dailyEndTime: cfg.daily_end_time,
      sessionDurationMinutes: cfg.session_duration_minutes,
      breakBetweenSlotsMinutes: cfg.break_between_slots_minutes,
      busyIntervals,
      maxParticipantsPerSlot: cfg.max_participants_per_slot,
    });
    for (const s of classified) {
      out.push({
        slot_start: s.start.toISOString(),
        slot_end: s.end.toISOString(),
        status: s.status,
        booked_count: s.bookedCount,
        capacity: s.capacity,
      });
    }
  }

  return NextResponse.json({
    slots: out,
    calendarId: calendarId ?? null,
    calendarWarning,
    availableCount: out.filter((s) => s.status === "available").length,
  });
}
