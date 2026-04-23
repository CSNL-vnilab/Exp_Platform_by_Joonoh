"use client";

// Sticky sidebar/summary that reads an Experiment-shaped draft and shows
// which fields are filled vs missing, grouped by requirement level.
// Lives outside experiment-form.tsx so the form doesn't bloat further,
// and so other streams' additions don't collide with this checklist
// logic.
//
// Three sources of truth must stay in sync:
//   1. docs/experiment-field-requirements.md   (authoritative doc)
//   2. src/lib/utils/validation.ts             (server-enforced schema)
//   3. this file                               (UI affordance)
//
// When adding a numeric field with `.min(N)` to (2), the classify()
// entry MUST include `{ minNumber: N }` in its hasValue() call or the
// sidebar will green-tick a value that submit rejects (D5-2 bug
// shape). Grep for `minNumber:` in this file as the canonical list.

import type { Experiment, ExperimentMode } from "@/types/database";

// Accepts a partial draft (form-in-progress) rather than a full Experiment,
// because the researcher may be creating a new one and many fields are
// still empty.
type Draft = Partial<Experiment> & {
  experiment_mode?: ExperimentMode;
};

interface FieldStatus {
  name: string;
  level: "required" | "required_for_activation" | "recommended" | "optional";
  filled: boolean;
  hint?: string;
}

function hasValue(v: unknown, opts: { minNumber?: number } = {}): boolean {
  if (v == null) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "number") {
    // D5-2 fix — 0 is NOT "filled" for fields that have a min. The
    // `session_duration_minutes` schema is z.number().min(10); a zero
    // value would fail submit but previously rendered a green tick.
    if (typeof opts.minNumber === "number") return v >= opts.minNumber;
    return Number.isFinite(v);
  }
  if (typeof v === "boolean") return true;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return Boolean(v);
}

function classify(draft: Draft): FieldStatus[] {
  const isOnline =
    draft.experiment_mode === "online" || draft.experiment_mode === "hybrid";

  const out: FieldStatus[] = [
    { name: "실험 제목", level: "required", filled: hasValue(draft.title) },
    {
      name: "시작·종료 날짜",
      level: "required",
      filled: hasValue(draft.start_date) && hasValue(draft.end_date),
    },
    {
      name: "일일 운영 시간",
      level: "required",
      filled:
        hasValue(draft.daily_start_time) && hasValue(draft.daily_end_time),
    },
    {
      name: "세션 시간",
      level: "required",
      filled: hasValue(draft.session_duration_minutes, { minNumber: 10 }),
      hint: "최소 10분",
    },
    {
      name: "운영 요일",
      level: "required",
      filled: Array.isArray(draft.weekdays) && draft.weekdays.length > 0,
    },
    {
      name: "분석 코드 저장소",
      level: "required_for_activation",
      filled: hasValue(draft.code_repo_url),
      hint: "GitHub URL 또는 서버 절대 경로",
    },
    {
      name: "원본 데이터 경로",
      level: "required_for_activation",
      filled: hasValue(draft.data_path),
    },
    {
      name: "실험 설명",
      level: "recommended",
      filled: hasValue(draft.description),
      hint: "참여자 예약 페이지에 공개됩니다",
    },
    {
      name: "프로젝트 약칭",
      level: "recommended",
      filled: hasValue(draft.project_name),
      hint: "캘린더 이벤트 제목에 사용",
    },
    {
      name: "실험 장소",
      level: "recommended",
      filled: isOnline ? true : hasValue(draft.location_id),
      hint: isOnline ? "온라인 실험은 생략 가능" : "주소·지도 링크 출처",
    },
    {
      name: "Google Calendar",
      level: "recommended",
      filled: hasValue(draft.google_calendar_id),
      hint: "미설정 시 연구팀 달력에 일정이 뜨지 않음",
    },
    {
      name: "IRB 승인 문서",
      level: "recommended",
      filled: hasValue(draft.irb_document_url),
    },
    {
      name: "참여 확인사항 (precautions)",
      level: "recommended",
      filled:
        Array.isArray(draft.precautions) && draft.precautions.length > 0,
      hint: "참여자 안전 질문",
    },
    {
      name: "사전 체크리스트 구성",
      level: "recommended",
      filled:
        Array.isArray(draft.pre_experiment_checklist) &&
        draft.pre_experiment_checklist.length > 0,
      hint: "항목을 한 개 이상 추가해 두면 권장 충족",
    },
    {
      // D5-5 — distinguish "configured" from "all required ticked".
      // The booking gate is about the latter, not the former.
      name: "체크리스트 필수 항목 완료",
      level: "required_for_activation",
      filled:
        !Array.isArray(draft.pre_experiment_checklist) ||
        draft.pre_experiment_checklist.every(
          (c) => !c.required || c.checked,
        ),
      hint: "미완료된 필수 항목이 있으면 공개 예약이 차단됩니다",
    },
    {
      name: "파라미터 스키마",
      level: "recommended",
      filled:
        Array.isArray(draft.parameter_schema) &&
        draft.parameter_schema.length > 0,
    },
    {
      // migration 00042. Free-form string copied to Notion SLab row's
      // 버전넘버 at booking-creation time.
      name: "프로토콜 버전",
      level: "recommended",
      filled: hasValue(draft.protocol_version),
      hint: "예: v1.0 — Notion 버전넘버 컬럼에 복사됨",
    },
    {
      // migration 00043. Optional link from experiment to the Notion
      // Projects & Chores page — drives 프로젝트 (관련) Relation.
      name: "Notion 프로젝트 연결",
      level: "recommended",
      filled: hasValue(draft.notion_project_page_id),
      hint: "실험 상세의 Notion 입력에서 URL / hex 붙여넣기",
    },
  ];

  if (isOnline) {
    out.push(
      {
        // D5-4 — schema superRefine rejects save without entry_url for
        // online/hybrid mode, so it's required at submit time not just
        // at activation. Level accordingly.
        name: "온라인 entry_url",
        level: "required",
        filled: hasValue(draft.online_runtime_config?.entry_url),
      },
      {
        name: "SRI 해시",
        level: "recommended",
        filled: hasValue(draft.online_runtime_config?.entry_url_sri),
        hint: "CDN payload 무결성 보장",
      },
    );
  }

  return out;
}

