"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";

type SlotStatus = "available" | "busy" | "full";

interface RangeSlot {
  slot_start: string;
  slot_end: string;
  status: SlotStatus;
  booked_count: number;
  capacity: number;
  /** Set when status="busy" and the calendar API gave back the
   *  conflicting event's title. Used in the picker tooltip. */
  busy_summary?: string | null;
}

interface SlotsResponse {
  from: string;
  to: string;
  slots: RangeSlot[];
  calendarId?: string | null;
  calendarWarning?: string | null;
}

interface BookingActionsProps {
  bookingId: string;
  experimentId: string;
  currentSlotStart: string;
  currentSlotEnd: string;
  sessionNumber: number;
}

const KST = "Asia/Seoul";
const DAY_MS = 86_400_000;
const timeFmt = new Intl.DateTimeFormat("ko-KR", {
  timeZone: KST,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const dateFmt = new Intl.DateTimeFormat("ko-KR", {
  timeZone: KST,
  month: "numeric",
  day: "numeric",
});
const weekdayFmt = new Intl.DateTimeFormat("ko-KR", { timeZone: KST, weekday: "short" });

function kstDateKey(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: KST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  return `${parts.find((p) => p.type === "year")!.value}-${parts.find((p) => p.type === "month")!.value}-${parts.find((p) => p.type === "day")!.value}`;
}

function kstDayOfWeek(iso: string): number {
  const w = new Intl.DateTimeFormat("en-US", { timeZone: KST, weekday: "short" }).format(
    new Date(iso),
  );
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(w);
}

function weekStartKey(dateKey: string): string {
  const iso = `${dateKey}T00:00:00+09:00`;
  const dow = kstDayOfWeek(iso);
  const offset = dow === 0 ? -6 : 1 - dow;
  const d = new Date(new Date(iso).getTime() + offset * DAY_MS);
  return kstDateKey(d.toISOString());
}

export function BookingActions({
  bookingId,
  experimentId,
  currentSlotStart,
  currentSlotEnd,
  sessionNumber,
}: BookingActionsProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [cancelling, setCancelling] = useState(false);
  const [rescheduleOpen, setRescheduleOpen] = useState(false);

  async function handleCancel() {
    if (!confirm("이 예약을 취소하시겠습니까?")) return;

    setCancelling(true);
    const supabase = createClient();
    const { error } = await supabase
      .from("bookings")
      .update({ status: "cancelled" })
      .eq("id", bookingId);

    if (error) {
      toast("예약 취소 중 오류가 발생했습니다.", "error");
    } else {
      toast("예약이 취소되었습니다.", "success");
      router.refresh();
    }
    setCancelling(false);
  }

  return (
    <>
      <div className="flex gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setRescheduleOpen(true)}
          disabled={cancelling}
        >
          예약 변경
        </Button>
        <Button
          variant="danger"
          size="sm"
          onClick={handleCancel}
          disabled={cancelling}
        >
          {cancelling ? "취소 중..." : "예약 취소"}
        </Button>
      </div>
      <RescheduleModal
        open={rescheduleOpen}
        onClose={() => setRescheduleOpen(false)}
        bookingId={bookingId}
        experimentId={experimentId}
        currentSlotStart={currentSlotStart}
        currentSlotEnd={currentSlotEnd}
        sessionNumber={sessionNumber}
        onDone={() => {
          setRescheduleOpen(false);
          router.refresh();
        }}
      />
    </>
  );
}

function RescheduleModal({
  open,
  onClose,
  bookingId,
  experimentId,
  currentSlotStart,
  currentSlotEnd,
  sessionNumber,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  bookingId: string;
  experimentId: string;
  currentSlotStart: string;
  currentSlotEnd: string;
  sessionNumber: number;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const [response, setResponse] = useState<SlotsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [picked, setPicked] = useState<RangeSlot | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Single-week navigation. Initial week = the current booking's week so
  // the researcher lands somewhere actionable; ◀ ▶ buttons step ±7 days.
  const [weekStart, setWeekStart] = useState<string>(() =>
    weekStartKey(kstDateKey(currentSlotStart)),
  );

  const fetchSlots = async (opts: { fresh?: boolean } = {}) => {
    const url = `/api/experiments/${experimentId}/slots/range${opts.fresh ? "?fresh=1" : ""}`;
    const res = await fetch(url);
    const data = (await res.json()) as SlotsResponse;
    setResponse(data);
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setPicked(null);
    setWeekStart(weekStartKey(kstDateKey(currentSlotStart)));
    (async () => {
      try {
        await fetchSlots();
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, experimentId, currentSlotStart]);

  // Index slots by (weekStart, dateKey, timeKey) so navigation is O(1).
  const { byWeek, timeRows, availableWeekKeys, expRange } = useMemo(() => {
    const slots = response?.slots ?? [];
    const times = new Set<string>();
    const byWeek = new Map<string, Map<string, Map<string, RangeSlot>>>();
    for (const s of slots) {
      const dk = kstDateKey(s.slot_start);
      const wk = weekStartKey(dk);
      const tk = timeFmt.format(new Date(s.slot_start));
      times.add(tk);
      if (!byWeek.has(wk)) byWeek.set(wk, new Map());
      const dayMap = byWeek.get(wk)!;
      if (!dayMap.has(dk)) dayMap.set(dk, new Map());
      dayMap.get(dk)!.set(tk, s);
    }
    return {
      byWeek,
      timeRows: [...times].sort(),
      availableWeekKeys: [...byWeek.keys()].sort(),
      expRange: response ? `${response.from} ~ ${response.to}` : "",
    };
  }, [response]);

  const currentWeekDays = useMemo(() => {
    const dayMap = byWeek.get(weekStart) ?? new Map<string, Map<string, RangeSlot>>();
    const days: Array<{ dateKey: string; slotsByTime: Map<string, RangeSlot> }> = [];
    for (let i = 0; i < 7; i += 1) {
      const d = new Date(`${weekStart}T00:00:00+09:00`).getTime() + i * DAY_MS;
      const dk = kstDateKey(new Date(d).toISOString());
      days.push({ dateKey: dk, slotsByTime: dayMap.get(dk) ?? new Map() });
    }
    return days;
  }, [byWeek, weekStart]);

  function shiftWeek(direction: -1 | 1) {
    const next = new Date(`${weekStart}T00:00:00+09:00`).getTime() + direction * 7 * DAY_MS;
    setWeekStart(kstDateKey(new Date(next).toISOString()));
  }

  function jumpToCurrent() {
    setWeekStart(weekStartKey(kstDateKey(currentSlotStart)));
  }

  // Find prev/next week with available capacity for the ◀ Today ▶ context
  const prevAvail = useMemo(
    () => [...availableWeekKeys].reverse().find((k) => k < weekStart) ?? null,
    [availableWeekKeys, weekStart],
  );
  const nextAvail = useMemo(
    () => availableWeekKeys.find((k) => k > weekStart) ?? null,
    [availableWeekKeys, weekStart],
  );

  // Range bounds for ◀ ▶ disabling
  const earliest = availableWeekKeys[0] ?? null;
  const latest = availableWeekKeys[availableWeekKeys.length - 1] ?? null;
  const atEarliest = earliest != null && weekStart <= earliest;
  const atLatest = latest != null && weekStart >= latest;

  const weekLabelStart = `${weekStart}T00:00:00+09:00`;
  const weekLabelEnd = new Date(
    new Date(weekLabelStart).getTime() + 6 * DAY_MS,
  ).toISOString();
  const weekLabel = `${dateFmt.format(new Date(weekLabelStart))} ~ ${dateFmt.format(new Date(weekLabelEnd))}`;

  async function handleConfirm() {
    if (!picked) return;
    setSubmitting(true);
    const res = await fetch(`/api/bookings/${bookingId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slot_start: picked.slot_start,
        slot_end: picked.slot_end,
      }),
    });
    setSubmitting(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      toast(j.error ?? "변경에 실패했습니다.", "error");
      return;
    }
    const j = (await res.json().catch(() => ({}))) as {
      renumber?: { changed: number; total: number } | null;
    };
    const renumberedMsg =
      j.renumber && j.renumber.changed > 0
        ? ` · 회차 ${j.renumber.changed}건 자동 재번호`
        : "";
    toast(`예약이 변경되었습니다${renumberedMsg}. 참여자에게 안내가 발송됩니다.`, "success");
    onDone();
  }

  return (
    <Modal open={open} onClose={onClose} title={`예약 변경 · ${sessionNumber}회차`}>
      <div className="space-y-3">
        <div className="rounded-md border border-border bg-card p-3 text-sm">
          <div className="text-muted">현재 예약</div>
          <div className="font-medium text-foreground">
            {new Date(currentSlotStart).toLocaleString("ko-KR", { timeZone: KST })} ~{" "}
            {timeFmt.format(new Date(currentSlotEnd))}
          </div>
          {response?.calendarWarning && (
            <p className="mt-1 text-xs text-amber-700">{response.calendarWarning}</p>
          )}
        </div>

        {/* Week navigation */}
        <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => shiftWeek(-1)}
              disabled={atEarliest}
              className="rounded border border-border bg-white px-2 py-1 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
              aria-label="이전 주"
            >
              ◀
            </button>
            <span className="min-w-[10rem] text-center font-medium text-foreground">
              {weekLabel}
            </span>
            <button
              type="button"
              onClick={() => shiftWeek(1)}
              disabled={atLatest}
              className="rounded border border-border bg-white px-2 py-1 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
              aria-label="다음 주"
            >
              ▶
            </button>
            <button
              type="button"
              onClick={jumpToCurrent}
              className="ml-1 rounded border border-border bg-white px-2 py-1 text-muted hover:bg-gray-50 hover:text-foreground"
            >
              현재 예약 주
            </button>
            {prevAvail && weekStart > prevAvail && (
              <button
                type="button"
                onClick={() => setWeekStart(prevAvail)}
                className="text-[11px] text-blue-600 hover:underline"
              >
                ⇤ 이전 가능 주
              </button>
            )}
            {nextAvail && weekStart < nextAvail && (
              <button
                type="button"
                onClick={() => setWeekStart(nextAvail)}
                className="text-[11px] text-blue-600 hover:underline"
              >
                다음 가능 주 ⇥
              </button>
            )}
          </div>
          <div className="flex items-center gap-2 text-[11px] text-muted">
            <span>실험 운영: {expRange}</span>
            <button
              type="button"
              onClick={async () => {
                setRefreshing(true);
                try {
                  await fetchSlots({ fresh: true });
                  toast("캘린더를 새로 가져왔습니다", "success");
                } finally {
                  setRefreshing(false);
                }
              }}
              disabled={refreshing}
              className="rounded border border-border bg-white px-2 py-0.5 text-muted hover:bg-gray-50 hover:text-foreground disabled:opacity-50"
              title="Google Calendar 캐시 무시하고 새로 가져오기"
            >
              {refreshing ? "새로고침 중…" : "↻ 캘린더 새로고침"}
            </button>
          </div>
        </div>

        {loading && <div className="py-8 text-center text-sm text-muted">슬롯을 불러오는 중...</div>}

        {!loading && (
          <div className="overflow-hidden rounded-lg border border-border bg-white">
            {/* Day header */}
            <div className="grid grid-cols-[3.5rem_repeat(7,1fr)] border-b border-border bg-card">
              <div />
              {currentWeekDays.map((day) => (
                <div
                  key={`d-${day.dateKey}`}
                  className="flex flex-col items-center border-r border-border py-1.5 last:border-r-0"
                >
                  <span className="text-[10px] text-muted">
                    {weekdayFmt.format(new Date(`${day.dateKey}T09:00:00+09:00`))}
                  </span>
                  <span className="text-[12px] font-semibold text-foreground">
                    {dateFmt.format(new Date(`${day.dateKey}T09:00:00+09:00`))}
                  </span>
                </div>
              ))}
            </div>
            {timeRows.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted">
                이 주에 슬롯이 없습니다 — 다른 주를 선택하세요
              </div>
            ) : (
              timeRows.map((t) => (
                <div
                  key={t}
                  className="grid grid-cols-[3.5rem_repeat(7,1fr)] border-b border-border last:border-b-0"
                >
                  <div className="flex items-center justify-center border-r border-border bg-card text-[11px] text-muted">
                    {t}
                  </div>
                  {currentWeekDays.map((day) => {
                    const s = day.slotsByTime.get(t);
                    if (!s) {
                      return (
                        <div
                          key={`${day.dateKey}-${t}`}
                          className="h-9 border-r border-border bg-gray-50 last:border-r-0"
                        />
                      );
                    }
                    const isCurrent = s.slot_start === currentSlotStart;
                    const isPicked = picked?.slot_start === s.slot_start;
                    const clickable = s.status === "available" && !isCurrent;

                    let cls = "";
                    let label = "";
                    if (isCurrent) {
                      cls = "bg-blue-100 text-blue-900 ring-2 ring-inset ring-blue-400";
                      label = "현재";
                    } else if (isPicked) {
                      cls = "bg-primary text-white";
                      label = "선택";
                    } else if (clickable) {
                      cls = "bg-green-50 text-green-800 hover:bg-green-100 cursor-pointer";
                    } else if (s.status === "busy") {
                      cls = "bg-amber-50 text-amber-700 cursor-not-allowed";
                      label = "캘";
                    } else {
                      cls = "bg-gray-100 text-muted cursor-not-allowed";
                    }

                    const tooltip = isCurrent
                      ? "현재 예약 슬롯"
                      : s.status === "available"
                        ? `클릭해서 이 시간으로 변경 (${s.booked_count}/${s.capacity})`
                        : s.status === "full"
                          ? `정원 마감 (${s.booked_count}/${s.capacity})`
                          : s.busy_summary
                            ? `Google Calendar 충돌: ${s.busy_summary}`
                            : "Google Calendar 일정과 겹침";

                    return (
                      <button
                        key={`${day.dateKey}-${t}`}
                        type="button"
                        disabled={!clickable}
                        onClick={() => setPicked(s)}
                        className={`h-9 border-r border-border last:border-r-0 text-[10px] font-medium transition-colors disabled:cursor-not-allowed ${cls}`}
                        title={tooltip}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        )}

        <div className="flex items-center justify-between gap-3 pt-2">
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
            <span><span className="inline-block size-2 rounded-sm bg-green-100 ring-1 ring-green-300 align-middle" /> 이동 가능</span>
            <span><span className="inline-block size-2 rounded-sm bg-blue-100 ring-1 ring-blue-400 align-middle" /> 현재 예약</span>
            <span><span className="inline-block size-2 rounded-sm bg-amber-50 ring-1 ring-amber-300 align-middle" /> 캘린더 충돌</span>
            <span><span className="inline-block size-2 rounded-sm bg-gray-100 ring-1 ring-gray-300 align-middle" /> 마감/지난시간</span>
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose} disabled={submitting}>
              취소
            </Button>
            <Button onClick={handleConfirm} disabled={!picked || submitting}>
              {submitting ? "변경 중..." : picked ? "변경 확정" : "슬롯 선택"}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
