"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/ui/toast";
import type { Experiment } from "@/types/database";

export interface SerializedSlot {
  slot_start: string;
  slot_end: string;
  session_number?: number;
}

type SlotStatus = "available" | "busy" | "full";

interface RangeSlot {
  slot_start: string;
  slot_end: string;
  status: SlotStatus;
  booked_count: number;
  capacity: number;
}

interface WeekTimetableProps {
  experimentId: string;
  experiment: Experiment;
  selectedSlots: SerializedSlot[];
  onChange: (slots: SerializedSlot[]) => void;
}

const KST = "Asia/Seoul";
const DAY_MS = 86_400_000;

const dateFmt = new Intl.DateTimeFormat("ko-KR", {
  timeZone: KST,
  month: "numeric",
  day: "numeric",
});
const weekdayFmt = new Intl.DateTimeFormat("ko-KR", {
  timeZone: KST,
  weekday: "short",
});
const timeFmt = new Intl.DateTimeFormat("ko-KR", {
  timeZone: KST,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function kstDateKey(iso: string): string {
  // Format YYYY-MM-DD in KST
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: KST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  return `${y}-${m}-${d}`;
}

function kstTimeKey(iso: string): string {
  return timeFmt.format(new Date(iso));
}

function kstDayOfWeek(iso: string): number {
  // 0=Sun, 1=Mon, ... 6=Sat (KST)
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: KST,
    weekday: "short",
  }).format(new Date(iso));
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
}

// Monday-start week key (YYYY-MM-DD of the Monday in KST)
function weekStartKey(dateKey: string): string {
  const iso = `${dateKey}T00:00:00+09:00`;
  const dow = kstDayOfWeek(iso); // 0=Sun..6=Sat
  const offset = dow === 0 ? -6 : 1 - dow; // shift back to Monday
  const d = new Date(new Date(iso).getTime() + offset * DAY_MS);
  return kstDateKey(d.toISOString());
}

interface DayColumn {
  dateKey: string;      // YYYY-MM-DD
  dateLabel: string;    // "4/21"
  weekdayLabel: string; // "월"
  isWeekend: boolean;
  slotsByTime: Map<string, RangeSlot>;
}

function buildDayColumn(dk: string): DayColumn {
  const iso = `${dk}T09:00:00+09:00`;
  const dow = kstDayOfWeek(iso);
  return {
    dateKey: dk,
    dateLabel: dateFmt.format(new Date(iso)),
    weekdayLabel: weekdayFmt.format(new Date(iso)),
    isWeekend: dow === 0 || dow === 6,
    slotsByTime: new Map(),
  };
}

interface WeekBlock {
  weekKey: string;
  label: string;
  days: DayColumn[];    // always 7 entries (Mon-Sun), some may be empty
}

