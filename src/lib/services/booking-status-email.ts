// Builders for cancelled / no_show participant notifications.
//
// Pure functions — no DB, no SMTP. Caller (booking-status-notify.service)
// loads the booking row + researcher profile + (optional) location and
// passes them in.
//
// Tone:
//   - cancelled: 사과 톤. 다른 일정 있으면 booking page 링크 노출.
//   - no_show:  사실 통보. "기록되었습니다", "다시 참여 가능 여부는 담당자
//               에게 문의" 정도. 비난 X.

import { formatDateKR, formatTimeKR } from "@/lib/utils/date";
import { escapeHtml } from "@/lib/utils/validation";
import { BRAND_NAME, brandContactEmailOrNull } from "@/lib/branding";

export interface BookingStatusEmailRow {
  id: string;
  slot_start: string;
  slot_end: string;
  session_number: number;
}

export interface BookingStatusEmailExperiment {
  id: string;
  title: string;
  experiment_mode: "offline" | "online" | "hybrid";
}

export interface BookingStatusEmailResearcher {
  display_name: string | null;
  contact_email: string | null;
  email: string | null;
  phone: string | null;
}

export interface BookingStatusEmailInput {
  participant: { name: string; email: string };
  // The booking that just transitioned. Multi-session: this is the single
  // session affected — sibling rows in the group are NOT cancelled by this
  // status flip alone, so we say so explicitly in the body.
  booking: BookingStatusEmailRow;
  experiment: BookingStatusEmailExperiment;
  researcher: BookingStatusEmailResearcher | null;
  // Other bookings in the same booking_group (excluding this one) that
  // are still confirmed. Lets the multi-session message be precise:
  // "이번 회차만 취소되었으며, 나머지 N회차는 예정대로 진행됩니다".
  otherActiveSessions: Array<{ slot_start: string; session_number: number }>;
  // Origin for the rebook CTA. Optional; if missing we drop the link
  // rather than render a broken relative URL.
  appOrigin: string | null;
}

export interface BuiltStatusEmail {
  to: string;
  subject: string;
  html: string;
}

// ── helpers ─────────────────────────────────────────────────────────────

function whenLine(b: BookingStatusEmailRow): string {
  return `${formatDateKR(b.slot_start)} · ${formatTimeKR(b.slot_start)} – ${formatTimeKR(b.slot_end)}`;
}

function researcherBlock(r: BookingStatusEmailResearcher | null): string {
  const name = (r?.display_name ?? "").trim() || "담당 연구원";
  const phone = (r?.phone ?? "").trim();
  // researcher contact_email wins; lab inbox only if configured.
  const contact =
    (r?.contact_email ?? "").trim() ||
    (r?.email ?? "").trim() ||
    brandContactEmailOrNull();

  return `
    <p style="margin:18px 0 6px 0;font-weight:600;">담당 연구원 · 문의</p>
    <p style="margin:0;line-height:1.6;color:#374151;">
      ${escapeHtml(name)}${phone ? ` · ${escapeHtml(phone)}` : ""}${
        contact
          ? `<br/><a href="mailto:${contact}" style="color:#2563eb;">${escapeHtml(contact)}</a>`
          : ""
      }
    </p>`;
}

function multiSessionBlock(
  others: BookingStatusEmailInput["otherActiveSessions"],
  flavour: "cancel" | "no_show",
): string {
  if (others.length === 0) return "";
  const verb = flavour === "cancel" ? "취소" : "결석 처리";
  const list = others
    .map(
      (s) =>
        `<li style="margin:3px 0;">${formatDateKR(s.slot_start)} · ${formatTimeKR(s.slot_start)}${
          s.session_number > 1 ? ` <span style="color:#6b7280;">(${s.session_number}회차)</span>` : ""
        }</li>`,
    )
    .join("");
  return `
    <div style="margin:14px 0;padding:12px 14px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;">
      <p style="margin:0 0 6px 0;font-size:13px;color:#1e40af;">
        이번 회차만 ${verb}되었으며, 다음 회차는 예정대로 진행됩니다:
      </p>
      <ul style="margin:0;padding-left:20px;font-size:13px;color:#1e3a8a;">${list}</ul>
    </div>`;
}

