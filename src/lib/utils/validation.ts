import { z } from "zod/v4";
import { CATEGORY_VALUES } from "@/lib/experiments/categories";

// Korean phone number: 010-XXXX-XXXX or 01XXXXXXXXX
const phoneRegex = /^01[0-9]-?\d{3,4}-?\d{4}$/;
const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
const isoDatetimeRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUUID(value: string): boolean {
  return uuidRegex.test(value);
}

export const participantSchema = z.object({
  name: z.string().min(1, "이름을 입력해주세요").max(100),
  phone: z.string().regex(phoneRegex, "올바른 전화번호를 입력해주세요 (예: 010-1234-5678)"),
  email: z.email("올바른 이메일을 입력해주세요"),
  gender: z.enum(["male", "female", "other"]),
  birthdate: z.string().regex(dateRegex, "올바른 생년월일 형식을 입력해주세요 (YYYY-MM-DD)"),
});

export const experimentSchema = z.object({
  title: z.string().min(1, "실험 제목을 입력해주세요"),
  description: z.string().optional(),
  start_date: z.string().min(1, "시작 날짜를 선택해주세요"),
  end_date: z.string().min(1, "종료 날짜를 선택해주세요"),
  session_duration_minutes: z.number().min(10, "최소 10분 이상이어야 합니다"),
  max_participants_per_slot: z.number().min(1).default(1),
  participation_fee: z.number().min(0).default(0),
  session_type: z.enum(["single", "multi"]).default("single"),
  required_sessions: z.number().min(1).default(1),
  daily_start_time: z.string().min(1, "시작 시간을 선택해주세요"),
  daily_end_time: z.string().min(1, "종료 시간을 선택해주세요"),
  break_between_slots_minutes: z.number().min(0).default(0),
  google_calendar_id: z.string().optional(),
  irb_document_url: z.string().url().optional().or(z.literal("")),
  precautions: z.array(
    z.object({
      question: z.string().min(1),
      required_answer: z.boolean(),
    })
  ).default([]),
  categories: z
    .array(z.enum(CATEGORY_VALUES as [string, ...string[]]))
    .default([]),
  location_id: z.string().uuid().nullable().optional(),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).default([0, 1, 2, 3, 4, 5, 6]),
  registration_deadline: z.string().datetime().nullable().optional(),
  auto_lock: z.boolean().default(true),
  subject_start_number: z.number().int().min(1).default(1),
  project_name: z.string().max(100).nullable().optional(),
  // HH:mm (reminder config). Optional inputs — defaults land via DB NOT NULL DEFAULT.
  reminder_day_before_enabled: z.boolean().default(true),
  reminder_day_before_time: z.string().regex(/^\d{2}:\d{2}$/).default("18:00"),
  reminder_day_of_enabled: z.boolean().default(true),
  reminder_day_of_time: z.string().regex(/^\d{2}:\d{2}$/).default("09:00"),
  // Research metadata (migration 00022). Required to transition status → active.
  code_repo_url: z
    .string()
    .max(1000)
    .refine(
      (v) => !v || /^https?:\/\//i.test(v.trim()) || /^[\/~]/.test(v.trim()),
      "GitHub URL (https://…) 또는 서버 절대 경로(/… 혹은 ~…)를 입력해주세요",
    )
    .nullable()
    .optional(),
  data_path: z
    .string()
    .max(1000)
    .refine(
      (v) => !v || /^https?:\/\//i.test(v.trim()) || /^[\/~]/.test(v.trim()),
      "서버 절대 경로 또는 URL을 입력해주세요",
    )
    .nullable()
    .optional(),
  parameter_schema: z
    .array(
      z
        .object({
          key: z
            .string()
            .min(1, "파라미터 키를 입력해주세요")
            .max(64)
            .regex(
              /^[A-Za-z_][A-Za-z0-9_]*$/,
              "파라미터 키는 영문/숫자/언더스코어만 허용합니다 (예: stim_contrast)",
            ),
          type: z.enum(["number", "string", "enum"]),
          default: z.union([z.string(), z.number(), z.null()]).optional(),
          options: z.array(z.string().min(1).max(120)).max(50).optional(),
        })
        .superRefine((v, ctx) => {
          if (v.type === "enum") {
            if (!v.options || v.options.length === 0) {
              ctx.addIssue({
                code: "custom",
                path: ["options"],
                message: "enum 타입은 최소 1개의 옵션이 필요합니다",
              });
            } else if (new Set(v.options).size !== v.options.length) {
              ctx.addIssue({
                code: "custom",
                path: ["options"],
                message: "옵션이 중복됩니다",
              });
            }
          }
          if (v.type === "number" && typeof v.default === "string" && v.default !== "") {
            ctx.addIssue({
              code: "custom",
              path: ["default"],
              message: "number 타입의 기본값은 숫자여야 합니다",
            });
          }
        }),
    )
    .max(50, "파라미터는 최대 50개까지 등록할 수 있습니다")
    .default([])
    .refine(
      (arr) => new Set(arr.map((p) => p.key)).size === arr.length,
      "파라미터 키가 중복됩니다",
    ),
  pre_experiment_checklist: z
    .array(
      z.object({
        item: z
          .string()
          .trim()
          .min(1, "체크리스트 항목 내용을 입력해주세요")
          .max(500),
        required: z.boolean(),
        checked: z.boolean().optional(),
        checked_at: z.string().nullable().optional(),
      }),
    )
    .max(50, "체크리스트는 최대 50개까지 등록할 수 있습니다")
    .default([]),
  // Online runtime (migration 00023). Offline keeps online_runtime_config
  // null; online/hybrid require entry_url. Other fields are optional hints
  // the /run shell uses to render progress/ETA.
  experiment_mode: z.enum(["offline", "online", "hybrid"]).default("offline"),
  online_runtime_config: z
    .object({
      entry_url: z.string().url("유효한 URL이어야 합니다"),
      trial_count: z.number().int().positive().optional(),
      block_count: z.number().int().positive().max(999).optional(),
      estimated_minutes: z.number().int().positive().max(600).optional(),
      completion_token_format: z
        .union([z.literal("uuid"), z.string().regex(/^alphanumeric:\d+$/)])
        .optional(),
    })
    .nullable()
    .optional(),
  data_consent_required: z.boolean().default(false),
}).refine(
  (v) => v.experiment_mode === "offline" || !!v.online_runtime_config?.entry_url,
  {
    message: "온라인/하이브리드 실험은 entry_url이 필요합니다",
    path: ["online_runtime_config", "entry_url"],
  },
);

