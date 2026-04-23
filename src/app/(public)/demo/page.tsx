"use client";

import { useState } from "react";
import { ParticipantForm } from "@/components/booking/participant-form";
import { BookingSummary } from "@/components/booking/booking-summary";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatTimeKR } from "@/lib/utils/date";
import { useToast } from "@/components/ui/toast";
import { PrecautionCheck } from "@/components/booking/precaution-check";
import type { Experiment } from "@/types/database";
import { z } from "zod/v4";
import { participantSchema } from "@/lib/utils/validation";

type ParticipantData = z.infer<typeof participantSchema>;

interface SerializedSlot {
  slot_start: string;
  slot_end: string;
  session_number?: number;
}

// Mock experiment data for demo
const DEMO_EXPERIMENT: Experiment = {
  id: "demo-experiment-001",
  lab_id: "00000000-0000-0000-0000-000000000000",
  title: "시각 인지 실험 (fMRI)",
  description:
    "fMRI를 이용한 시각 자극 인지 반응 시간 측정 실험입니다. 총 2회차, 각 60분 소요되며 참여비 60,000원이 지급됩니다.",
  start_date: new Date().toISOString().split("T")[0],
  end_date: new Date(Date.now() + 14 * 86400000).toISOString().split("T")[0],
  daily_start_time: "09:00",
  daily_end_time: "18:00",
  session_duration_minutes: 60,
  break_between_slots_minutes: 15,
  max_participants_per_slot: 2,
  participation_fee: 60000,
  session_type: "multi",
  required_sessions: 2,
  status: "active",
  google_calendar_id: null,
  irb_document_url: "https://example.com/irb-approval.pdf",
  precautions: [
    { question: "체내 금속 삽입물(임플란트, 인공관절 등)이 없으신가요?", required_answer: true },
    { question: "폐소공포증 등 MRI 촬영에 어려움이 없으신가요?", required_answer: true },
    { question: "실험 전 24시간 내 음주를 하지 않으셨나요?", required_answer: true },
    { question: "본 실험의 IRB 승인 문서를 확인하셨나요?", required_answer: true },
  ],
  categories: ["mri", "eye_tracking"],
  location: "snubic",
  location_id: null,
  weekdays: [0, 1, 2, 3, 4, 5, 6],
  registration_deadline: null,
  auto_lock: true,
  subject_start_number: 1,
  project_name: null,
  reminder_day_before_enabled: true,
  reminder_day_before_time: "18:00",
  reminder_day_of_enabled: true,
  reminder_day_of_time: "09:00",
  code_repo_url: "https://github.com/example/demo-exp",
  data_path: "/data/demo/exp001",
  parameter_schema: [],
  pre_experiment_checklist: [],
  checklist_completed_at: new Date().toISOString(),
  notion_experiment_page_id: null,
  notion_experiment_sync_attempted_at: null,
  protocol_version: null,
  experiment_mode: "offline",
  online_runtime_config: null,
  data_consent_required: false,
  created_by: "demo",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

// Generate demo slots for today + next 7 days
function generateDemoSlots(date: string): SerializedSlot[] {
  const slots: SerializedSlot[] = [];
  const start = 9;
  const end = 18;
  const duration = 60;
  const breakMin = 15;

  for (let hour = start; hour + duration / 60 <= end; hour += (duration + breakMin) / 60) {
    const h = Math.floor(hour);
    const m = (hour - h) * 60;
    const startDate = new Date(`${date}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+09:00`);
    const endDate = new Date(startDate.getTime() + duration * 60000);

    // Randomly mark some as "taken" for realism
    if (Math.random() > 0.3) {
      slots.push({
        slot_start: startDate.toISOString(),
        slot_end: endDate.toISOString(),
      });
    }
  }
  return slots;
}

type Step = 1 | 2 | 3 | 4;

const STEP_LABELS: Record<Step, string> = {
  1: "참여자 정보",
  2: "시간대 선택",
  3: "예약 확인",
  4: "완료",
};

function StepIndicator({ current }: { current: Step }) {
  const steps: Step[] = [1, 2, 3, 4];
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
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                step
              )}
            </div>
            <span className={`text-xs ${step === current ? "font-semibold text-primary" : "text-muted"}`}>
              {STEP_LABELS[step]}
            </span>
          </div>
          {i < steps.length - 1 && (
            <div className={`mb-5 h-px w-10 sm:w-16 ${step < current ? "bg-green-400" : "bg-gray-200"}`} />
          )}
        </div>
      ))}
    </div>
  );
}

