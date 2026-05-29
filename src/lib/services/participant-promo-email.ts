// Participant recruitment ("홍보") email — editable template model.
//
// Send model (user spec 2026-05-19): ONE email, To: the lab's own
// sending account (self), BCC: every selected participant's address.
// Solapi/SMS is out of scope for now — email only.
//
// The admin edits a plain-text subject + body (seeded from a per-
// experiment template), previews the rendered HTML, then sends. The
// body is authored as plain text so a non-technical operator can fully
// rewrite it; `renderPromoHtml` is the single source of truth that
// turns that text into the branded HTML for BOTH preview and send.

import { wrapEmailHtml } from "@/lib/services/email-shell";
import { escapeHtml } from "@/lib/utils/validation";
import { formatDateKR } from "@/lib/utils/date";
import {
  BRAND_FULL_NAME,
  BRAND_NAME,
  brandContactEmailOrNull,
} from "@/lib/branding";
import { getAppOrigin } from "@/lib/http/origin";

export interface PromoExperimentInput {
  id: string;
  title: string;
  project_name: string | null;
  start_date: string;
  end_date: string;
  daily_start_time: string | null;
  daily_end_time: string | null;
  weekdays: number[] | null;
  session_duration_minutes: number;
  session_type: "single" | "multi";
  required_sessions: number;
  participation_fee: number;
  description?: string | null;
  experiment_mode?: "offline" | "online" | "hybrid" | null;
  // Resolved experiment_locations.name (joined by the route). Surfaced
  // as "· 장소: …" when present.
  location_name?: string | null;
}

const WEEKDAY_LABELS_KO = ["일", "월", "화", "수", "목", "금", "토"];

function appBase(): string {
  return getAppOrigin() || "https://lab-reservation-seven.vercel.app";
}

function formatWeekdays(weekdays: number[] | null | undefined): string {
  if (!weekdays || weekdays.length === 0) return "-";
  const all = [0, 1, 2, 3, 4, 5, 6];
  if (weekdays.length === 7 && all.every((w) => weekdays.includes(w))) return "매일";
  return [...weekdays]
    .sort((a, b) => a - b)
    .map((w) => WEEKDAY_LABELS_KO[w])
    .join(" · ");
}

export function bookingUrlFor(experimentId: string): string {
  return `${appBase()}/book/${experimentId}`;
}

/**
 * Default editable template for an experiment. The operator can rewrite
 * any of it before sending; this is just the seed.
 */
export function buildPromoTemplate(experiment: PromoExperimentInput): {
  subject: string;
  body: string;
} {
  const sessionLine =
    experiment.session_type === "multi"
      ? `${experiment.session_duration_minutes}분 × ${experiment.required_sessions}회차`
      : `${experiment.session_duration_minutes}분 단일 세션`;
  const feeLine =
    experiment.participation_fee > 0
      ? `${experiment.participation_fee.toLocaleString("ko-KR")}원`
      : "무료";
  // Strip seconds off "HH:MM:SS" times — recruitment emails read better
  // as "13:00 ~ 18:00" than "13:00:00 ~ 18:00:00".
  const hhmm = (t: string | null | undefined) =>
    t ? t.slice(0, 5) : "";
  const timeLine =
    experiment.daily_start_time && experiment.daily_end_time
      ? `${hhmm(experiment.daily_start_time)} ~ ${hhmm(experiment.daily_end_time)}`
      : "-";

  // User-pasted template (2026-05-20): no project line, no mode tag on
  // the session, no description block, no opt-out footer; long lab
  // name in the intro and short BRAND_NAME in the sign-off.
  const lines = [
    "안녕하세요, ",
    "",
    `${BRAND_FULL_NAME}에서 「${experiment.title}」 실험 참여자를 모집합니다.`,
    "아래 내용을 확인하시고 관심이 있으시면 예약 페이지에서 편하신 시간을 선택해 주세요.",
    "",
    `· 모집 기간: ${formatDateKR(experiment.start_date)} ~ ${formatDateKR(experiment.end_date)}`,
    `· 운영 요일: ${formatWeekdays(experiment.weekdays)}`,
    `· 운영 시간: ${timeLine}`,
    `· 세션: ${sessionLine}`,
    `· 참여비: ${feeLine}`,
  ];
  const loc = experiment.location_name?.trim();
  if (loc) lines.push(`· 장소: ${loc}`);
  lines.push(
    "",
    "▶ 예약 페이지:",
    bookingUrlFor(experiment.id),
    "",
    "감사합니다",
    `${BRAND_NAME} 드림`,
  );

  return {
    subject: `[${BRAND_NAME}] ${experiment.title} 실험 참여자 모집 안내`,
    body: lines.join("\n"),
  };
}

const URL_RE = /(https?:\/\/[^\s<]+)/g;

/**
 * Render the operator's edited plain-text body to branded HTML. Used by
 * BOTH the preview endpoint and the send path so what they see is what
 * goes out. Escapes everything, linkifies bare URLs, keeps line breaks.
 */
export function renderPromoHtml(bodyText: string): string {
  const safe = escapeHtml(bodyText ?? "");
  const linked = safe.replace(
    URL_RE,
    (u) =>
      `<a href="${u}" style="color:#2563eb;word-break:break-all;">${u}</a>`,
  );
  const html = linked.replace(/\r?\n/g, "<br>");
  const contact = brandContactEmailOrNull();
  const footer = contact
    ? `<p style="margin:18px 0 0 0;font-size:12px;color:#9ca3af;">${escapeHtml(
        BRAND_NAME,
      )} — 문의: <a href="mailto:${contact}" style="color:#2563eb;">${contact}</a></p>`
    : `<p style="margin:18px 0 0 0;font-size:12px;color:#9ca3af;">${escapeHtml(
        BRAND_NAME,
      )}</p>`;
  const inner = `
    <div style="font-family:-apple-system,'Segoe UI','Apple SD Gothic Neo','Malgun Gothic',sans-serif;max-width:620px;margin:0 auto;padding:16px;color:#111827;line-height:1.7;font-size:14px;">
      <div>${html}</div>
      ${footer}
    </div>`;
  return wrapEmailHtml(inner, { title: "참여자 모집 안내" });
}
