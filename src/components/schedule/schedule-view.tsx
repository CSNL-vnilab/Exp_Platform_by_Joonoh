"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export interface ScheduleRow {
  id: string;
  slot_start: string;
  slot_end: string;
  session_number: number;
  subject_number: number | null;
  status: string;
  experiment_id: string;
  experiments: {
    id: string;
    title: string;
    project_name: string | null;
    created_by: string | null;
  } | null;
  participants: { name: string } | null;
}

interface Creator {
  id: string;
  display_name: string | null;
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

function kstDow(iso: string): number {
  const w = new Intl.DateTimeFormat("en-US", { timeZone: KST, weekday: "short" }).format(
    new Date(iso),
  );
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(w);
}

// Deterministic color per researcher
const PALETTE = [
  { bg: "bg-blue-100", text: "text-blue-800", dot: "bg-blue-500" },
  { bg: "bg-emerald-100", text: "text-emerald-800", dot: "bg-emerald-500" },
  { bg: "bg-violet-100", text: "text-violet-800", dot: "bg-violet-500" },
  { bg: "bg-amber-100", text: "text-amber-800", dot: "bg-amber-500" },
  { bg: "bg-pink-100", text: "text-pink-800", dot: "bg-pink-500" },
  { bg: "bg-cyan-100", text: "text-cyan-800", dot: "bg-cyan-500" },
  { bg: "bg-lime-100", text: "text-lime-800", dot: "bg-lime-500" },
  { bg: "bg-rose-100", text: "text-rose-800", dot: "bg-rose-500" },
];

function colorFor(id: string | null) {
  if (!id) return PALETTE[0];
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

interface ScheduleViewProps {
  rows: ScheduleRow[];
  creators: Creator[];
  from: string;
  to: string;
}

export function ScheduleView({ rows, creators, from, to }: ScheduleViewProps) {
  const router = useRouter();
  const [fromDate, setFromDate] = useState(from);
  const [toDate, setToDate] = useState(to);

  const creatorMap = useMemo(() => {
    const m = new Map<string, Creator>();
    for (const c of creators) m.set(c.id, c);
    return m;
  }, [creators]);

  const activeResearchers = useMemo(() => {
    const ids = new Set<string>();
    for (const r of rows) if (r.experiments?.created_by) ids.add(r.experiments.created_by);
    return Array.from(ids).map((id) => ({
      id,
      name: creatorMap.get(id)?.display_name ?? id.slice(0, 6),
      color: colorFor(id),
    }));
  }, [rows, creatorMap]);

  const [filterResearcher, setFilterResearcher] = useState<string | null>(null);

  const daysInRange = useMemo(() => {
    const start = new Date(`${fromDate}T00:00:00+09:00`);
    const end = new Date(`${toDate}T00:00:00+09:00`);
    const days: string[] = [];
    for (let t = start.getTime(); t <= end.getTime(); t += DAY_MS) {
      days.push(kstDateKey(new Date(t).toISOString()));
    }
    return days;
  }, [fromDate, toDate]);

  const rowsByDay = useMemo(() => {
    const m = new Map<string, ScheduleRow[]>();
    for (const d of daysInRange) m.set(d, []);
    for (const r of rows) {
      if (filterResearcher && r.experiments?.created_by !== filterResearcher) continue;
      const dk = kstDateKey(r.slot_start);
      if (m.has(dk)) m.get(dk)!.push(r);
    }
    return m;
  }, [rows, daysInRange, filterResearcher]);

  function applyRange() {
    router.push(`/schedule?from=${fromDate}&to=${toDate}`);
  }

  function shiftRange(days: number) {
    const shift = (iso: string) =>
      kstDateKey(new Date(new Date(`${iso}T00:00:00+09:00`).getTime() + days * DAY_MS).toISOString());
    const nf = shift(fromDate);
    const nt = shift(toDate);
    setFromDate(nf);
    setToDate(nt);
    router.push(`/schedule?from=${nf}&to=${nt}`);
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">전체 실험 일정</h1>
          <p className="mt-1 text-sm text-muted">
            연구실 구성원이 운영 중인 실험의 확정 예약을 한 화면에서 봅니다.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => shiftRange(-7)}>
            ← 7일
          </Button>
          <Button variant="secondary" size="sm" onClick={() => shiftRange(7)}>
            7일 →
          </Button>
        </div>
      </div>

      <Card>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="from" className="mb-1 block text-xs font-medium text-muted">
                시작
              </label>
              <input
                id="from"
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="rounded-lg border border-border bg-white px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="to" className="mb-1 block text-xs font-medium text-muted">
                종료
              </label>
              <input
                id="to"
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="rounded-lg border border-border bg-white px-3 py-2 text-sm"
              />
            </div>
            <Button size="sm" onClick={applyRange}>
              적용
            </Button>

            {activeResearchers.length > 0 && (
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted">연구자 필터:</span>
                <button
                  type="button"
                  onClick={() => setFilterResearcher(null)}
                  className={`rounded-full border px-2.5 py-1 text-xs ${
                    filterResearcher === null
                      ? "border-foreground bg-foreground text-white"
                      : "border-border text-muted hover:bg-card"
                  }`}
                >
                  전체
                </button>
                {activeResearchers.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setFilterResearcher(filterResearcher === r.id ? null : r.id)}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
                      filterResearcher === r.id
                        ? "border-foreground bg-foreground text-white"
                        : "border-border text-foreground hover:bg-card"
                    }`}
                  >
                    <span className={`h-2 w-2 rounded-full ${r.color.dot}`} />
                    {r.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="space-y-3">
        {daysInRange.map((dk) => {
          const items = rowsByDay.get(dk) ?? [];
          const iso = `${dk}T09:00:00+09:00`;
          const dow = kstDow(iso);
          const dowColor =
            dow === 0 ? "text-red-500" : dow === 6 ? "text-blue-500" : "text-muted";
          return (
            <Card key={dk}>
              <CardContent>
                <div className="mb-3 flex items-baseline justify-between">
                  <div>
                    <span className="text-lg font-semibold text-foreground">
                      {dateFmt.format(new Date(iso))}
                    </span>
                    <span className={`ml-2 text-sm ${dowColor}`}>
                      {weekdayFmt.format(new Date(iso))}
                    </span>
                  </div>
                  <span className="text-xs text-muted">{items.length}건</span>
                </div>
                {items.length === 0 ? (
                  <p className="text-sm text-muted">예약 없음</p>
                ) : (
                  <ul className="space-y-2">
                    {items.map((r) => {
                      const creatorName = r.experiments?.created_by
                        ? creatorMap.get(r.experiments.created_by)?.display_name ??
                          r.experiments.created_by.slice(0, 6)
                        : "(미지정)";
                      const c = colorFor(r.experiments?.created_by ?? null);
                      return (
                        <li
                          key={r.id}
                          className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-white p-3"
                        >
                          <div className="flex items-center gap-2">
                            <span className={`h-2.5 w-2.5 rounded-full ${c.dot}`} />
                            <span className="text-sm font-medium tabular-nums text-foreground">
                              {timeFmt.format(new Date(r.slot_start))}
                              {"–"}
                              {timeFmt.format(new Date(r.slot_end))}
                            </span>
                          </div>
                          <div className="flex-1 min-w-0">
                            <Link
                              href={r.experiments?.id ? `/experiments/${r.experiments.id}/bookings` : "#"}
                              className={`inline-flex max-w-full truncate rounded-md px-2 py-0.5 text-xs font-medium ${c.bg} ${c.text}`}
                            >
                              {r.experiments?.title ?? "(제목 없음)"}
                            </Link>
                            <div className="mt-0.5 text-xs text-muted">
                              {creatorName}
                              {r.participants?.name ? ` · ${r.participants.name}` : ""}
                              {r.subject_number != null ? ` · Sbj${r.subject_number}` : ""}
                              {r.session_number ? ` · ${r.session_number}회차` : ""}
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
