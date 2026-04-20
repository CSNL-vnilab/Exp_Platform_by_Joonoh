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
});

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
