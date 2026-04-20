"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod/v4";
import { participantSchema } from "@/lib/utils/validation";
import { BOOKING_ERRORS } from "@/lib/utils/constants";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { ParticipantForm } from "@/components/booking/participant-form";
import { WeekTimetable } from "@/components/booking/week-timetable";
import { BookingSummary } from "@/components/booking/booking-summary";
import { PrecautionCheck } from "@/components/booking/precaution-check";
import { categoryLabel, locationInfo } from "@/lib/experiments/categories";
import type { Experiment } from "@/types/database";

type ParticipantData = z.infer<typeof participantSchema>;

interface SerializedSlot {
  slot_start: string;
  slot_end: string;
  session_number?: number;
}

interface BookingFlowProps {
  experiment: Experiment;
  location?: { name: string; address_lines: string[]; naver_url: string | null } | null;
}

type Step = 1 | 2 | 3;

const STEP_LABELS: Record<Step, string> = {
  1: "참여자 정보",
  2: "시간대 선택",
  3: "예약 확인",
};

function StepIndicator({ current }: { current: Step }) {
  const steps: Step[] = [1, 2, 3];
  return (
    <div className="mb-8 flex items-center justify-center gap-2">
      {steps.map((step, i) => (
        <div key={step} className="flex items-center gap-2">
          <div className="flex flex-col items-center gap-1">
            <div
              className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold transition-colors ${
                step === current
                  ? "bg-primary text-white"
                  : step < current
                  ? "bg-green-500 text-white"
                  : "bg-gray-100 text-muted"
              }`}
            >
              {step < current ? (
                <svg
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M5 13l4 4L19 7"
                  />
                </svg>
              ) : (
                step
              )}
            </div>
            <span
              className={`text-xs ${
                step === current ? "font-semibold text-primary" : "text-muted"
              }`}
            >
              {STEP_LABELS[step]}
            </span>
          </div>
          {i < steps.length - 1 && (
            <div
              className={`mb-5 h-px w-10 sm:w-16 ${
                step < current ? "bg-green-400" : "bg-gray-200"
              }`}
            />
          )}
        </div>
      ))}
    </div>
  );
}

export function BookingFlow({ experiment, location }: BookingFlowProps) {
  const router = useRouter();
  const { toast } = useToast();

  const [step, setStep] = useState<Step>(1);
  const [participant, setParticipant] = useState<ParticipantData | null>(null);
  const [selectedSlots, setSelectedSlots] = useState<SerializedSlot[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [showPrecautions, setShowPrecautions] = useState(false);
  const [precautionsCleared, setPrecautionsCleared] = useState(false);

  const hasPrecautions = experiment.precautions && experiment.precautions.length > 0;

  const requiredSessions =
    experiment.session_type === "multi" ? experiment.required_sessions : 1;

  const handleParticipantSubmit = (data: ParticipantData) => {
    setParticipant(data);
    // Show precaution check before proceeding to step 2
    if (hasPrecautions && !precautionsCleared) {
      setShowPrecautions(true);
    } else {
      setStep(2);
    }
  };

  const handlePrecautionsConfirmed = () => {
    setPrecautionsCleared(true);
    setShowPrecautions(false);
    setStep(2);
  };

  const handleSlotsSelect = (slots: SerializedSlot[]) => {
    setSelectedSlots(slots);
  };

  const canProceedFromStep2 = selectedSlots.length >= requiredSessions;

  const handleStep2Next = () => {
    if (!canProceedFromStep2) {
      toast(
        `${requiredSessions}개의 시간대를 모두 선택해주세요.`,
        "error"
      );
      return;
    }
    setStep(3);
  };

  const handleConfirm = async () => {
    if (!participant || selectedSlots.length === 0) return;

    setSubmitting(true);
    try {
      const res = await fetch("/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          experiment_id: experiment.id,
          participant,
          slots: selectedSlots.map((s, i) => ({
            slot_start: s.slot_start,
            slot_end: s.slot_end,
            session_number: s.session_number ?? i + 1,
          })),
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        const errorMsg: string = data.error ?? "예약 중 오류가 발생했습니다.";

        // Detect slot taken errors by message content or key
        const isSlotTaken =
          errorMsg === BOOKING_ERRORS.SLOT_ALREADY_TAKEN ||
          errorMsg.includes("이미 예약") ||
          errorMsg.includes("SLOT_ALREADY_TAKEN");

        if (isSlotTaken) {
          toast(BOOKING_ERRORS.SLOT_ALREADY_TAKEN, "error");
          setSelectedSlots([]);
          setStep(2);
        } else {
          toast(errorMsg, "error");
        }
        return;
      }

      const bookingGroupId: string = data.booking_group_id ?? "";

      router.push(
        `/book/${experiment.id}/confirm?bookingGroupId=${bookingGroupId}`
      );
    } catch {
      toast("네트워크 오류가 발생했습니다. 다시 시도해주세요.", "error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <div className="mb-6 text-center">
        <h1 className="text-2xl font-bold text-foreground">{experiment.title}</h1>
        {experiment.description && (
          <p className="mt-2 text-sm text-muted">{experiment.description}</p>
        )}
        {experiment.categories && experiment.categories.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5">
            {experiment.categories.map((c) => (
              <span
                key={c}
                className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary"
              >
                #{categoryLabel(c)}
              </span>
            ))}
          </div>
        )}
        {(() => {
          if (location) {
            return (
              <p className="mt-2 text-xs text-muted">
                📍 {location.name} — {location.address_lines[0]}
              </p>
            );
          }
          if (experiment.location) {
            const legacy = locationInfo(experiment.location);
            if (legacy) {
              return (
                <p className="mt-2 text-xs text-muted">
                  📍 {legacy.shortName} — {legacy.addressLines[0]}
                </p>
              );
            }
          }
          return null;
        })()}
        {experiment.irb_document_url && (
          <a
            href={experiment.irb_document_url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-blue-600 hover:text-blue-800 transition-colors"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            IRB 승인 문서 보기
          </a>
        )}
      </div>

      <StepIndicator current={step} />

      {/* Precaution Check Modal */}
      {hasPrecautions && (
        <PrecautionCheck
          open={showPrecautions}
          onClose={() => setShowPrecautions(false)}
          onConfirm={handlePrecautionsConfirmed}
          precautions={experiment.precautions}
          irbDocumentUrl={experiment.irb_document_url}
        />
      )}

      {step === 1 && (
        <div>
          <div className="mb-5 flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-foreground">
              참여자 정보 입력
            </h2>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                if (typeof window !== "undefined" && window.history.length > 1) {
                  router.back();
                } else {
                  router.push("/");
                }
              }}
            >
              ← 뒤로가기
            </Button>
          </div>
          <ParticipantForm
            onSubmit={handleParticipantSubmit}
            initialData={participant ?? undefined}
          />
        </div>
      )}

      {step === 2 && (
        <div>
          <h2 className="mb-5 text-lg font-semibold text-foreground">
            시간대 선택
          </h2>
          {experiment.session_type === "multi" && (
            <p className="mb-4 text-sm text-muted">
              총 {requiredSessions}회차의 시간대를 각각 선택해주세요.
            </p>
          )}
          <WeekTimetable
            experimentId={experiment.id}
            experiment={experiment}
            selectedSlots={selectedSlots}
            onChange={handleSlotsSelect}
          />
          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-between">
            <Button
              variant="secondary"
              size="lg"
              className="w-full sm:w-auto"
              onClick={() => setStep(1)}
            >
              이전
            </Button>
            <Button
              size="lg"
              className="w-full sm:w-auto"
              onClick={handleStep2Next}
              disabled={!canProceedFromStep2}
            >
              다음 단계
            </Button>
          </div>
        </div>
      )}

      {step === 3 && participant && (
        <div>
          <h2 className="mb-5 text-lg font-semibold text-foreground">
            예약 확인
          </h2>
          <BookingSummary
            experiment={experiment}
            participant={participant}
            slots={selectedSlots}
          />
          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-between">
            <Button
              variant="secondary"
              size="lg"
              className="w-full sm:w-auto"
              onClick={() => setStep(2)}
              disabled={submitting}
            >
              이전
            </Button>
            <Button
              size="lg"
              className="w-full sm:w-auto"
              onClick={handleConfirm}
              disabled={submitting}
            >
              {submitting ? (
                <span className="flex items-center gap-2">
                  <svg
                    className="h-4 w-4 animate-spin"
                    viewBox="0 0 24 24"
                    fill="none"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
                    />
                  </svg>
                  처리 중...
                </span>
              ) : (
                "예약 확정"
              )}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
