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
import type {
  Experiment,
  ExperimentChecklistItem,
  ExperimentInsert,
  ExperimentLocation,
  ExperimentParameterSpec,
  ExperimentParameterType,
} from "@/types/database";

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

  // Reminder schedule (defaults: day-before 18:00 KST + day-of 09:00 KST)
  const [reminderDayBeforeEnabled, setReminderDayBeforeEnabled] = useState<boolean>(
    experiment?.reminder_day_before_enabled ?? true,
  );
  const [reminderDayBeforeTime, setReminderDayBeforeTime] = useState<string>(
    (experiment?.reminder_day_before_time ?? "18:00").slice(0, 5),
  );
  const [reminderDayOfEnabled, setReminderDayOfEnabled] = useState<boolean>(
    experiment?.reminder_day_of_enabled ?? true,
  );
  const [reminderDayOfTime, setReminderDayOfTime] = useState<string>(
    (experiment?.reminder_day_of_time ?? "09:00").slice(0, 5),
  );

  // Research metadata (migration 00022) — required for status → active.
  const [codeRepoUrl, setCodeRepoUrl] = useState<string>(experiment?.code_repo_url ?? "");
  const [dataPath, setDataPath] = useState<string>(experiment?.data_path ?? "");
  const [parameterSchema, setParameterSchema] = useState<ExperimentParameterSpec[]>(
    experiment?.parameter_schema ?? [],
  );
  const [checklist, setChecklist] = useState<ExperimentChecklistItem[]>(
    experiment?.pre_experiment_checklist ?? [],
  );

  // Online runtime (migration 00023).
  const [experimentMode, setExperimentMode] = useState<"offline" | "online" | "hybrid">(
    experiment?.experiment_mode ?? "offline",
  );
  const [onlineEntryUrl, setOnlineEntryUrl] = useState<string>(
    experiment?.online_runtime_config?.entry_url ?? "",
  );
  const [onlineBlockCount, setOnlineBlockCount] = useState<number | "">(
    experiment?.online_runtime_config?.block_count ?? "",
  );
  const [onlineTrialCount, setOnlineTrialCount] = useState<number | "">(
    experiment?.online_runtime_config?.trial_count ?? "",
  );
  const [onlineEstimatedMinutes, setOnlineEstimatedMinutes] = useState<number | "">(
    experiment?.online_runtime_config?.estimated_minutes ?? "",
  );
  const [completionTokenFormat, setCompletionTokenFormat] = useState<string>(
    experiment?.online_runtime_config?.completion_token_format ?? "uuid",
  );
  const [dataConsentRequired, setDataConsentRequired] = useState<boolean>(
    experiment?.data_consent_required ?? false,
  );

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
          const json = await res.json();
          const list: ExperimentLocation[] = Array.isArray(json)
            ? json
            : (json.locations ?? []);
          setLocations(list);
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

  function buildOnlineConfig() {
    if (experimentMode === "offline") return null;
    const cfg: {
      entry_url: string;
      trial_count?: number;
      block_count?: number;
      estimated_minutes?: number;
      completion_token_format?: string;
    } = { entry_url: onlineEntryUrl.trim() };
    if (typeof onlineTrialCount === "number") cfg.trial_count = onlineTrialCount;
    if (typeof onlineBlockCount === "number") cfg.block_count = onlineBlockCount;
    if (typeof onlineEstimatedMinutes === "number")
      cfg.estimated_minutes = onlineEstimatedMinutes;
    if (completionTokenFormat) {
      cfg.completion_token_format = completionTokenFormat;
    }
    return cfg;
  }

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
      reminder_day_before_enabled: reminderDayBeforeEnabled,
      reminder_day_before_time: reminderDayBeforeTime,
      reminder_day_of_enabled: reminderDayOfEnabled,
      reminder_day_of_time: reminderDayOfTime,
      code_repo_url: codeRepoUrl.trim() || null,
      data_path: dataPath.trim() || null,
      parameter_schema: parameterSchema,
      pre_experiment_checklist: checklist,
      experiment_mode: experimentMode,
      online_runtime_config: buildOnlineConfig(),
      data_consent_required: dataConsentRequired,
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
      // Surface the first issue as a toast — parameter_schema / checklist
      // errors live on deeply-nested paths that don't have a single inline
      // host, so without this a validation failure looks like a silent
      // no-op to the researcher.
      const first = result.error.issues[0];
      if (first) {
        const pathHint = first.path.length > 0 ? ` (${first.path.join(".")})` : "";
        toast(`${first.message}${pathHint}`, "error");
      }
      return;
    }

    // If editing an already-active experiment, code_repo_url and data_path
    // must remain present (DB trigger would reject otherwise, but inline is
    // a better researcher experience).
    if (isEditing && experiment?.status === "active") {
      const metaErrors: Record<string, string> = {};
      if (!codeRepoUrl.trim()) {
        metaErrors.code_repo_url = "활성 실험에서는 코드 저장소를 비울 수 없습니다";
      }
      if (!dataPath.trim()) {
        metaErrors.data_path = "활성 실험에서는 데이터 경로를 비울 수 없습니다";
      }
      if (Object.keys(metaErrors).length > 0) {
        setErrors(metaErrors);
        return;
      }
    }

    setSubmitting(true);

    try {
      const supabase = createClient();

      if (isEditing) {
        // If the checklist shape changed (items added/removed/renamed or
        // required flags shifted), drop the prior "completed" timestamp so
        // the booking gate recomputes from scratch.
        const prevChecklist = experiment?.pre_experiment_checklist ?? [];
        const checklistShapeChanged =
          prevChecklist.length !== checklist.length ||
          prevChecklist.some(
            (p, i) =>
              p.item !== checklist[i]?.item || p.required !== checklist[i]?.required,
          );
        const patch = checklistShapeChanged
          ? { ...formData, checklist_completed_at: null }
          : formData;

        const { error } = await supabase
          .from("experiments")
          .update(patch)
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
      reminder_day_before_enabled: reminderDayBeforeEnabled,
      reminder_day_before_time: reminderDayBeforeTime,
      reminder_day_of_enabled: reminderDayOfEnabled,
      reminder_day_of_time: reminderDayOfTime,
      code_repo_url: codeRepoUrl.trim() || null,
      data_path: dataPath.trim() || null,
      parameter_schema: parameterSchema,
      pre_experiment_checklist: checklist,
      experiment_mode: experimentMode,
      online_runtime_config: buildOnlineConfig(),
      data_consent_required: dataConsentRequired,
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

        {/* Experiment mode — offline / online / hybrid */}
        <Card className="lg:col-span-2">
          <CardContent>
            <h2 className="text-lg font-semibold text-foreground mb-2">실행 방식</h2>
            <p className="mb-4 text-xs text-muted">
              오프라인 실험은 기존과 동일하게 실험실에서 진행됩니다. 온라인 실험은 참여자가
              이메일 링크를 통해 /run 페이지에 접속하여 브라우저에서 수행합니다. 하이브리드는
              온라인 선행 과제 후 실험실 세션이 이어집니다.
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              {(
                [
                  ["offline", "오프라인", "실험실에서 진행"],
                  ["online", "온라인", "원격 브라우저"],
                  ["hybrid", "하이브리드", "온라인 + 실험실"],
                ] as const
              ).map(([val, label, desc]) => (
                <label
                  key={val}
                  className={`flex cursor-pointer flex-col gap-1 rounded-lg border p-3 text-sm transition-colors ${
                    experimentMode === val
                      ? "border-primary bg-primary/5"
                      : "border-border bg-white hover:border-primary/40"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="experiment_mode"
                      value={val}
                      checked={experimentMode === val}
                      onChange={() => setExperimentMode(val)}
                      className="h-4 w-4 accent-primary"
                    />
                    <span className="font-medium text-foreground">{label}</span>
                  </span>
                  <span className="ml-6 text-xs text-muted">{desc}</span>
                </label>
              ))}
            </div>

            {experimentMode !== "offline" && (
              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <Input
                    id="online_entry_url"
                    label="실험 JS 진입 URL *"
                    value={onlineEntryUrl}
                    onChange={(e) => setOnlineEntryUrl(e.target.value)}
                    placeholder="https://cdn.example.com/my-exp.js"
                    error={errors["online_runtime_config.entry_url"]}
                  />
                  <p className="mt-1 text-xs text-muted">
                    참여자 브라우저가 /run 페이지의 샌드박스에서 로드합니다. HTTPS CDN 경로를
                    권장합니다.
                  </p>
                </div>
                <Input
                  id="online_block_count"
                  label="블록 수"
                  type="number"
                  min={1}
                  value={onlineBlockCount === "" ? "" : String(onlineBlockCount)}
                  onChange={(e) =>
                    setOnlineBlockCount(e.target.value === "" ? "" : Number(e.target.value))
                  }
                  placeholder="예: 3"
                />
                <Input
                  id="online_trial_count"
                  label="트라이얼 수 (선택)"
                  type="number"
                  min={1}
                  value={onlineTrialCount === "" ? "" : String(onlineTrialCount)}
                  onChange={(e) =>
                    setOnlineTrialCount(e.target.value === "" ? "" : Number(e.target.value))
                  }
                  placeholder="예: 120"
                />
                <Input
                  id="online_estimated_minutes"
                  label="예상 소요 시간 (분)"
                  type="number"
                  min={1}
                  max={600}
                  value={
                    onlineEstimatedMinutes === "" ? "" : String(onlineEstimatedMinutes)
                  }
                  onChange={(e) =>
                    setOnlineEstimatedMinutes(
                      e.target.value === "" ? "" : Number(e.target.value),
                    )
                  }
                  placeholder="예: 25"
                />
                <div>
                  <label className="mb-1 block text-sm font-medium text-foreground">
                    완료 코드 형식
                  </label>
                  <select
                    value={completionTokenFormat}
                    onChange={(e) => setCompletionTokenFormat(e.target.value)}
                    className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                  >
                    <option value="uuid">UUID (권장)</option>
                    <option value="alphanumeric:8">영숫자 8자리</option>
                    <option value="alphanumeric:12">영숫자 12자리</option>
                    <option value="alphanumeric:16">영숫자 16자리</option>
                  </select>
                </div>
              </div>
            )}

            <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-white p-3">
              <input
                type="checkbox"
                checked={dataConsentRequired}
                onChange={(e) => setDataConsentRequired(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-primary"
              />
              <span className="text-sm leading-relaxed text-foreground">
                데이터 수집 동의 체크박스를 예약 페이지에 표시합니다. (온라인/하이브리드
                실험은 자동으로 동의 절차가 포함됩니다.)
              </span>
            </label>
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

        {/* Research metadata — required for activation (migration 00022) */}
        <Card className="lg:col-span-2">
          <CardContent>
            <h2 className="text-lg font-semibold text-foreground mb-2">연구 메타데이터</h2>
            <p className="mb-4 text-xs text-muted">
              실험을 활성화(active)하기 전에 분석 코드 저장소와 원본 데이터 경로를 반드시 지정해야 합니다.
              draft → active 전환 시 Notion DB에도 자동으로 페이지가 생성됩니다.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Input
                  id="code_repo_url"
                  label="분석 코드 저장소 *"
                  value={codeRepoUrl}
                  onChange={(e) => setCodeRepoUrl(e.target.value)}
                  placeholder="https://github.com/org/repo 또는 /srv/lab/project"
                  error={errors.code_repo_url}
                />
                <p className="mt-1 text-xs text-muted">GitHub URL 또는 서버 내 절대 경로.</p>
              </div>
              <div>
                <Input
                  id="data_path"
                  label="원본 데이터 경로 *"
                  value={dataPath}
                  onChange={(e) => setDataPath(e.target.value)}
                  placeholder="예: /data/lab/exp42/raw"
                  error={errors.data_path}
                />
                <p className="mt-1 text-xs text-muted">raw 데이터가 저장되는 위치.</p>
              </div>
            </div>

            {/* Parameter schema */}
            <div className="mt-6">
              <div className="mb-2 flex items-center justify-between">
                <label className="text-sm font-medium text-foreground">실험 파라미터 스키마</label>
                <button
                  type="button"
                  onClick={() =>
                    setParameterSchema([
                      ...parameterSchema,
                      { key: "", type: "string" },
                    ])
                  }
                  className="text-xs font-medium text-primary hover:text-primary-hover"
                >
                  + 파라미터 추가
                </button>
              </div>
              <p className="mb-3 text-xs text-muted">
                각 세션에서 기록할 파라미터 이름과 타입을 선언해 두세요.
                enum 타입인 경우 선택지를 쉼표로 구분해 입력하세요.
              </p>
              {parameterSchema.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border py-4 text-center text-xs text-muted">
                  등록된 파라미터가 없습니다
                </p>
              ) : (
                <div className="space-y-2">
                  {parameterSchema.map((param, index) => (
                    <div key={index} className="flex flex-wrap items-start gap-2">
                      <input
                        value={param.key}
                        onChange={(e) => {
                          const next = [...parameterSchema];
                          next[index] = { ...next[index], key: e.target.value };
                          setParameterSchema(next);
                        }}
                        placeholder="key (예: stim_contrast)"
                        className="min-w-[12rem] flex-1 rounded-lg border border-border bg-white px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                      />
                      <select
                        value={param.type}
                        onChange={(e) => {
                          const next = [...parameterSchema];
                          const newType = e.target.value as ExperimentParameterType;
                          // Reset type-specific fields so stale options/default
                          // from a previous type don't silently persist.
                          next[index] = {
                            key: next[index].key,
                            type: newType,
                            ...(newType === "enum" ? { options: [] } : {}),
                          };
                          setParameterSchema(next);
                        }}
                        className="rounded-lg border border-border bg-white px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                      >
                        <option value="string">string</option>
                        <option value="number">number</option>
                        <option value="enum">enum</option>
                      </select>
                      {param.type === "enum" ? (
                        <input
                          value={(param.options ?? []).join(", ")}
                          onChange={(e) => {
                            const next = [...parameterSchema];
                            next[index] = {
                              ...next[index],
                              options: e.target.value
                                .split(",")
                                .map((s) => s.trim())
                                .filter(Boolean),
                            };
                            setParameterSchema(next);
                          }}
                          placeholder="옵션1, 옵션2, 옵션3"
                          className="min-w-[12rem] flex-1 rounded-lg border border-border bg-white px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                        />
                      ) : (
                        <input
                          value={param.default == null ? "" : String(param.default)}
                          onChange={(e) => {
                            const next = [...parameterSchema];
                            const raw = e.target.value;
                            next[index] = {
                              ...next[index],
                              default:
                                raw === ""
                                  ? null
                                  : param.type === "number"
                                    ? Number(raw)
                                    : raw,
                            };
                            setParameterSchema(next);
                          }}
                          placeholder="default (선택)"
                          className="min-w-[10rem] flex-1 rounded-lg border border-border bg-white px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                        />
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          setParameterSchema(parameterSchema.filter((_, i) => i !== index))
                        }
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

            {/* Pre-experiment checklist */}
            <div className="mt-6">
              <div className="mb-2 flex items-center justify-between">
                <label className="text-sm font-medium text-foreground">사전 체크리스트</label>
                <button
                  type="button"
                  onClick={() =>
                    setChecklist([...checklist, { item: "", required: true, checked: false }])
                  }
                  className="text-xs font-medium text-primary hover:text-primary-hover"
                >
                  + 항목 추가
                </button>
              </div>
              <p className="mb-3 text-xs text-muted">
                첫 참여자 예약 전 연구자가 완료해야 하는 점검 항목입니다. 필수 항목이
                하나라도 남아 있으면 공개 예약 페이지가 비활성화됩니다.
              </p>
              {checklist.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border py-4 text-center text-xs text-muted">
                  등록된 체크리스트 항목이 없습니다
                </p>
              ) : (
                <div className="space-y-2">
                  {checklist.map((item, index) => (
                    <div key={index} className="flex items-start gap-2">
                      <input
                        value={item.item}
                        onChange={(e) => {
                          const next = [...checklist];
                          next[index] = { ...next[index], item: e.target.value };
                          setChecklist(next);
                        }}
                        placeholder={`체크 항목 ${index + 1} (예: 장비 캘리브레이션 확인)`}
                        className="flex-1 rounded-lg border border-border bg-white px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                      />
                      <label className="flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-border bg-white px-2 py-2 text-xs">
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 accent-primary"
                          checked={item.required}
                          onChange={(e) => {
                            const next = [...checklist];
                            next[index] = { ...next[index], required: e.target.checked };
                            setChecklist(next);
                          }}
                        />
                        필수
                      </label>
                      <button
                        type="button"
                        onClick={() => setChecklist(checklist.filter((_, i) => i !== index))}
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
          </CardContent>
        </Card>

        {/* Reminder schedule */}
        <Card className="lg:col-span-2">
          <CardContent>
            <h2 className="text-lg font-semibold text-foreground mb-4">리마인더 일정</h2>
            <p className="mb-4 text-xs text-muted">
              예약 확정 후 참여자에게 이메일·SMS 안내를 두 번 발송합니다. 발신 주소는{" "}
              <code>GMAIL_USER</code>이며 실험자 이메일이 CC됩니다. 필요 시 각 채널을 끄거나 시각을 조정하세요.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
                <label className="flex items-center gap-2 text-sm font-medium">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-primary"
                    checked={reminderDayBeforeEnabled}
                    onChange={(e) => setReminderDayBeforeEnabled(e.target.checked)}
                  />
                  실험 전날 알림
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="time"
                    value={reminderDayBeforeTime}
                    onChange={(e) => setReminderDayBeforeTime(e.target.value)}
                    disabled={!reminderDayBeforeEnabled}
                    className="w-28 rounded-lg border border-border bg-white px-3 py-2 text-sm disabled:opacity-50"
                  />
                  <span className="text-xs text-muted">KST · 기본 18:00</span>
                </div>
              </div>
              <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
                <label className="flex items-center gap-2 text-sm font-medium">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-primary"
                    checked={reminderDayOfEnabled}
                    onChange={(e) => setReminderDayOfEnabled(e.target.checked)}
                  />
                  실험 당일 알림
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="time"
                    value={reminderDayOfTime}
                    onChange={(e) => setReminderDayOfTime(e.target.value)}
                    disabled={!reminderDayOfEnabled}
                    className="w-28 rounded-lg border border-border bg-white px-3 py-2 text-sm disabled:opacity-50"
                  />
                  <span className="text-xs text-muted">KST · 기본 09:00 (슬롯 시작 전에만 발송)</span>
                </div>
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
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              const changed =
                (experiment?.title ?? "") !== title ||
                (experiment?.description ?? "") !== description ||
                (experiment?.start_date ?? "") !== startDate ||
                (experiment?.end_date ?? "") !== endDate;
              if (changed && !window.confirm("변경 사항이 저장되지 않았습니다. 취소하시겠습니까?")) return;
              onCancel();
            }}
          >
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