function rebookCta(experiment: BookingStatusEmailExperiment, origin: string | null): string {
  if (!origin) return "";
  if (experiment.experiment_mode === "online") return ""; // online은 재예약 흐름이 다를 수 있음
  const url = `${origin}/book/${encodeURIComponent(experiment.id)}`;
  return `
    <p style="margin:18px 0 6px 0;">다른 일정에 다시 예약하시려면 아래 링크에서 가능한 시간을 확인하실 수 있습니다.</p>
    <p style="margin:0;">
      <a href="${url}"
         style="display:inline-block;padding:9px 16px;background:#2563eb;color:#ffffff;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600;">
        다시 예약하기 →
      </a>
    </p>`;
}

// ── cancelled ───────────────────────────────────────────────────────────

export function buildCancellationEmail(input: BookingStatusEmailInput): BuiltStatusEmail {
  const safeName = escapeHtml(input.participant.name || "참여자");
  const safeTitle = escapeHtml(input.experiment.title);
  const sessionSuffix =
    input.booking.session_number > 1 ? ` (${input.booking.session_number}회차)` : "";

  const subject = `[${BRAND_NAME}] ${input.experiment.title}${sessionSuffix} 예약이 취소되었습니다`;

  const html = `
    <div style="font-family:-apple-system,'Segoe UI',sans-serif;max-width:620px;margin:0 auto;padding:8px;color:#111827;line-height:1.6;">
      <div style="padding:14px 18px;background:#fef2f2;border:1px solid #fecaca;border-radius:10px;margin-bottom:18px;">
        <p style="margin:0;font-size:15px;font-weight:600;color:#991b1b;">예약이 취소되었습니다</p>
      </div>

      <p style="margin:0 0 6px 0;">${safeName}님, 안녕하세요.</p>
      <p style="margin:0 0 14px 0;">
        <b>${safeTitle}</b>${sessionSuffix} 실험 예약이 취소되었습니다.
        부득이한 사정으로 일정을 진행하지 못하게 된 점 양해 부탁드립니다.
      </p>

      <table style="border-collapse:collapse;width:100%;margin:14px 0;font-size:15px;">
        <tr>
          <td style="padding:10px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600;width:120px;">실험명</td>
          <td style="padding:10px 12px;border:1px solid #e5e7eb;">${safeTitle}</td>
        </tr>
        <tr>
          <td style="padding:10px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600;">취소된 일정</td>
          <td style="padding:10px 12px;border:1px solid #e5e7eb;color:#6b7280;text-decoration:line-through;">
            ${escapeHtml(whenLine(input.booking))}${
              input.booking.session_number > 1 ? ` <span style="color:#9ca3af;">(${input.booking.session_number}회차)</span>` : ""
            }
          </td>
        </tr>
      </table>

      ${multiSessionBlock(input.otherActiveSessions, "cancel")}

      ${rebookCta(input.experiment, input.appOrigin)}

      ${researcherBlock(input.researcher)}

      <p style="margin:24px 0 0 0;padding-top:14px;border-top:1px solid #e5e7eb;font-size:11px;color:#9ca3af;">
        ${BRAND_NAME} — 본 메일은 예약 상태 변경 시 자동 발송되었습니다.
      </p>
    </div>
  `;

  return { to: input.participant.email, subject, html };
}

// ── no_show ─────────────────────────────────────────────────────────────

