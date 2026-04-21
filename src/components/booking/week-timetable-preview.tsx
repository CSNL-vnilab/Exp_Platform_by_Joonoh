"use client";

import { useEffect, useMemo, useState } from "react";

interface WeekTimetablePreviewProps {
  config: Record<string, unknown>;
}

interface PreviewSlot {
  slot_start: string;
  slot_end: string;
  status: "available" | "busy" | "full";
  booked_count: number;
  capacity: number;
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

function kstDow(iso: string): number {
  const w = new Intl.DateTimeFormat("en-US", { timeZone: KST, weekday: "short" }).format(
    new Date(iso),
  );
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(w);
}

function weekStartKey(dateKey: string): string {
  const iso = `${dateKey}T00:00:00+09:00`;
  const dow = kstDow(iso);
  const offset = dow === 0 ? -6 : 1 - dow;
  return kstDateKey(new Date(new Date(iso).getTime() + offset * DAY_MS).toISOString());
}

interface DayCol {
  dateKey: string;
  dateLabel: string;
  weekdayLabel: string;
  byTime: Map<string, PreviewSlot>;
}

function buildDay(dk: string): DayCol {
  const iso = `${dk}T09:00:00+09:00`;
  return {
    dateKey: dk,
    dateLabel: dateFmt.format(new Date(iso)),
    weekdayLabel: weekdayFmt.format(new Date(iso)),
    byTime: new Map(),
  };
}

export function WeekTimetablePreview({ config }: WeekTimetablePreviewProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [calendarWarning, setCalendarWarning] = useState<string | null>(null);
  const [slots, setSlots] = useState<PreviewSlot[]>([]);
  const [availableCount, setAvailableCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await fetch("/api/experiments/preview-slots", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(config),
        });
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(json.error ?? "미리보기 불러오기 실패");
          setSlots([]);
        } else {
          setSlots(json.slots ?? []);
          setCalendarWarning(json.calendarWarning ?? null);
          setAvailableCount(json.availableCount ?? 0);
        }
      } catch {
        if (!cancelled) setError("네트워크 오류");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [config]);

  const { weeks, timeRows, timeEndByStart } = useMemo(() => {
    const byWeek = new Map<string, Map<string, DayCol>>();
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
      if (!dayMap.has(dk)) dayMap.set(dk, buildDay(dk));
      dayMap.get(dk)!.byTime.set(tk, s);
    }
    const sortedTimes = [...times].sort();
    const weekKeys = [...byWeek.keys()].sort();
    const weeks = weekKeys.map((wk) => {
      const dayMap = byWeek.get(wk)!;
      const days: DayCol[] = [];
      for (let i = 0; i < 7; i++) {
        const t = new Date(`${wk}T00:00:00+09:00`).getTime() + i * DAY_MS;
        const dk = kstDateKey(new Date(t).toISOString());
        days.push(dayMap.get(dk) ?? buildDay(dk));
      }
      return { weekKey: wk, days };
    });
    return { weeks, timeRows: sortedTimes, timeEndByStart: endByStart };
  }, [slots]);

  if (loading) {
    return (
      <div className="py-10 text-center text-sm text-muted">미리보기 생성 중...</div>
    );
  }
  if (error) {
    return (
      <p className="rounded-lg border border-danger/30 bg-red-50 p-4 text-sm text-danger">
        {error}
      </p>
    );
  }
  if (weeks.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-card p-6 text-center text-sm text-muted">
        조건에 맞는 슬롯이 없습니다. 기간·요일·시간 설정을 확인해 주세요.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex flex-wrap gap-3">
          <Swatch className="bg-green-100 border-green-300" label="예약 가능" />
          <Swatch className="bg-gray-100 border-gray-300 text-muted" label="마감/겹침" />
        </div>
        <div className="text-muted">
          총 <b className="text-foreground">{availableCount}</b>개 슬롯 예약 가능
        </div>
      </div>

      {calendarWarning && (
        <div className="rounded-lg border border-yellow-300 bg-yellow-50 p-2 text-xs text-yellow-900">
          ⚠ {calendarWarning}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-border bg-white">
        <div className="flex min-w-fit">
          {/* Time column */}
          <div className="sticky left-0 z-10 flex w-28 flex-col border-r border-border bg-white">
            <div className="h-8 border-b border-border bg-card" />
            <div className="h-6 border-b border-border bg-card" />
            {timeRows.map((t) => (
              <div
                key={t}
                className="flex h-9 items-center justify-center border-b border-border px-2 text-[11px] tabular-nums text-muted"
              >
                {`${t}~${timeEndByStart.get(t) ?? ""}`}
              </div>
            ))}
          </div>
          {weeks.map((week) => (
            <div key={week.weekKey} className="flex flex-col border-r border-border last:border-r-0">
              <div className="grid grid-cols-7 border-b border-border bg-card">
                {week.days.map((day) => (
                  <div
                    key={`d-${day.dateKey}`}
                    className="flex h-8 items-center justify-center border-r border-border px-1 text-xs font-semibold text-foreground last:border-r-0"
                  >
                    {day.dateLabel}
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-7 border-b border-border bg-card">
                {week.days.map((day) => {
                  const dow = kstDow(`${day.dateKey}T09:00:00+09:00`);
                  const color =
                    dow === 0 ? "text-red-500" : dow === 6 ? "text-blue-500" : "text-muted";
                  return (
                    <div
                      key={`w-${day.dateKey}`}
                      className={`flex h-6 items-center justify-center border-r border-border px-1 text-[11px] last:border-r-0 ${color}`}
                    >
                      {day.weekdayLabel}
                    </div>
                  );
                })}
              </div>
              {timeRows.map((t) => (
                <div key={t} className="grid grid-cols-7 border-b border-border">
                  {week.days.map((day) => {
                    const slot = day.byTime.get(t);
                    if (!slot) {
                      return (
                        <div
                          key={`${day.dateKey}-${t}`}
                          className="h-9 border-r border-border bg-gray-50 last:border-r-0"
                        />
                      );
                    }
                    const cls =
                      slot.status === "available"
                        ? "bg-green-100 text-green-800"
                        : "bg-gray-100 text-muted";
                    return (
                      <div
                        key={`${day.dateKey}-${t}`}
                        title={
                          slot.status === "available"
                            ? `${slot.booked_count}/${slot.capacity} 예약됨`
                            : slot.status === "full"
                              ? "마감"
                              : "캘린더 일정과 겹침"
                        }
                        className={`h-9 border-r border-border last:border-r-0 ${cls}`}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Swatch({ className, label }: { className: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`inline-block h-3 w-4 rounded border ${className}`} />
      <span className="text-muted">{label}</span>
    </div>
  );
}
