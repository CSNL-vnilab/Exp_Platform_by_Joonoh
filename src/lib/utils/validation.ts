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

// Base object schema — kept refine-free at the OBJECT level so a partial
// version (for PUT) can be derived via .partial() without the zod-v4
// "cannot be used on object schemas containing refinements" error.
// Field-level .refine() chains inside individual properties are fine —
// only object-level refinements block .partial().
//
// IMPORTANT trap (2026-06-08): zod v4's .partial() does NOT remove
// .default() — `experimentObjectSchema.partial().parse({ is_project: false })`
// returns { is_project: false, participation_fee: 0, weekdays: [0..6],
// session_type: "single", reminder_day_of_time: "07:00", … }, materialising
// every default. PUT routes MUST intersect the parsed output with
// request-body keys before UPDATE, otherwise a partial patch clobbers
// the row's configured values. See src/app/api/experiments/[experimentId]/route.ts
// for the canonical filter.
const experimentObjectSchema = z.object({
  title: z.string().min(1, "실험 제목을 입력해주세요"),
  description: z.string().optional(),
  start_date: z.string().min(1, "시작 날짜를 선택해주세요"),
  end_date: z.string().min(1, "종료 날짜를 선택해주세요"),
  session_duration_minutes: z.number().min(10, "최소 10분 이상이어야 합니다"),
  max_participants_per_slot: z.number().min(1).default(1),
  // Researcher-set recruitment quota. NULL/undefined = unlimited.
  // When set, book_slot auto-closes the experiment on reaching the
  // count (migration 00062).
  recruitment_target: z
    .number()
    .int()
    .min(1, "1 이상이어야 합니다")
    .nullable()
    .optional(),
  participation_fee: z.number().min(0).default(0),
  // Migration 00063: when false, the payment-info request email is
  // not auto-dispatched on completion; the researcher triggers it
  // manually from payment-panel after reviewing/adjusting amount_krw.
  payment_link_auto_send: z.boolean().default(true),
  // Migration 00063: false = pilot / 장비 테스트 / one-off — opted out
  // of the project surfaces (metadata-fill list, /experiments admin
  // list, dashboard, metadata-reminder cron, backfill re-import).
  // Toggled from /metadata-fill "프로젝트 아님 (면제)" button via the
  // generic PUT. Must appear in this schema or zod strips the key
  // (initial 2026-06-05 fix); paired with the partial-defaults filter
  // in /api/experiments/[id] (2026-06-08 fix).
  is_project: z.boolean().optional(),
  session_type: z.enum(["single", "multi"]).default("single"),
  required_sessions: z.number().min(1).default(1),
  daily_start_time: z.string().min(1, "시작 시간을 선택해주세요"),
  daily_end_time: z.string().min(1, "종료 시간을 선택해주세요"),
  break_between_slots_minutes: z.number().min(0).default(0),
  // Grid step between slot START times (min). null/omitted = session+break
  // (legacy). Smaller than the session → overlapping slots; book_slot's
  // overlap-conflict check (00069) keeps them from double-booking.
  slot_increment_minutes: z.number().int().min(5).nullable().optional(),
  google_calendar_id: z.string().optional(),
  // Scheme allowlist — value flows to <a href={...}> in booking-flow /
  // precaution-check / run-shell / demo. Without the http(s) refine,
  // a researcher could paste `javascript:` / `data:` and ship live XSS
  // on every participant-facing surface that renders the link.
  irb_document_url: z
    .string()
    .url()
    .refine(
      (v) => /^https?:\/\//i.test(v.trim()),
      "http:// 또는 https:// URL만 허용합니다",
    )
    .optional()
    .or(z.literal("")),
  precautions: z.array(
    z.object({
      question: z.string().min(1),
      required_answer: z.boolean(),
    })
  ).default([]),
  categories: z
    .array(z.enum(CATEGORY_VALUES as [string, ...string[]]))
    .default([]),
  // zod v4 .uuid() enforces strict RFC 4122 v1-v8 — rejects fixture
  // UUIDs like aaaaaaaa-aaaa-aaaa-aaaa-000000000001 (the seeded
  // experiment_locations rows). The DB column is Postgres UUID so
  // anything that fails the loose 8-4-4-4-12 hex regex below also
  // fails INSERT — safe to relax here.
  location_id: z.string().regex(uuidRegex, "올바른 장소 ID 형식이 아닙니다").nullable().optional(),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).default([0, 1, 2, 3, 4, 5, 6]),
  registration_deadline: z.string().datetime().nullable().optional(),
  auto_lock: z.boolean().default(true),
  subject_start_number: z.number().int().min(1).default(1),
  project_name: z.string().max(100).nullable().optional(),
  // 프로토콜 버전 — 자유 형식 (예: "v1.0", "2026-03-rev2"). 64자 이내.
  // 실험 단위로 저장되며 그 이후의 예약마다 Notion 버전넘버 컬럼에 복사됨.
  protocol_version: z.string().max(64).nullable().optional(),
  // Notion page id in Projects & Chores DB (migration 00043). Accepts
  // the same forms as the /api/users PATCH helper (bare hex / dashed /
  // URL); the API layer runs parseNotionPageId before handing off.
  // Here we just validate the final stored form: dashed UUID or null.
  notion_project_page_id: z.string().max(64).nullable().optional(),
  // HH:mm (reminder config). Optional inputs — defaults land via DB NOT NULL DEFAULT.
  reminder_day_before_enabled: z.boolean().default(true),
  reminder_day_before_time: z.string().regex(/^\d{2}:\d{2}$/).default("18:00"),
  reminder_day_of_enabled: z.boolean().default(true),
  // Day-of default is 07:00 (not 09:00) to compensate for GitHub Actions
  // free-tier cron jitter — see migration 00067 for context. UI / DB
  // defaults track this value.
  reminder_day_of_time: z.string().regex(/^\d{2}:\d{2}$/).default("07:00"),
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
  // Mirror of OnlineRuntimeConfig (src/types/database.ts). The 5 trailing
  // keys (entry_url_sri / preflight / counterbalance_spec / attention_checks /
  // exclude_experiment_ids) were authored by experiment-form's buildOnlineConfig
  // but ABSENT from this zod object → a plain z.object() silently stripped them
  // on every INSERT/UPDATE, so counterbalancing + attention filters never
  // persisted (blueprint #1). Widened to validate-not-strip.
  //
  // zod/v4 .partial() trap (experimentEditSchema = …partial()): .partial()
  // only loosens TOP-LEVEL keys; the nested shape of online_runtime_config is
  // re-validated whole whenever a PATCH includes the key. So NO nested
  // .default() here — a default would materialise on partial patches and
  // clobber sibling keys the researcher didn't send. Every new field is plain
  // .optional() (or .nullable().optional()), value-preserving on round-trip.
  online_runtime_config: z
    .object({
      // Must be HTTP(S). `z.string().url()` alone allows javascript:,
      // data:, blob: — a compromised researcher account could otherwise
      // inject arbitrary script into the /run shim.
      entry_url: z
        .string()
        .url("유효한 URL이어야 합니다")
        .refine(
          (v) => /^https?:\/\//i.test(v.trim()),
          "http:// 또는 https:// URL만 허용합니다",
        ),
      // Subresource Integrity hash. ADVISORY per researcher directive — we only
      // validate the FORMAT (sha256/384/512-<base64>), never require it and
      // never gate activation on it. Form sends the trimmed string, or `null`
      // when the field is cleared, so accept both.
      entry_url_sri: z
        .string()
        .regex(
          /^sha(256|384|512)-[A-Za-z0-9+/]+={0,2}$/,
          "SRI는 sha256-/sha384-/sha512- 접두어와 base64 다이제스트 형식이어야 합니다",
        )
        .nullable()
        .optional(),
      trial_count: z.number().int().positive().optional(),
      block_count: z.number().int().positive().max(999).optional(),
      estimated_minutes: z.number().int().positive().max(600).optional(),
      completion_token_format: z
        .union([
          z.literal("uuid"),
          z
            .string()
            .regex(/^alphanumeric:\d+$/)
            .refine(
              (s) => parseInt(s.split(":")[1], 10) >= 6,
              "alphanumeric 코드는 최소 6자리 이상이어야 합니다",
            ),
        ])
        .optional(),
      // Pre-run environment check. All fields optional — the form only emits a
      // preflight object when at least one is set, and an empty {} is harmless.
      preflight: z
        .object({
          min_width: z.number().int().positive().max(10000).optional(),
          min_height: z.number().int().positive().max(10000).optional(),
          require_keyboard: z.boolean().optional(),
          require_audio: z.boolean().optional(),
          instructions: z.string().max(2000).optional(),
        })
        .optional(),
      // Condition-assignment spec. Discriminated on `kind`; each variant carries
      // a non-empty, non-blank conditions[]. block_rotation adds block_size,
      // random adds a stable seed — both optional hints.
      counterbalance_spec: z
        .discriminatedUnion("kind", [
          z.object({
            kind: z.literal("latin_square"),
            conditions: z
              .array(z.string().trim().min(1).max(200))
              .min(1, "최소 1개의 조건이 필요합니다")
              .max(50),
          }),
          z.object({
            kind: z.literal("block_rotation"),
            conditions: z
              .array(z.string().trim().min(1).max(200))
              .min(1, "최소 1개의 조건이 필요합니다")
              .max(50),
            block_size: z.number().int().positive().max(999).optional(),
          }),
          z.object({
            kind: z.literal("random"),
            conditions: z
              .array(z.string().trim().min(1).max(200))
              .min(1, "최소 1개의 조건이 필요합니다")
              .max(50),
            seed: z.string().max(200).optional(),
          }),
        ])
        .optional(),
      // Attention checks injected between blocks. `position` is
      // 'after_block:N' (0-indexed) or 'random'. single_choice must carry the
      // options it presents AND its correct_answer must be one of them — a
      // malformed check (answer not in options) is unscorable and would
      // silently pass/fail everyone, so reject it at author time.
      attention_checks: z
        .array(
          z
            .object({
              question: z.string().trim().min(1, "질문을 입력해주세요").max(1000),
              kind: z.enum(["yes_no", "single_choice"]),
              options: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
              correct_answer: z.string().trim().min(1, "정답을 입력해주세요").max(500),
              // Narrow to the exact OnlineRuntimeConfig union
              // (`after_block:${number}` | "random") rather than plain
              // `string`, so the parsed value is assignable to the persisted
              // JSONB type at the INSERT/UPDATE call sites.
              position: z.custom<`after_block:${number}` | "random">(
                (v) => typeof v === "string" && /^(after_block:\d+|random)$/.test(v),
                "위치는 'after_block:N' 또는 'random' 이어야 합니다",
              ),
            })
            .superRefine((v, ctx) => {
              if (v.kind === "single_choice") {
                if (!v.options || v.options.length < 2) {
                  ctx.addIssue({
                    code: "custom",
                    path: ["options"],
                    message: "단일 선택 주의검사는 최소 2개의 선택지가 필요합니다",
                  });
                  return;
                }
                if (new Set(v.options).size !== v.options.length) {
                  ctx.addIssue({
                    code: "custom",
                    path: ["options"],
                    message: "선택지가 중복됩니다",
                  });
                }
                if (!v.options.includes(v.correct_answer)) {
                  ctx.addIssue({
                    code: "custom",
                    path: ["correct_answer"],
                    message: "정답은 선택지 중 하나여야 합니다",
                  });
                }
              } else {
                // yes_no — correct_answer must be a yes/no token.
                const ans = v.correct_answer.trim().toLowerCase();
                if (!["yes", "no", "예", "아니오", "true", "false"].includes(ans)) {
                  ctx.addIssue({
                    code: "custom",
                    path: ["correct_answer"],
                    message: "예/아니오 주의검사의 정답은 yes/no(예/아니오)여야 합니다",
                  });
                }
              }
            }),
        )
        .max(50, "주의검사는 최대 50개까지 등록할 수 있습니다")
        .optional(),
      // Cross-study exclusion list — experiment UUIDs. Loose 8-4-4-4-12 hex to
      // match isValidUUID (the DB column is Postgres UUID, so anything that
      // passes here also passes INSERT). The form already filters non-UUIDs
      // before sending; this is the server-side guarantee.
      exclude_experiment_ids: z
        .array(z.string().regex(uuidRegex, "올바른 실험 ID 형식이 아닙니다"))
        .max(200)
        .optional(),
    })
    .nullable()
    .optional(),
  data_consent_required: z.boolean().default(false),
});