export function buildNoShowEmail(input: BookingStatusEmailInput): BuiltStatusEmail {
  const safeName = escapeHtml(input.participant.name || "참여자");
  const safeTitle = escapeHtml(input.experiment.title);
  const sessionSuffix =
    input.booking.session_number > 1 ? ` (${input.booking.session_number}회차)` : "";

  const subject = `[${BRAND_NAME}] ${input.experiment.title}${sessionSuffix} 결석이 기록되었습니다`;

  const html = `
    <div style="font-family:-apple-system,'Segoe UI',sans-serif;max-width:620px;margin:0 auto;padding:8px;color:#111827;line-height:1.6;">
      <div style="padding:14px 18px;background:#fffbeb;border:1px solid #fde68a;border-radius:10px;margin-bottom:18px;">
        <p style="margin:0;font-size:15px;font-weight:600;color:#92400e;">결석이 기록되었습니다</p>
      </div>

      <p style="margin:0 0 6px 0;">${safeName}님, 안녕하세요.</p>
      <p style="margin:0 0 14px 0;">
        <b>${safeTitle}</b>${sessionSuffix} 실험 일정에 참여하지 않으신 것으로 기록되었습니다.
        피치 못할 사정이 있으셨다면 담당 연구원에게 알려 주세요.
      </p>

      <table style="border-collapse:collapse;width:100%;margin:14px 0;font-size:15px;">
        <tr>
          <td style="padding:10px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600;width:120px;">실험명</td>
          <td style="padding:10px 12px;border:1px solid #e5e7eb;">${safeTitle}</td>
        </tr>
        <tr>
          <td style="padding:10px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600;">결석 일정</td>
          <td style="padding:10px 12px;border:1px solid #e5e7eb;">
            ${escapeHtml(whenLine(input.booking))}${
              input.booking.session_number > 1 ? ` <span style="color:#6b7280;">(${input.booking.session_number}회차)</span>` : ""
            }
          </td>
        </tr>
      </table>

      ${multiSessionBlock(input.otherActiveSessions, "no_show")}

      <p style="margin:14px 0 6px 0;font-size:13px;color:#374151;">
        다시 참여 가능 여부는 실험 정책에 따라 다를 수 있어, 담당 연구원에게 직접 문의 부탁드립니다.
      </p>

      ${researcherBlock(input.researcher)}

      <p style="margin:24px 0 0 0;padding-top:14px;border-top:1px solid #e5e7eb;font-size:11px;color:#9ca3af;">
        ${BRAND_NAME} — 본 메일은 예약 상태 변경 시 자동 발송되었습니다.
      </p>
    </div>
  `;

  return { to: input.participant.email, subject, html };
}

// ── SMS bodies (short, 80자 이내 권장) ──────────────────────────────────

export function buildCancellationSMS(input: BookingStatusEmailInput): string {
  const labContact =
    (input.researcher?.contact_email ?? "").trim() ||
    brandContactEmailOrNull();
  const inquiry = labContact ? `\n문의: ${labContact}` : "";
  const sessionSuffix =
    input.booking.session_number > 1 ? ` ${input.booking.session_number}회차` : "";
  return `[${BRAND_NAME}] 예약 취소\n${input.participant.name}님, "${input.experiment.title}"${sessionSuffix} ${formatDateKR(input.booking.slot_start)} ${formatTimeKR(input.booking.slot_start)} 예약이 취소되었습니다.${inquiry}`;
}

export function buildNoShowSMS(input: BookingStatusEmailInput): string {
  const labContact =
    (input.researcher?.contact_email ?? "").trim() ||
    brandContactEmailOrNull();
  const inquiry = labContact ? `\n문의: ${labContact}` : "";
  const sessionSuffix =
    input.booking.session_number > 1 ? ` ${input.booking.session_number}회차` : "";
  return `[${BRAND_NAME}] 결석 기록\n${input.participant.name}님, "${input.experiment.title}"${sessionSuffix} ${formatDateKR(input.booking.slot_start)} 일정 결석이 기록되었습니다.${inquiry}`;
}
