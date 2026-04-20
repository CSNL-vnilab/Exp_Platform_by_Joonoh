"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import Link from "next/link";
import { SESSION_DURATIONS } from "@/lib/utils/constants";
import { experimentSchema } from "@/lib/utils/validation";
import { EXPERIMENT_CATEGORIES } from "@/lib/experiments/categories";
import { WeekTimetablePreview } from "@/components/booking/week-timetable-preview";
import type { Experiment, ExperimentInsert, ExperimentLocation } from "@/types/database";

const WEEKDAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"] as const;

interface CalendarOption {
  id: string;
  summary: string;
  primary?: boolean;
}

interface ExperimentFormProps {
  experiment?: Experiment;
  onCancel?: () => void;
}

export function ExperimentForm({ experiment, onCancel }: ExperimentFormProps) {
  const router = useRouter();
  const { toast } = useToast();
  const isEditing = !!experiment;

  const [title, setTitle] = useState(experiment?.title ?? "");
  const [description, setDescription] = useState(experiment?.description ?? "");
  const [startDate, setStartDate] = useState(experiment?.start_date ?? "");
  const [endDate, setEndDate] = useState(experiment?.end_date ?? "");
  const [dailyStartTime, setDailyStartTime] = useState(experiment?.daily_start_time ?? "09:00");
  const [dailyEndTime, setDailyEndTime] = useState(experiment?.daily_end_time ?? "18:00");
  const [sessionDuration, setSessionDuration] = useState(experiment?.session_duration_minutes ?? 60);
  const [breakMinutes, setBreakMinutes] = useState(experiment?.break_between_slots_minutes ?? 0);
  const [maxParticipants, setMaxParticipants] = useState(experiment?.max_participants_per_slot ?? 1);
  const [participationFee, setParticipationFee] = useState(experiment?.participation_fee ?? 0);
  const [sessionType, setSessionType] = useState<"single" | "multi">(experiment?.session_type ?? "single");
  const [requiredSessions, setRequiredSessions] = useState(experiment?.required_sessions ?? 1);
  const [googleCalendarId, setGoogleCalendarId] = useState(experiment?.google_calendar_id ?? "");
  const [irbDocumentUrl, setIrbDocumentUrl] = useState(experiment?.irb_document_url ?? "");
  const [precautions, setPrecautions] = useState<Array<{ question: string; required_answer: boolean }>>(
    experiment?.precautions ?? []
  );
  const [categories, setCategories] = useState<string[]>(experiment?.categories ?? []);
  const [locationId, setLocationId] = useState<string>(experiment?.location_id ?? "");
  const [locations, setLocations] = useState<ExperimentLocation[]>([]);

  // New fields (migration 00015)
  const [weekdays, setWeekdays] = useState<number[]>(experiment?.weekdays ?? [0, 1, 2, 3, 4, 5, 6]);
  const [registrationDeadline, setRegistrationDeadline] = useState<string>(() => {
    const raw = experiment?.registration_deadline;
    if (!raw) return "";
    // Convert ISO UTC to local datetime-local value (KST = UTC+9)
    const d = new Date(raw);
    const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
    return kst.toISOString().slice(0, 16);
  });
  const [autoLock, setAutoLock] = useState<boolean>(experiment?.auto_lock ?? true);
  const [subjectStartNumber, setSubjectStartNumber] = useState<number>(experiment?.subject_start_number ?? 1);
  const [projectName, setProjectName] = useState<string>(experiment?.project_name ?? "");

  const [previewOpen, setPreviewOpen] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [previewConfig, setPreviewConfig] = useState<Record<string, any> | null>(null);

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [calendars, setCalendars] = useState<CalendarOption[]>([]);
  const [calendarsLoading, setCalendarsLoading] = useState(true);
  const [calendarsError, setCalendarsError] = useState<string | null>(null);
  const [serviceAccountEmail, setServiceAccountEmail] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/locations");
        if (!cancelled && res.ok) {
          const data: ExperimentLocation[] = await res.json();
          setLocations(data);
        }
      } catch {
        // non-fatal: select will just be empty
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/google/calendars");
        const data = await res.json();
        if (cancelled) return;
        setServiceAccountEmail(data.serviceAccountEmail ?? null);
        if (!res.ok) {
          setCalendarsError(data.error ?? "캘린더 조회 실패");
          setCalendars([]);
        } else {
          const list: CalendarOption[] = data.calendars ?? [];
          setCalendars(list);

          // Preselect: prefer explicit experiment value, else a calendar named
          // like "Slab Calendar" (case-insensitive), else project default env.
          if (!googleCalendarId) {
            const slab = list.find((c) => /slab/i.test(c.summary));
            if (slab) setGoogleCalendarId(slab.id);
            else if (data.defaultId) setGoogleCalendarId(data.defaultId);
          }
        }
      } catch {
        if (!cancelled) setCalendarsError("캘린더 API 호출 실패");
      } finally {
        if (!cancelled) setCalendarsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setErrors({});

    // Convert datetime-local (KST) to full ISO UTC string
    const registrationDeadlineIso =
      registrationDeadline
        ? new Date(`${registrationDeadline}+09:00`).toISOString()
        : null;

    const formData = {
      title,
      description: description || undefined,
      start_date: startDate,
      end_date: endDate,
      daily_start_time: dailyStartTime,
      daily_end_time: dailyEndTime,
      session_duration_minutes: sessionDuration,
      break_between_slots_minutes: breakMinutes,
      max_participants_per_slot: maxParticipants,
      participation_fee: participationFee,
      session_type: sessionType,
      required_sessions: sessionType === "multi" ? requiredSessions : 1,
      google_calendar_id: googleCalendarId || undefined,
      irb_document_url: irbDocumentUrl || undefined,
      precautions,
      categories,
      location_id: locationId || null,
      weekdays,
      registration_deadline: registrationDeadlineIso,
      auto_lock: autoLock,
      subject_start_number: subjectStartNumber,
      project_name: projectName || null,
    };

    const result = experimentSchema.safeParse(formData);
    if (!result.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of result.error.issues) {
        const key = issue.path.join(".");
        if (key && !fieldErrors[key]) {
          fieldErrors[key] = issue.message;
        }
      }
      setErrors(fieldErrors);
      return;
    }

    setSubmitting(true);

    try {
      const supabase = createClient();

      if (isEditing) {
        const { error } = await supabase
          .from("experiments")
          .update(formData)
          .eq("id", experiment.id);

        if (error) throw error;
        toast("실험이 수정되었습니다.", "success");
        router.refresh();
        onCancel?.();
      } else {
        const {
          data: { user },
        } = await supabase.auth.getUser();

        const insertData: ExperimentInsert = {
          ...formData,
          created_by: user?.id ?? null,
        };

        const { data, error } = await supabase
          .from("experiments")
          .insert(insertData)
          .select("id")
          .single();

        if (error) throw error;
        toast("실험이 생성되었습니다.", "success");
        router.push(`/experiments/${data.id}`);
      }
    } catch {
      toast("저장 중 오류가 발생했습니다.", "error");
    } finally {
      setSubmitting(false);
    }
  }

  function handlePreview() {
    const registrationDeadlineIso =
      registrationDeadline
        ? new Date(`${registrationDeadline}+09:00`).toISOString()
        : null;

    const formData = {
      title,
      description: description || undefined,
      start_date: startDate,
      end_date: endDate,
      daily_start_time: dailyStartTime,
      daily_end_time: dailyEndTime,
      session_duration_minutes: sessionDuration,
      break_between_slots_minutes: breakMinutes,
      max_participants_per_slot: maxParticipants,
      participation_fee: participationFee,
      session_type: sessionType,
      required_sessions: sessionType === "multi" ? requiredSessions : 1,
      google_calendar_id: googleCalendarId || undefined,
      irb_document_url: irbDocumentUrl || undefined,
      precautions,
      categories,
      location_id: locationId || null,
      weekdays,
      registration_deadline: registrationDeadlineIso,
      auto_lock: autoLock,
      subject_start_number: subjectStartNumber,
      project_name: projectName || null,
    };

    const result = experimentSchema.safeParse(formData);
    if (!result.success) {
      const firstIssue = result.error.issues[0];
      toast(firstIssue?.message ?? "입력값을 확인해주세요.", "error");
      return;
    }

    setPreviewConfig(result.data as Record<string, unknown>);
    setPreviewOpen(true);
  }

  return (
    <form onSubmit={handleSubmit}>
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Basic Info */}
        <Card className="lg:col-span-2">
          <CardContent>
            <h2 className="text-lg font-semibold text-foreground mb-4">기본 정보</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <Input
                  id="title"
                  label="실험 제목"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  error={errors.title}
                  placeholder="예: 시선추적 실험 A"
                  required
                />
              </div>
              <div className="sm:col-span-2">
                <label htmlFor="description" className="mb-1.5 block text-sm font-medium text-foreground">
                  실험 설명 (선택)
                </label>
                <textarea
                  id="description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                  placeholder="실험에 대한 간단한 설명을 입력하세요"
                  className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Date & Time */}
        <Card>
          <CardContent>
            <h2 className="text-lg font-semibold text-foreground mb-4">일정 설정</h2>
            <div className="grid gap-4">
              <Input
                id="start_date"
                label="시작 날짜"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                error={errors.start_date}
                required
              />
              <Input
                id="end_date"
                label="종료 날짜"
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                error={errors.end_date}
                required
              />
              <Input
                id="daily_start_time"
                label="일일 시작 시간"
                type="time"
                value={dailyStartTime}
                onChange={(e) => setDailyStartTime(e.target.value)}
                error={errors.daily_start_time}
                required
              />
              <Input
                id="daily_end_time"
                label="일일 종료 시간"
                type="time"
                value={dailyEndTime}
                onChange={(e) => setDailyEndTime(e.target.value)}
                error={errors.daily_end_time}
                required
              />
            </div>
          </CardContent>
        </Card>

        {/* Session Settings */}
        <Card>
          <CardContent>
            <h2 className="text-lg font-semibold text-foreground mb-4">세션 설정</h2>
            <div className="grid gap-4">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="session_duration" className="text-sm font-medium text-foreground">
                  세션 시간
                </label>
                <select
                  id="session_duration"
                  value={sessionDuration}
                  onChange={(e) => setSessionDuration(Number(e.target.value))}
                  className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                >
                  {SESSION_DURATIONS.map((d) => (
                    <option key={d.value} value={d.value}>
                      {d.label}
                    </option>
                  ))}
                </select>
                {errors.session_duration_minutes && (
                  <p className="text-xs text-danger">{errors.session_duration_minutes}</p>
                )}
              </div>

              <Input
                id="break_minutes"
                label="세션 간 휴식 시간 (분)"
                type="number"
                min={0}
                value={breakMinutes}
                onChange={(e) => setBreakMinutes(Number(e.target.value))}
                error={errors.break_between_slots_minutes}
              />

              <Input
                id="max_participants"
                label="슬롯당 최대 참여자 수"
                type="number"
                min={1}
                value={maxParticipants}
                onChange={(e) => setMaxParticipants(Number(e.target.value))}
                error={errors.max_participants_per_slot}
              />

              <Input
                id="participation_fee"
                label="참여비 (원)"
                type="number"
                min={0}
                step={1000}
                value={participationFee}
                onChange={(e) => setParticipationFee(Number(e.target.value))}
                error={errors.participation_fee}
              />
            </div>
          </CardContent>
        </Card>

        {/* Session Type */}
        <Card>
          <CardContent>
            <h2 className="text-lg font-semibold text-foreground mb-4">세션 유형</h2>
            <div className="grid gap-4">
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setSessionType("single")}
                  className={`
                    flex-1 rounded-lg border px-4 py-3 text-sm font-medium transition-colors
                    ${
                      sessionType === "single"
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border bg-white text-muted hover:bg-card"
                    }
                  `}
                >
                  단일 세션
                </button>
                <button
                  type="button"
                  onClick={() => setSessionType("multi")}
                  className={`
                    flex-1 rounded-lg border px-4 py-3 text-sm font-medium transition-colors
                    ${
                      sessionType === "multi"
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border bg-white text-muted hover:bg-card"
                    }
                  `}
                >
                  다중 세션
                </button>
              </div>

              {sessionType === "multi" && (
                <Input
                  id="required_sessions"
                  label="필수 회차 수"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={requiredSessions === 0 ? "" : String(requiredSessions)}
                  onChange={(e) => {
                    const digits = e.target.value.replace(/\D/g, "");
                    setRequiredSessions(digits === "" ? 0 : Math.max(2, Number(digits)));
                  }}
                  error={errors.required_sessions}
                />
              )}
            </div>
          </CardContent>
        </Card>

        {/* IRB & Precautions */}
        <Card className="lg:col-span-2">
          <CardContent>
            <h2 className="text-lg font-semibold text-foreground mb-4">IRB 승인 및 참여 조건</h2>
            <div className="grid gap-4">
              <Input
                id="irb_document_url"
                label="IRB 승인 문서 URL (선택)"
                value={irbDocumentUrl}
                onChange={(e) => setIrbDocumentUrl(e.target.value)}
                placeholder="https://drive.google.com/file/d/..."
                error={errors.irb_document_url}
              />

              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-medium text-foreground">
                    참여 전 확인사항 (주의사항)
                  </label>
                  <button
                    type="button"
                    onClick={() =>
                      setPrecautions([...precautions, { question: "", required_answer: true }])
                    }
                    className="text-xs font-medium text-primary hover:text-primary-hover"
                  >
                    + 항목 추가
                  </button>
                </div>
                <p className="mb-3 text-xs text-muted">
                  참여자가 예약 전 반드시 확인해야 할 사항을 추가하세요. 각 질문에 &quot;예&quot;로 응답해야 예약이 진행됩니다.
                </p>
                {precautions.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-border py-4 text-center text-xs text-muted">
                    등록된 확인사항이 없습니다
                  </p>
                ) : (
                  <div className="space-y-3">
                    {precautions.map((item, index) => (
                      <div key={index} className="flex items-start gap-2">
                        <div className="flex-1">
                          <input
                            value={item.question}
                            onChange={(e) => {
                              const next = [...precautions];
                              next[index] = { ...next[index], question: e.target.value };
                              setPrecautions(next);
                            }}
                            placeholder={`확인사항 ${index + 1} (예: 체내 금속 삽입물이 없으신가요?)`}
                            className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => setPrecautions(precautions.filter((_, i) => i !== index))}
                          className="mt-2 text-muted hover:text-danger"
                        >
                          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Research categories + location */}
        <Card>
          <CardContent>
            <h2 className="text-lg font-semibold text-foreground mb-4">연구 분류 · 장소</h2>

            <div className="mb-5 flex flex-col gap-2">
              <span className="text-sm font-medium text-foreground">연구 카테고리 (복수선택)</span>
              <p className="text-xs text-muted">선택한 카테고리는 예약 페이지에서 참여자에게 뱃지로 표시됩니다.</p>
              <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {EXPERIMENT_CATEGORIES.map((cat) => {
                  const checked = categories.includes(cat.value);
                  return (
                    <label
                      key={cat.value}
                      className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${
                        checked
                          ? "border-primary bg-primary/5 text-primary"
                          : "border-border text-foreground hover:bg-card"
                      }`}
                    >
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-primary"
                        checked={checked}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setCategories([...categories, cat.value]);
                          } else {
                            setCategories(categories.filter((c) => c !== cat.value));
                          }
                        }}
                      />
                      # {cat.label}
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-foreground">실험 장소</span>
                <Link
                  href="/locations"
                  className="text-xs font-medium text-primary hover:text-primary-hover"
                >
                  + 새 장소
                </Link>
              </div>
              <p className="text-xs text-muted">
                참여자가 예약 완료 시 선택한 장소의 주소와 지도 링크가 표시됩니다.
              </p>
              <select
                id="location_id"
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
                className="mt-1 w-full rounded-lg border border-border bg-white px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
              >
                <option value="">(선택 안 함)</option>
                {locations.map((loc) => (
                  <option key={loc.id} value={loc.id}>
                    {loc.name}
                  </option>
                ))}
              </select>
            </div>
          </CardContent>
        </Card>

        {/* Google Calendar */}
        <Card>
          <CardContent>
            <h2 className="text-lg font-semibold text-foreground mb-4">연동 설정</h2>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="google_calendar_id" className="text-sm font-medium text-foreground">
                예약 동기화 캘린더 (선택)
              </label>
              {calendarsLoading ? (
                <div className="h-10 animate-pulse rounded-lg bg-gray-100" />
              ) : calendarsError ? (
                <>
                  <Input
                    id="google_calendar_id"
                    value={googleCalendarId}
                    onChange={(e) => setGoogleCalendarId(e.target.value)}
                    placeholder="calendar@group.calendar.google.com"
                  />
                  <p className="text-xs text-danger">
                    {calendarsError} — 캘린더 ID를 직접 입력하세요
                  </p>
                </>
              ) : (
                <>
                  <select
                    id="google_calendar_id"
                    value={googleCalendarId}
                    onChange={(e) => setGoogleCalendarId(e.target.value)}
                    className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                  >
                    <option value="">(사용 안 함)</option>
                    {calendars.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.summary}
                        {c.primary ? " (기본)" : ""}
                      </option>
                    ))}
                    {googleCalendarId && !calendars.some((c) => c.id === googleCalendarId) && (
                      <option value={googleCalendarId}>{googleCalendarId} (외부)</option>
                    )}
                  </select>
                  {calendars.length === 0 && (
                    <>
                      <p className="text-xs text-danger">
                        서비스 계정이 접근 가능한 캘린더가 없습니다. 아래 이메일을 대상 캘린더에
                        "이벤트 변경 권한"으로 공유하세요.
                      </p>
                      {serviceAccountEmail && (
                        <div className="mt-1 rounded-md border border-blue-200 bg-blue-50 p-2 text-xs text-blue-900">
                          <div className="font-medium">서비스 계정 이메일</div>
                          <code className="block break-all">{serviceAccountEmail}</code>
                          <div className="mt-1 text-blue-800">
                            Google Calendar → 해당 캘린더 설정 → 특정 사용자와 공유 →{" "}
                            <b>이벤트 변경 권한</b>으로 추가하면 목록에 나타납니다.
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Weekdays & Schedule Options */}
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardContent>
            <h2 className="text-lg font-semibold text-foreground mb-4">실험 운영 요일</h2>
            <p className="mb-3 text-xs text-muted">슬롯이 생성될 요일을 선택하세요. 최소 1개 이상 선택해야 합니다.</p>
            <div className="flex gap-2">
              {WEEKDAY_LABELS.map((label, idx) => {
                const checked = weekdays.includes(idx);
                return (
                  <label
                    key={idx}
                    className={`flex flex-1 cursor-pointer flex-col items-center rounded-lg border px-2 py-2 text-sm font-medium transition-colors ${
                      checked
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border text-foreground hover:bg-card"
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={checked}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setWeekdays([...weekdays, idx].sort((a, b) => a - b));
                        } else {
                          setWeekdays(weekdays.filter((d) => d !== idx));
                        }
                      }}
                    />
                    {label}
                  </label>
                );
              })}
            </div>
            {errors.weekdays && (
              <p className="mt-1.5 text-xs text-danger">{errors.weekdays}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent>
            <h2 className="text-lg font-semibold text-foreground mb-4">모집 옵션</h2>
            <div className="grid gap-4">
              {/* registration_deadline */}
              <div className="flex flex-col gap-1.5">
                <label htmlFor="registration_deadline" className="text-sm font-medium text-foreground">
                  모집 마감 일시 (선택)
                </label>
                <div className="flex items-center gap-2">
                  <input
                    id="registration_deadline"
                    type="datetime-local"
                    value={registrationDeadline}
                    onChange={(e) => setRegistrationDeadline(e.target.value)}
                    className="flex-1 rounded-lg border border-border bg-white px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                  />
                  {registrationDeadline && (
                    <button
                      type="button"
                      onClick={() => setRegistrationDeadline("")}
                      className="rounded-lg border border-border px-3 py-2 text-xs text-muted hover:bg-card hover:text-foreground"
                    >
                      없음
                    </button>
                  )}
                </div>
                {errors.registration_deadline && (
                  <p className="text-xs text-danger">{errors.registration_deadline}</p>
                )}
              </div>

              {/* auto_lock */}
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-primary"
                  checked={autoLock}
                  onChange={(e) => setAutoLock(e.target.checked)}
                />
                <div>
                  <span className="text-sm font-medium text-foreground">
                    모집 정원 소진 시 자동 종료
                  </span>
                  <p className="mt-0.5 text-xs text-muted">
                    모든 슬롯이 가득 차면 실험 상태가 자동으로 &apos;완료&apos;로 변경됩니다.
                  </p>
                </div>
              </label>
            </div>
          </CardContent>
        </Card>

        {/* Project & Numbering */}
        <Card className="lg:col-span-2">
          <CardContent>
            <h2 className="text-lg font-semibold text-foreground mb-4">프로젝트 및 피험자 설정</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Input
                  id="project_name"
                  label="프로젝트 약칭 (캘린더 이벤트에 사용)"
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  placeholder="예: TimeEst"
                  error={errors.project_name}
                />
                <p className="mt-1 text-xs text-muted">빈 값이면 실험 제목이 그대로 쓰입니다.</p>
              </div>
              <div>
                <Input
                  id="subject_start_number"
                  label="Sbj 시작 번호"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={subjectStartNumber === 0 ? "" : String(subjectStartNumber)}
                  onChange={(e) => {
                    const digits = e.target.value.replace(/\D/g, "");
                    setSubjectStartNumber(digits === "" ? 0 : Number(digits));
                  }}
                  error={errors.subject_start_number}
                />
                <p className="mt-1 text-xs text-muted">첫 참여자에게 할당되는 Sbj 번호입니다. 이후는 자동 증가.</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Preview Modal */}
      <Modal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        title="실험 시간표 미리보기"
      >
        {previewConfig && <WeekTimetablePreview config={previewConfig} />}
      </Modal>

      {/* Actions */}
      <div className="mt-6 flex items-center gap-3">
        <Button type="button" variant="secondary" onClick={handlePreview}>
          미리보기
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting
            ? "저장 중..."
            : isEditing
              ? "수정 완료"
              : "실험 생성"}
        </Button>
        {onCancel && (
          <Button type="button" variant="secondary" onClick={onCancel}>
            취소
          </Button>
        )}
        {!isEditing && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => router.back()}
          >
            뒤로가기
          </Button>
        )}
      </div>
    </form>
  );
}