export default function DemoPage() {
  const { toast } = useToast();
  const experiment = DEMO_EXPERIMENT;

  const [step, setStep] = useState<Step>(1);
  const [participant, setParticipant] = useState<ParticipantData | null>(null);
  const [selectedSlots, setSelectedSlots] = useState<SerializedSlot[]>([]);
  const [selectedDate, setSelectedDate] = useState("");
  const [demoSlots, setDemoSlots] = useState<SerializedSlot[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [showPrecautions, setShowPrecautions] = useState(false);
  const [precautionsCleared, setPrecautionsCleared] = useState(false);

  const hasPrecautions = experiment.precautions.length > 0;

  const handleParticipantSubmit = (data: ParticipantData) => {
    setParticipant(data);
    if (hasPrecautions && !precautionsCleared) {
      setShowPrecautions(true);
    } else {
      setStep(2);
      toast("참여자 정보가 입력되었습니다.", "success");
    }
  };

  const handlePrecautionsConfirmed = () => {
    setPrecautionsCleared(true);
    setShowPrecautions(false);
    setStep(2);
    toast("확인사항 통과! 시간대를 선택해주세요.", "success");
  };

  // Multi-session state: per-session date and slots
  const requiredSessions = experiment.session_type === "multi" ? experiment.required_sessions : 1;
  const [sessionDates, setSessionDates] = useState<string[]>(Array(requiredSessions).fill(""));
  const [sessionSlots, setSessionSlots] = useState<(SerializedSlot[] | null)[]>(Array(requiredSessions).fill(null));

  const handleSessionDateChange = (sessionIdx: number, date: string) => {
    const next = [...sessionDates];
    next[sessionIdx] = date;
    setSessionDates(next);
    // Generate fresh slots for this session
    const nextSlots = [...sessionSlots];
    nextSlots[sessionIdx] = generateDemoSlots(date);
    setSessionSlots(nextSlots);
    // Clear selected slot for this session
    setSelectedSlots((prev) => prev.filter((s) => s.session_number !== sessionIdx + 1));
  };

  const handleSessionSlotClick = (sessionIdx: number, slot: SerializedSlot) => {
    const sessionNumber = sessionIdx + 1;
    const isSelected = selectedSlots.some(
      (s) => s.session_number === sessionNumber && s.slot_start === slot.slot_start
    );
    if (isSelected) {
      setSelectedSlots((prev) => prev.filter((s) => s.session_number !== sessionNumber));
    } else {
      setSelectedSlots((prev) => [
        ...prev.filter((s) => s.session_number !== sessionNumber),
        { ...slot, session_number: sessionNumber },
      ]);
    }
  };

  // Check if a date is already used by another session
  const isDateUsedByOther = (sessionIdx: number, date: string) =>
    sessionDates.some((d, i) => i !== sessionIdx && d === date && d !== "");

  const handleConfirm = async () => {
    setSubmitting(true);
    await new Promise((r) => setTimeout(r, 1500));
    setSubmitting(false);
    setStep(4);
    toast("예약이 확정되었습니다!", "success");
  };

  return (
    <div>
      <div className="mb-2 flex justify-center">
        <Badge variant="info">DEMO MODE</Badge>
      </div>
      <div className="mb-6 text-center">
        <h1 className="text-2xl font-bold text-foreground">{experiment.title}</h1>
        <p className="mt-2 text-sm text-muted">{experiment.description}</p>
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

      {/* Step 1: Participant Info */}
      {step === 1 && (
        <div>
          <h2 className="mb-5 text-lg font-semibold text-foreground">참여자 정보 입력</h2>
          <ParticipantForm onSubmit={handleParticipantSubmit} initialData={participant ?? undefined} />
        </div>
      )}

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

      {/* Step 2: Slot Selection (multi-session aware) */}
      {step === 2 && (
        <div>
          <h2 className="mb-5 text-lg font-semibold text-foreground">시간대 선택</h2>
          {requiredSessions > 1 && (
            <p className="mb-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
              총 <strong>{requiredSessions}회차</strong>의 시간대를 각각 <strong>서로 다른 날짜</strong>에 선택해주세요.
            </p>
          )}

          <div className="space-y-8">
            {Array.from({ length: requiredSessions }).map((_, sessionIdx) => {
              const date = sessionDates[sessionIdx] ?? "";
              const slots = sessionSlots[sessionIdx] ?? [];
              const dateConflict = date && isDateUsedByOther(sessionIdx, date);
              const sessionSelected = selectedSlots.find((s) => s.session_number === sessionIdx + 1);

              return (
                <div key={sessionIdx} className="space-y-4">
                  {requiredSessions > 1 && (
                    <div>
                      <h3 className="text-sm font-semibold text-foreground">
                        {sessionIdx + 1}회차 날짜 및 시간 선택
                      </h3>
                      <p className="mt-1 text-xs text-muted">
                        총 {requiredSessions}회차 참여 필요 - 각 회차는 서로 다른 날짜에 진행됩니다
                      </p>
                    </div>
                  )}
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor={`demo-date-${sessionIdx}`} className="text-sm font-medium text-foreground">
                      날짜
                    </label>
                    <input
                      id={`demo-date-${sessionIdx}`}
                      type="date"
                      value={date}
                      min={experiment.start_date}
                      max={experiment.end_date}
                      onChange={(e) => handleSessionDateChange(sessionIdx, e.target.value)}
                      className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                    />
                  </div>

                  {dateConflict && (
                    <div className="rounded-lg border border-yellow-300 bg-yellow-50 p-3">
                      <p className="text-sm text-yellow-800">
                        이 날짜는 다른 회차에서 이미 선택되었습니다. 서로 다른 날짜를 선택해주세요.
                      </p>
                    </div>
                  )}

                  {date && !dateConflict && (
                    <div>
                      <p className="mb-3 text-sm font-medium text-foreground">시간 선택</p>
                      {slots.length === 0 ? (
                        <p className="rounded-lg border border-border bg-card py-6 text-center text-sm text-muted">
                          선택 가능한 시간대가 없습니다
                        </p>
                      ) : (
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                          {slots.map((slot) => {
                            const isSelected = sessionSelected?.slot_start === slot.slot_start;
                            return (
                              <button
                                key={slot.slot_start}
                                type="button"
                                onClick={() => handleSessionSlotClick(sessionIdx, slot)}
                                className={`
                                  min-h-[44px] rounded-lg border px-2 py-2.5 text-sm font-medium
                                  transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1
                                  ${
                                    isSelected
                                      ? "border-primary bg-primary text-white"
                                      : "border-border bg-white text-foreground hover:border-primary hover:bg-blue-50"
                                  }
                                `}
                              >
                                {formatTimeKR(new Date(slot.slot_start))}
                                <span className="block text-xs opacity-75">~ {formatTimeKR(new Date(slot.slot_end))}</span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}

                  {sessionIdx < requiredSessions - 1 && (
                    <hr className="border-border" />
                  )}
                </div>
              );
            })}
          </div>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-between">
            <Button variant="secondary" size="lg" className="w-full sm:w-auto" onClick={() => setStep(1)}>
              이전
            </Button>
            <Button
              size="lg"
              className="w-full sm:w-auto"
              onClick={() => {
                if (selectedSlots.length < requiredSessions) {
                  toast(`${requiredSessions}개의 시간대를 모두 선택해주세요.`, "error");
                  return;
                }
                setStep(3);
              }}
              disabled={selectedSlots.length === 0}
            >
              다음 단계
            </Button>
          </div>
        </div>
      )}

      {/* Step 3: Confirmation */}
      {step === 3 && participant && (
        <div>
          <h2 className="mb-5 text-lg font-semibold text-foreground">예약 확인</h2>
          <BookingSummary experiment={experiment} participant={participant} slots={selectedSlots} />
          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-between">
            <Button variant="secondary" size="lg" className="w-full sm:w-auto" onClick={() => setStep(2)} disabled={submitting}>
              이전
            </Button>
            <Button size="lg" className="w-full sm:w-auto" onClick={handleConfirm} disabled={submitting}>
              {submitting ? (
                <span className="flex items-center gap-2">
                  <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
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

      {/* Step 4: Success */}
      {step === 4 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-center">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
                <svg className="h-8 w-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              예약이 완료되었습니다!
            </CardTitle>
          </CardHeader>
          <CardContent className="text-center">
            <p className="text-sm text-muted">
              {participant?.name}님, 확인 이메일과 SMS가 발송됩니다.
            </p>
            <p className="mt-1 text-sm text-muted">
              실험 전날 저녁 18시, 당일 오전 9시에 리마인더가 발송됩니다.
            </p>
            <div className="mt-6">
              <Button
                onClick={() => {
                  setStep(1);
                  setParticipant(null);
                  setSelectedSlots([]);
                  setSelectedDate("");
                  setDemoSlots([]);
                }}
              >
                처음으로 돌아가기
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Demo Info */}
      <div className="mt-12 rounded-lg border border-dashed border-blue-300 bg-blue-50 p-4 text-sm text-blue-800">
        <p className="font-semibold">Demo Mode 안내</p>
        <ul className="mt-2 list-inside list-disc space-y-1 text-xs">
          <li>이 페이지는 Supabase 연결 없이 작동하는 UI 데모입니다</li>
          <li>폼 유효성 검증 (Zod + react-hook-form)이 실제로 동작합니다</li>
          <li>시간대 슬롯은 랜덤 생성됩니다 (날짜를 다시 선택하면 변경됨)</li>
          <li>실제 배포 시 Supabase 연결 후 /book/[experimentId] 경로로 접근합니다</li>
        </ul>
      </div>
    </div>
  );
}