// Full create-path schema — base object + the cross-field refine.
// Used by the form (full validation before POST).
export const experimentSchema = experimentObjectSchema.refine(
  (v) => v.experiment_mode === "offline" || !!v.online_runtime_config?.entry_url,
  {
    message: "온라인/하이브리드 실험은 entry_url이 필요합니다",
    path: ["online_runtime_config", "entry_url"],
  },
);

// Edit-path partial schema — used by PUT /api/experiments/[id]. zod v4
// disallows .partial() on schemas with object-level refinements, so we
// derive partial from the unrefined base. The cross-field check is
// re-applied manually in the route when both fields are present in the
// patch (see /api/experiments/[experimentId]/route.ts).
export const experimentEditSchema = experimentObjectSchema.partial();

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

// Normalize a phone number to a canonical comparable form.
//
// Used both when STORING a participant's phone at booking time and when
// COMPARING typed input against the stored value (booking-edit identity
// gate, payment-info submit). Both sides must run through the same rules
// or an honest participant gets a false "본인 확인 실패".
//
//  - Strip every non-digit (dashes, spaces, dots, parentheses, the "+").
//  - Fold the Korean country code to the domestic trunk form:
//    "+82 10-1234-5678" → "821012345678" → "01012345678", which is what
//    participants normally type. No domestic Korean number begins with the
//    digits "82" after stripping (they all start with a "0" trunk), so this
//    only ever rewrites a leading country code.
//
// NOTE: participants/identity.ts intentionally keeps its OWN normalizer for
// roster de-duplication; this function is not on that path.
export function normalizePhone(phone: string): string {
  let digits = phone.replace(/\D/g, "");
  if (digits.startsWith("82")) {
    digits = "0" + digits.slice(2);
  }
  return digits;
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
