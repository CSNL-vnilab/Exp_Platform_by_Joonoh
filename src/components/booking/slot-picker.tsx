"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { formatTimeKR } from "@/lib/utils/date";
import type { Experiment } from "@/types/database";
import { useToast } from "@/components/ui/toast";

interface SerializedSlot {
  slot_start: string;
  slot_end: string;
  session_number?: number;
}

interface SlotPickerProps {
  experimentId: string;
  experiment: Experiment;
  onSelect: (slots: SerializedSlot[]) => void;
  selectedSlots: SerializedSlot[];
}

interface SessionSelectorProps {
  sessionIndex: number;
  experimentId: string;
  experiment: Experiment;
  selectedSlot: SerializedSlot | undefined;
  onSelectSlot: (sessionIndex: number, slot: SerializedSlot | null) => void;
  allSelectedSlots: SerializedSlot[];
}

function SessionSelector({
  sessionIndex,
  experimentId,
  experiment,
  selectedSlot,
  onSelectSlot,
  allSelectedSlots,
}: SessionSelectorProps) {
  const { toast } = useToast();
  const [selectedDate, setSelectedDate] = useState("");
  const [availableSlots, setAvailableSlots] = useState<SerializedSlot[]>([]);
  const [loading, setLoading] = useState(false);
  const selectedSlotRef = useRef<SerializedSlot | undefined>(selectedSlot);
  const availableSlotsRef = useRef<SerializedSlot[]>([]);

  const fetchSlots = useCallback(
    async (date: string) => {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/experiments/${experimentId}/slots?date=${date}`
        );
        if (!res.ok) throw new Error("슬롯 조회 실패");
        const data = await res.json();
        setAvailableSlots(data.slots ?? []);
      } catch {
        toast("슬롯을 불러오는 중 오류가 발생했습니다.", "error");
        setAvailableSlots([]);
      } finally {
        setLoading(false);
      }
    },
    [experimentId, toast]
  );

  // Supabase Realtime subscription
  useEffect(() => {
    if (!selectedDate) return;

    const supabase = createClient();
    const channel = supabase
      .channel(`bookings-exp-${experimentId}-session-${sessionIndex}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "bookings",
          filter: `experiment_id=eq.${experimentId}`,
        },
        () => {
          // Refetch slots to reflect newly taken slots
          fetchSlots(selectedDate).then(() => {
            // Use refs to avoid stale closure — read current values
            const currentSlot = selectedSlotRef.current;
            const currentAvailable = availableSlotsRef.current;
            if (currentSlot) {
              const stillAvailable = currentAvailable.some(
                (s) => s.slot_start === currentSlot.slot_start
              );
              if (!stillAvailable) {
                toast(
                  "선택하신 시간대가 방금 예약되었습니다. 다른 시간대를 선택해주세요.",
                  "error"
                );
                onSelectSlot(sessionIndex, null);
              }
            }
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDate, experimentId, sessionIndex]);

  useEffect(() => {
    if (selectedDate) {
      fetchSlots(selectedDate);
    }
  }, [selectedDate, fetchSlots]);

  // Keep refs up to date for the realtime callback
  useEffect(() => {
    selectedSlotRef.current = selectedSlot;
  }, [selectedSlot]);

  useEffect(() => {
    availableSlotsRef.current = availableSlots;
  }, [availableSlots]);

  const handleDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const date = e.target.value;
    setSelectedDate(date);
    // Clear session selection when date changes
    onSelectSlot(sessionIndex, null);
    setAvailableSlots([]);
  };

  const handleSlotClick = (slot: SerializedSlot) => {
    const isSelected = selectedSlot?.slot_start === slot.slot_start;
    if (isSelected) {
      onSelectSlot(sessionIndex, null);
    } else {
      onSelectSlot(sessionIndex, { ...slot, session_number: sessionIndex + 1 });
    }
  };

  // Slots already chosen in other sessions are unavailable for this session
  const otherSelectedStarts = new Set(
    allSelectedSlots
      .filter((_, idx) => idx !== sessionIndex)
      .map((s) => s.slot_start)
  );

  // For multi-session: dates already chosen in other sessions
  const otherSelectedDates = new Set(
    allSelectedSlots
      .filter((_, idx) => idx !== sessionIndex)
      .map((s) => s.slot_start.split("T")[0])
  );

  // Enforce different dates for multi-session experiments
  const isDateTakenByOtherSession =
    experiment.session_type === "multi" &&
    selectedDate &&
    otherSelectedDates.has(selectedDate);

  const sessionLabel =
    experiment.session_type === "multi"
      ? `${sessionIndex + 1}회차 날짜 및 시간 선택`
      : "날짜 및 시간 선택";

  return (
    <div className="space-y-4">
      {experiment.session_type === "multi" && (
        <div>
          <h3 className="text-sm font-semibold text-foreground">
            {sessionLabel}
          </h3>
          <p className="mt-1 text-xs text-muted">
            총 {experiment.required_sessions}회차 참여 필요 - 각 회차는 서로 다른 날짜에 진행됩니다
          </p>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor={`date-${sessionIndex}`}
          className="text-sm font-medium text-foreground"
        >
          날짜
        </label>
        <input
          id={`date-${sessionIndex}`}
          type="date"
          value={selectedDate}
          min={experiment.start_date}
          max={experiment.end_date}
          onChange={handleDateChange}
          className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
      </div>

      {isDateTakenByOtherSession && (
        <div className="flex items-start gap-2 rounded-lg border border-orange-300 bg-orange-50 p-3">
          <span aria-hidden className="select-none text-orange-600">⚠</span>
          <p className="text-sm text-orange-900">
            이 날짜는 다른 회차에서 이미 선택되었습니다. 서로 다른 날짜를 선택해주세요.
          </p>
        </div>
      )}

      {selectedDate && !isDateTakenByOtherSession && (
        <div>
          <p className="mb-3 text-sm font-medium text-foreground">시간 선택</p>
          {loading ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {Array.from({ length: 8 }).map((_, i) => (
                <div
                  key={i}
                  className="h-11 animate-pulse rounded-lg bg-gray-100"
                />
              ))}
            </div>
          ) : availableSlots.length === 0 ? (
            <p className="rounded-lg border border-border bg-card py-6 text-center text-sm text-muted">
              선택 가능한 시간대가 없습니다
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {availableSlots.map((slot) => {
                const isSelected =
                  selectedSlot?.slot_start === slot.slot_start;
                const isUnavailable = otherSelectedStarts.has(slot.slot_start);

                return (
                  <button
                    key={slot.slot_start}
                    type="button"
                    onClick={() => !isUnavailable && handleSlotClick(slot)}
                    disabled={isUnavailable}
                    className={`
                      min-h-[44px] rounded-lg border px-2 py-2.5 text-sm font-medium
                      transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1
                      disabled:cursor-not-allowed disabled:opacity-40
                      ${
                        isSelected
                          ? "border-primary bg-primary text-white"
                          : "border-border bg-white text-foreground hover:border-primary hover:bg-blue-50"
                      }
                    `}
                  >
                    {formatTimeKR(new Date(slot.slot_start))}
                    <span className="block text-xs opacity-75">
                      ~ {formatTimeKR(new Date(slot.slot_end))}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function SlotPicker({
  experimentId,
  experiment,
  onSelect,
  selectedSlots,
}: SlotPickerProps) {
  const requiredSessions =
    experiment.session_type === "multi" ? experiment.required_sessions : 1;

  const handleSelectSlot = (sessionIndex: number, slot: SerializedSlot | null) => {
    const next = [...selectedSlots];
    // Ensure array is long enough
    while (next.length < requiredSessions) next.push(undefined as unknown as SerializedSlot);

    if (slot === null) {
      next[sessionIndex] = undefined as unknown as SerializedSlot;
    } else {
      next[sessionIndex] = slot;
    }

    // Filter out undefined entries for the callback but keep the array structure intact
    onSelect(next.filter(Boolean));
  };

  // Build per-session selected slot from the flat selectedSlots array
  // selectedSlots is ordered by session_number - 1
  const slotBySession = (sessionIndex: number): SerializedSlot | undefined =>
    selectedSlots.find((s) => (s.session_number ?? 1) === sessionIndex + 1) ??
    (selectedSlots[sessionIndex] ? selectedSlots[sessionIndex] : undefined);

  return (
    <div className="space-y-8">
      {Array.from({ length: requiredSessions }).map((_, i) => (
        <SessionSelector
          key={i}
          sessionIndex={i}
          experimentId={experimentId}
          experiment={experiment}
          selectedSlot={slotBySession(i)}
          onSelectSlot={handleSelectSlot}
          allSelectedSlots={selectedSlots}
        />
      ))}
    </div>
  );
}
