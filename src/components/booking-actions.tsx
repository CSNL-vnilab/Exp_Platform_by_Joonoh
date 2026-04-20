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
  const [slots, setSlots] = useState<RangeSlot[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [picked, setPicked] = useState<RangeSlot | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setPicked(null);
    (async () => {
      const res = await fetch(`/api/experiments/${experimentId}/slots/range`);
      const data = await res.json();
      if (!cancelled) {
        setSlots(data.slots ?? []);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, experimentId]);

  // Group by week, mark current slot as "current", keep available + current
  const { weeks, timeRows } = useMemo(() => {
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
    const sortedTimes = [...times].sort();
    const weekKeys = [...byWeek.keys()].sort();
    const weeks = weekKeys.map((wk) => {
      const dayMap = byWeek.get(wk)!;
      const days: Array<{ dateKey: string; slotsByTime: Map<string, RangeSlot> }> = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date(`${wk}T00:00:00+09:00`).getTime() + i * DAY_MS;
        const dk = kstDateKey(new Date(d).toISOString());
        days.push({ dateKey: dk, slotsByTime: dayMap.get(dk) ?? new Map() });
      }
      return { weekKey: wk, days };
    });
    return { weeks, timeRows: sortedTimes };
  }, [slots]);

  async function handleConfirm() {
    if (!picked) return;
    setSubmitting(true);
    const res = await fetch(`/api/bookings/${bookingId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slot_start: picked.slot_start,
        slot_end: picked.slot_end,
        session_number: sessionNumber,
      }),
    });
    setSubmitting(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      toast(j.error ?? "변경에 실패했습니다.", "error");
      return;
    }
    toast("예약이 변경되었습니다. 참여자에게 안내 메일/문자가 발송됩니다.", "success");
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
        </div>

        {loading && <div className="py-8 text-center text-sm text-muted">슬롯을 불러오는 중...</div>}

        {!loading && weeks.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-border bg-white">
            <div className="flex min-w-fit">
              <div className="sticky left-0 z-10 flex flex-col border-r border-border bg-white">
                <div className="h-7 border-b border-border bg-card" />
                <div className="h-5 border-b border-border bg-card" />
                {timeRows.map((t) => (
                  <div
                    key={t}
                    className="flex h-8 items-center justify-center border-b border-border px-2 text-[11px] text-muted"
                  >
                    {t}
                  </div>
                ))}
              </div>
              {weeks.map((week) => (
                <div
                  key={week.weekKey}
                  className="flex flex-col border-r border-border last:border-r-0"
                >
                  <div className="grid grid-cols-7 border-b border-border bg-card">
                    {week.days.map((day) => (
                      <div
                        key={`d-${day.dateKey}`}
                        className="flex h-7 items-center justify-center border-r border-border px-1 text-[11px] font-semibold text-foreground last:border-r-0"
                      >
                        {dateFmt.format(new Date(`${day.dateKey}T09:00:00+09:00`))}
                      </div>
                    ))}
                  </div>
                  <div className="grid grid-cols-7 border-b border-border bg-card">
                    {week.days.map((day) => (
                      <div
                        key={`w-${day.dateKey}`}
                        className="flex h-5 items-center justify-center border-r border-border px-1 text-[10px] text-muted last:border-r-0"
                      >
                        {weekdayFmt.format(new Date(`${day.dateKey}T09:00:00+09:00`))}
                      </div>
                    ))}
                  </div>
                  {timeRows.map((t) => (
                    <div key={t} className="grid grid-cols-7 border-b border-border">
                      {week.days.map((day) => {
                        const s = day.slotsByTime.get(t);
                        if (!s) {
                          return (
                            <div
                              key={`${day.dateKey}-${t}`}
                              className="h-8 border-r border-border bg-gray-50 last:border-r-0"
                            />
                          );
                        }
                        const isCurrent = s.slot_start === currentSlotStart;
                        const isPicked = picked?.slot_start === s.slot_start;
                        const clickable = s.status === "available" && !isCurrent;
                        let cls = "";
                        if (isCurrent) cls = "bg-blue-100 text-blue-900";
                        else if (isPicked) cls = "bg-primary text-white";
                        else if (clickable) cls = "bg-green-100 text-green-800 hover:bg-green-200 cursor-pointer";
                        else cls = "bg-gray-100 text-muted cursor-not-allowed";

                        return (
                          <button
                            key={`${day.dateKey}-${t}`}
                            type="button"
                            disabled={!clickable}
                            onClick={() => setPicked(s)}
                            className={`h-8 border-r border-border last:border-r-0 text-[10px] font-medium transition-colors disabled:cursor-not-allowed ${cls}`}
                            title={
                              isCurrent
                                ? "현재 예약"
                                : s.status === "available"
                                  ? "선택 가능"
                                  : s.status === "full"
                                    ? "마감"
                                    : "캘린더 일정과 겹침"
                            }
                          >
                            {isCurrent ? "현재" : ""}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center justify-between gap-3 pt-2">
          <p className="text-xs text-muted">
            초록색: 이동 가능 · 파랑: 현재 예약 · 회색: 캘린더 충돌/마감
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