export const bookingRequestSchema = z.object({
  experiment_id: z.string().uuid(),
  participant: participantSchema,
  slots: z
    .array(
      z.object({
        slot_start: z.string().regex(isoDatetimeRegex, "올바른 ISO 날짜 형식이 아닙니다"),
        slot_end: z.string().regex(isoDatetimeRegex, "올바른 ISO 날짜 형식이 아닙니다"),
        session_number: z.number().optional(),
      })
    )
    .min(1, "최소 1개의 시간대를 선택해주세요"),
});

// Per-booking researcher observation payload (see migration 00026).
// Used by PUT /api/bookings/[bookingId]/observation. The UI enforces a
// single "survey done → info required" rule: if the checkbox is ticked we
// require free-text describing what the participant actually answered, so
// the Notion row lands with either 0 or 2 populated survey fields, never
// 1 (done=true, info=blank).
export const observationSchema = z
  .object({
    pre_survey_done: z.boolean(),
    pre_survey_info: z.string().max(5000).nullable().optional(),
    post_survey_done: z.boolean(),
    post_survey_info: z.string().max(5000).nullable().optional(),
    notable_observations: z.string().max(5000).nullable().optional(),
  })
  .superRefine((v, ctx) => {
    if (
      v.pre_survey_done &&
      (!v.pre_survey_info || v.pre_survey_info.trim().length === 0)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["pre_survey_info"],
        message: "Pre-survey가 완료되었다면 받은 정보를 기록해 주세요",
      });
    }
    if (
      v.post_survey_done &&
      (!v.post_survey_info || v.post_survey_info.trim().length === 0)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["post_survey_info"],
        message: "Post-survey가 완료되었다면 받은 정보를 기록해 주세요",
      });
    }
  });

// Normalize phone number: remove dashes
export function normalizePhone(phone: string): string {
  return phone.replace(/-/g, "");
}

// HTML-escape user content before embedding in email templates
const htmlEscapeMap: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#x27;",
};

export function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, (ch) => htmlEscapeMap[ch]);
}

// Normalize a timestamp string to ISO format for consistent key matching
export function normalizeToISO(ts: string): string {
  return new Date(ts).toISOString();
}

// ---------------------------------------------------------------------------
// Participant class assignment (manual override by researcher/admin).
// The API route additionally enforces role-based permissions:
//   * blacklist/vip → admin only
//   * royal uplift  → researcher allowed (manual correction of auto class)
// ---------------------------------------------------------------------------
export const classAssignmentSchema = z
  .object({
    class: z.enum(["newbie", "royal", "blacklist", "vip"]),
    reason: z.string().max(500).optional(),
    valid_until: z.string().datetime().nullable().optional(),
  })
  .superRefine((v, ctx) => {
    if (
      v.class === "blacklist" &&
      (!v.reason || v.reason.trim().length < 5)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message: "블랙리스트 지정에는 최소 5자 이상의 사유가 필요합니다",
      });
    }
  });