const LEVEL_META = {
  required: { label: "필수", color: "text-rose-700", bg: "bg-rose-50" },
  required_for_activation: {
    label: "활성화 전 필수",
    color: "text-amber-800",
    bg: "bg-amber-50",
  },
  recommended: { label: "권장", color: "text-sky-800", bg: "bg-sky-50" },
  optional: { label: "선택", color: "text-muted", bg: "bg-card" },
} as const;

export function ExperimentFormCompleteness({
  draft,
  className = "",
}: {
  draft: Draft;
  className?: string;
}) {
  const statuses = classify(draft);

  const groups = (["required", "required_for_activation", "recommended"] as const).map(
    (level) => ({
      level,
      items: statuses.filter((s) => s.level === level),
    }),
  );

  const totals = groups.map((g) => ({
    level: g.level,
    total: g.items.length,
    filled: g.items.filter((i) => i.filled).length,
  }));

  return (
    <aside
      className={`rounded-lg border border-border bg-white p-4 text-sm ${className}`}
      aria-label="실험 입력 완성도"
    >
      <h3 className="mb-3 text-sm font-semibold text-foreground">
        입력 완성도
      </h3>
      <div className="mb-3 grid grid-cols-3 gap-2 text-center">
        {totals.map((t) => {
          const meta = LEVEL_META[t.level];
          return (
            <div
              key={t.level}
              className={`rounded-md border border-border px-2 py-1 ${meta.bg}`}
            >
              <div className={`text-[11px] font-medium ${meta.color}`}>
                {meta.label}
              </div>
              <div className="text-sm font-bold text-foreground">
                {t.filled} / {t.total}
              </div>
            </div>
          );
        })}
      </div>
      <div className="space-y-3">
        {groups.map((g) => {
          if (g.items.length === 0) return null;
          const meta = LEVEL_META[g.level];
          return (
            <div key={g.level}>
              <h4 className={`mb-1 text-xs font-semibold ${meta.color}`}>
                {meta.label}
              </h4>
              <ul className="space-y-1">
                {g.items.map((i) => (
                  <li key={i.name} className="flex items-start gap-2 text-xs">
                    <span
                      aria-hidden="true"
                      className={`mt-0.5 inline-block h-2.5 w-2.5 flex-shrink-0 rounded-full ${
                        i.filled ? "bg-emerald-500" : "bg-border"
                      }`}
                    />
                    <div className="flex-1">
                      <div
                        className={
                          i.filled ? "text-foreground" : "text-muted"
                        }
                      >
                        {i.name}
                      </div>
                      {i.hint && !i.filled && (
                        <div className="text-[11px] text-muted">{i.hint}</div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-[11px] text-muted">
        분류 기준: <code className="rounded bg-card px-1">docs/experiment-field-requirements.md</code>
      </p>
    </aside>
  );
}