export function WeekTimetable({
  experimentId,
  experiment,
  selectedSlots,
  onChange,
}: WeekTimetableProps) {
  const { toast } = useToast();
  const [slots, setSlots] = useState<RangeSlot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [calendarWarning, setCalendarWarning] = useState<string | null>(null);
  const selectedRef = useRef(selectedSlots);
  useEffect(() => {
    selectedRef.current = selectedSlots;
  }, [selectedSlots]);

  const requiredSessions =
    experiment.session_type === "multi" ? experiment.required_sessions : 1;
  const enforceUniqueDate = experiment.session_type === "multi";

  const fetchRange = useCallback(async (opts: { force?: boolean } = {}) => {
    setLoading(true);
    setError(null);
    try {
      const qs = opts.force ? "&fresh=1" : "";
      const res = await fetch(
        `/api/experiments/${experimentId}/slots/range?from=${experiment.start_date}&to=${experiment.end_date}${qs}`,
      );
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "슬롯 조회 실패");
        setSlots([]);
        setCalendarWarning(null);
      } else {
        setSlots(data.slots ?? []);
        setCalendarWarning(data.calendarWarning ?? null);
      }
    } catch {
      setError("네트워크 오류");
      setSlots([]);
    } finally {
      setLoading(false);
    }
  }, [experimentId, experiment.start_date, experiment.end_date]);

  useEffect(() => {
    fetchRange();
  }, [fetchRange]);

  // Live update: if another participant books/cancels, refresh and prune
  // stale selections.
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`timetable-${experimentId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "bookings",
          filter: `experiment_id=eq.${experimentId}`,
        },
        () => {
          fetchRange().then(() => {
            // prune selections whose slot is no longer available
            const available = new Set(
              slots
                .filter((s) => s.status === "available")
                .map((s) => s.slot_start),
            );
            const current = selectedRef.current;
            const pruned = current.filter((s) => available.has(s.slot_start));
            if (pruned.length < current.length) {
              toast("선택하신 시간대가 방금 예약되었습니다. 다시 선택해 주세요.", "error");
              onChange(pruned);
            }
          });
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [experimentId, fetchRange]);

  // Build week blocks
  const { weeks, timeRows, timeEndByStart } = useMemo(() => {
    const byWeek = new Map<string, Map<string, DayColumn>>();
    const times = new Set<string>();
    const endByStart = new Map<string, string>();

    for (const s of slots) {
      const dk = kstDateKey(s.slot_start);
      const wk = weekStartKey(dk);
      const tk = kstTimeKey(s.slot_start);
      times.add(tk);
      if (!endByStart.has(tk)) endByStart.set(tk, kstTimeKey(s.slot_end));

      if (!byWeek.has(wk)) byWeek.set(wk, new Map());
      const dayMap = byWeek.get(wk)!;
      if (!dayMap.has(dk)) dayMap.set(dk, buildDayColumn(dk));
      dayMap.get(dk)!.slotsByTime.set(tk, s);
    }

    const sortedTimes = [...times].sort();

    // Sort weeks chronologically, and fill each week with Mon-Sun scaffold
    const weekKeys = [...byWeek.keys()].sort();
    const weeks: WeekBlock[] = weekKeys.map((wk) => {
      const dayMap = byWeek.get(wk)!;
      const days: DayColumn[] = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date(`${wk}T00:00:00+09:00`).getTime() + i * DAY_MS;
        const dk = kstDateKey(new Date(d).toISOString());
        days.push(dayMap.get(dk) ?? buildDayColumn(dk));
      }
      const weekLabel = `${wk.slice(5).replace("-", "/")} 주차`;
      return { weekKey: wk, label: weekLabel, days };
    });

    return { weeks, timeRows: sortedTimes, timeEndByStart: endByStart };
  }, [slots]);

  const selectedByStart = useMemo(() => {
    const map = new Map<string, SerializedSlot>();
    for (const s of selectedSlots) map.set(s.slot_start, s);
    return map;
  }, [selectedSlots]);

  const selectedDates = useMemo(() => {
    const set = new Set<string>();
    for (const s of selectedSlots) set.add(kstDateKey(s.slot_start));
    return set;
  }, [selectedSlots]);

  function handleCellClick(slot: RangeSlot) {
    const isSelected = selectedByStart.has(slot.slot_start);
    const dk = kstDateKey(slot.slot_start);

    if (isSelected) {
      // Toggle off, then sort remaining by slot_start + renumber so session
      // numbers always reflect chronological order, never click order.
      const next = selectedSlots
        .filter((s) => s.slot_start !== slot.slot_start)
        .sort((a, b) => a.slot_start.localeCompare(b.slot_start))
        .map((s, i) => ({ ...s, session_number: i + 1 }));
      onChange(next);
      return;
    }

    if (slot.status !== "available") {
      toast("선택할 수 없는 시간대입니다.", "error");
      return;
    }

    if (selectedSlots.length >= requiredSessions) {
      toast(`최대 ${requiredSessions}개까지만 선택할 수 있습니다.`, "error");
      return;
    }

    if (enforceUniqueDate && selectedDates.has(dk)) {
      toast("다회차 실험은 서로 다른 날짜에 참여해야 합니다.", "error");
      return;
    }

    // Append the new slot, resort by chronological order, then assign Day 1..N.
    // This guarantees that regardless of click order, 1회차 is the earliest
    // selected slot and N회차 is the latest — matching how a participant
    // naturally experiences the multi-session study.
    const next: SerializedSlot[] = [
      ...selectedSlots,
      { slot_start: slot.slot_start, slot_end: slot.slot_end },
    ]
      .sort((a, b) => a.slot_start.localeCompare(b.slot_start))
      .map((s, i) => ({ ...s, session_number: i + 1 }));
    onChange(next);
  }

  if (loading) {
    return (
      <div className="py-10 text-center text-sm text-muted">시간표를 불러오는 중...</div>
    );
  }
  if (error) {
    return <p className="rounded-lg border border-danger/30 bg-red-50 p-4 text-sm text-danger">{error}</p>;
  }
  if (weeks.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-card p-6 text-center text-sm text-muted">
        이 실험의 예약 가능한 시간이 아직 없습니다.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {calendarWarning && (
        <div className="rounded-lg border border-yellow-300 bg-yellow-50 p-3 text-xs text-yellow-900">
          ⚠ {calendarWarning}
        </div>
      )}
      {/* Legend + counter + refresh */}
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex flex-wrap items-center gap-3">
          <LegendSwatch className="bg-green-100 border-green-300" label="예약 가능" />
          <LegendSwatch className="bg-primary border-primary text-white" label="내가 선택" />
          <LegendSwatch className="bg-gray-100 border-gray-300 text-muted" label="마감/불가" />
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => fetchRange({ force: true })}
            disabled={loading}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-foreground hover:bg-card disabled:opacity-50"
            title="Google Calendar에서 최신 일정을 다시 불러옵니다"
          >
            <svg className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h5M20 20v-5h-5M4 9a8 8 0 0114.9-2.5M20 15a8 8 0 01-14.9 2.5" />
            </svg>
            새로고침
          </button>
          {experiment.session_type === "multi" && (
            <div className="text-sm font-medium text-foreground">
              {selectedSlots.length} / {requiredSessions} 선택됨
            </div>
          )}
        </div>
      </div>

      <div className="relative overflow-x-auto rounded-lg border border-border bg-white">
        {/* Right-edge gradient hints horizontal scroll on narrow screens */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 z-[5] w-6 bg-gradient-to-l from-white to-transparent sm:hidden"
        />
        <div className="flex min-w-fit">
          {/* Sticky time column */}
          <div className="sticky left-0 z-10 flex w-28 flex-col border-r border-border bg-white">
            <div className="h-8 border-b border-border bg-card" />
            <div className="h-6 border-b border-border bg-card" />
            {timeRows.map((t) => {
              const end = timeEndByStart.get(t);
              return (
                <div
                  key={t}
                  className="flex h-10 items-center justify-center border-b border-border px-2 text-[11px] tabular-nums text-muted"
                >
                  {end ? `${t}~${end}` : t}
                </div>
              );
            })}
          </div>

          {/* Week blocks */}
          {weeks.map((week) => (
            <div key={week.weekKey} className="flex flex-col border-r border-border last:border-r-0">
              {/* Date row */}
              <div className="grid grid-cols-7 border-b border-border bg-card">
                {week.days.map((day) => {
                  const outOfRange =
                    day.dateKey < experiment.start_date || day.dateKey > experiment.end_date;
                  return (
                    <div
                      key={`date-${day.dateKey}`}
                      className={`flex h-8 items-center justify-center border-r border-border px-1 text-xs font-semibold last:border-r-0 ${outOfRange ? "bg-gray-50 text-muted/40" : "text-foreground"}`}
                    >
                      {day.dateLabel}
                    </div>
                  );
                })}
              </div>
              {/* Weekday row */}
              <div className="grid grid-cols-7 border-b border-border bg-card">
                {week.days.map((day) => {
                  const outOfRange =
                    day.dateKey < experiment.start_date || day.dateKey > experiment.end_date;
                  const dow = kstDayOfWeek(`${day.dateKey}T09:00:00+09:00`);
                  const weekdayColor = outOfRange
                    ? "text-muted/40"
                    : dow === 0
                      ? "text-red-500"
                      : dow === 6
                        ? "text-blue-500"
                        : "text-muted";
                  return (
                    <div
                      key={`wd-${day.dateKey}`}
                      className={`flex h-6 items-center justify-center border-r border-border px-1 text-[11px] last:border-r-0 ${outOfRange ? "bg-gray-50" : ""} ${weekdayColor}`}
                    >
                      {day.weekdayLabel}
                    </div>
                  );
                })}
              </div>
              {timeRows.map((t) => (
                <div key={t} className="grid grid-cols-7 border-b border-border">
                  {week.days.map((day) => {
                    const slot = day.slotsByTime.get(t);
                    const outOfRange =
                      day.dateKey < experiment.start_date || day.dateKey > experiment.end_date;
                    if (!slot || outOfRange) {
                      return (
                        <div
                          key={`${day.dateKey}-${t}`}
                          className="h-10 border-r border-border bg-gray-50 last:border-r-0"
                        />
                      );
                    }
                    const isSelected = selectedByStart.has(slot.slot_start);
                    const sessionNum = selectedByStart.get(slot.slot_start)?.session_number;
                    const otherDateSelected =
                      enforceUniqueDate &&
                      !isSelected &&
                      selectedDates.has(kstDateKey(slot.slot_start));

                    const base =
                      "h-10 border-r border-border last:border-r-0 px-1 text-[11px] font-medium transition-colors cursor-pointer disabled:cursor-not-allowed";

                    let cls = "";
                    if (isSelected) {
                      cls = "bg-primary text-white";
                    } else if (slot.status === "available" && !otherDateSelected) {
                      cls = "bg-green-100 text-green-800 hover:bg-green-200";
                    } else if (otherDateSelected) {
                      cls = "bg-yellow-50 text-yellow-700 cursor-not-allowed";
                    } else {
                      cls = "bg-gray-100 text-muted cursor-not-allowed";
                    }

                    const title = isSelected
                      ? `${sessionNum}회차 선택됨`
                      : slot.status === "available"
                        ? otherDateSelected
                          ? "같은 날짜에 이미 다른 회차 선택됨"
                          : `${slot.booked_count}/${slot.capacity} 예약됨`
                        : slot.status === "full"
                          ? "마감"
                          : "불가";

                    return (
                      <button
                        key={`${day.dateKey}-${t}`}
                        type="button"
                        title={title}
                        disabled={
                          (slot.status !== "available" && !isSelected) || otherDateSelected
                        }
                        onClick={() => handleCellClick(slot)}
                        className={`${base} ${cls}`}
                      >
                        {isSelected ? `${sessionNum}회차` : ""}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      <p className="text-xs text-muted">
        클릭하여 시간대를 선택하세요. 선택된 칸을 다시 누르면 해제됩니다.
        {enforceUniqueDate && " 다회차 실험은 서로 다른 날짜에 참여해야 합니다."}
      </p>
    </div>
  );
}

function LegendSwatch({ className, label }: { className: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`inline-block h-3 w-4 rounded border ${className}`} />
      <span className="text-muted">{label}</span>
    </div>
  );
}
