// Builder for "예약 일정 변경" participant notifications.
//
// Pure function — no DB / no SMTP. Caller (runReschedulePipeline) loads
// participant + experiment + researcher + (optional) location + sibling
// sessions and passes them in.
//
// Tone: brief apology + visual diff (이전 ↔ 변경된 일정), location block
// for offline experiments, sibling-session context for multi-session,
// and a researcher contact block. Same structural skeleton as the other
// participant-facing templates so the inbox feels consistent.

import { formatDateKR, formatTimeKR } from "@/lib/utils/date";
import { escapeHtml } from "@/lib/utils/validation";
import { BOOKING_EDIT_CUTOFF_HOURS } from "@/lib/utils/constants";
import { BRAND_NAME, brandContactEmailOrNull } from "@/lib/branding";
import { wrapEmailHtml } from "@/lib/services/email-shell";

export interface RescheduleEmailExperiment {
  title: string;
  experiment_mode: "offline" | "online" | "hybrid";
}

export interface RescheduleEmailLocation {
  name: string;
  address_lines: string[];
  naver_url: string | null;
}

export interface RescheduleEmailResearcher {
  display_name: string | null;
  contact_email: string | null;
  email: string | null;
  phone: string | null;
}

export interface RescheduleEmailSibling {
  slot_start: string;
  session_number: number;
}

export interface RescheduleEmailInput {
  participant: { name: string; email: string };
  experiment: RescheduleEmailExperiment;
  // The booking row whose slot just changed.
  booking: {
    id: string;
    session_number: number;
    // New slot (already persisted in DB by the time we render).
    slot_start: string;
    slot_end: string;
  };
  // Pre-change slot — captured by the API handler before the UPDATE so
  // we can still show the participant what they were holding.
  oldSlotStart: string;
  oldSlotEnd: string;
  location: RescheduleEmailLocation | null;
  researcher: RescheduleEmailResearcher | null;
  // Other still-confirmed sessions in this group, EXCLUDING this booking.
  // Used to soften the message for multi-session participants.
  otherActiveSessions: RescheduleEmailSibling[];
  // Optional participant self-edit URL (token-gated). The pipeline
  // issues a fresh booking-edit token and passes the URL here so a
  // participant who got the change on the road can keep editing
  // without hunting for the original confirmation email.
  editLink?: { url: string } | null;
}

export interface BuiltRescheduleEmail {
  to: string;
  subject: string;
  html: string;
}

// Subject cap so Gmail mobile (~70 char visible) doesn't truncate the
// "일정 변경" suffix into the experiment title.
const TITLE_CAP_FOR_SUBJECT = 30;

function capTitle(t: string): string {
  return t.length > TITLE_CAP_FOR_SUBJECT
    ? `${t.slice(0, TITLE_CAP_FOR_SUBJECT - 1)}…`
    : t;
}

function whenLine(start: string, end: string): string {
  return `${formatDateKR(start)} · ${formatTimeKR(start)} – ${formatTimeKR(end)}`;
}

function locationBlock(loc: RescheduleEmailLocation | null): string {
  if (!loc) return "";
  const lines = (loc.address_lines ?? []).map((l) => escapeHtml(l)).join("<br/>");
  return `
    <p style="margin:18px 0 6px 0;font-weight:600;">찾아오시는 길</p>
    <p style="margin:0;line-height:1.55;word-break:keep-all;">
      ${escapeHtml(loc.name)}<br/>${lines}
    </p>
    ${
      loc.naver_url
        ? `<p style="margin:8px 0 0 0;"><a href="${loc.naver_url}" style="color:#2563eb;">네이버 지도에서 열기 →</a></p>`
        : ""
    }`;
}

function researcherBlock(r: RescheduleEmailResearcher | null): string {
  const name = (r?.display_name ?? "").trim() || "담당 연구원";
  const phone = (r?.phone ?? "").trim();
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

function siblingBlock(others: RescheduleEmailSibling[]): string {
  if (others.length === 0) return "";
  const list = others
    .map(
      (s) =>
        `<li style="margin:3px 0;">${formatDateKR(s.slot_start)} · ${formatTimeKR(s.slot_start)}${
          s.session_number > 1
            ? ` <span style="color:#6b7280;">(${s.session_number}회차)</span>`
            : ""
        }</li>`,
    )
    .join("");
  return `
    <div style="margin:14px 0;padding:12px 14px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;">
      <p style="margin:0 0 6px 0;font-size:13px;color:#1e40af;">
        본 변경은 이번 회차에만 적용됩니다. 다른 회차는 예정대로 진행됩니다:
      </p>
      <ul style="margin:0;padding-left:20px;font-size:13px;color:#1e3a8a;">${list}</ul>
    </div>`;
}

export function buildRescheduleEmail(input: RescheduleEmailInput): BuiltRescheduleEmail {
  const safeName = escapeHtml(input.participant.name || "참여자");
  const safeTitle = escapeHtml(input.experiment.title);
  const sessionSuffix =
    input.booking.session_number > 1 ? ` (${input.booking.session_number}회차)` : "";

  const subject = `[${BRAND_NAME}] ${capTitle(input.experiment.title)}${sessionSuffix} 일정이 변경되었습니다`;

  const oldWhen = escapeHtml(whenLine(input.oldSlotStart, input.oldSlotEnd));
  const newWhen = escapeHtml(whenLine(input.booking.slot_start, input.booking.slot_end));

  // P0-Ι: <html><head> shell with color-scheme: light only
  const html = wrapEmailHtml(
    `
    <div style="font-family:-apple-system,'Segoe UI',sans-serif;max-width:620px;margin:0 auto;padding:8px;color:#111827;line-height:1.6;">
      <div style="padding:14px 18px;background:#fef3c7;border:1px solid #fcd34d;border-radius:10px;margin-bottom:18px;">
        <p style="margin:0;font-size:15px;font-weight:600;color:#92400e;">📅 실험 일정이 변경되었습니다</p>
      </div>

      <p style="margin:0 0 6px 0;">${safeName}님, 안녕하세요.</p>
      <p style="margin:0 0 14px 0;word-break:keep-all;">
        <b>${safeTitle}</b>${sessionSuffix} 실험 예약 일정이 변경되었습니다.
        갑작스러운 변경에 양해 부탁드립니다.
      </p>

      <table style="border-collapse:collapse;width:100%;margin:14px 0;font-size:15px;">
        <tr>
          <td style="padding:10px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600;width:120px;">실험명</td>
          <td style="padding:10px 12px;border:1px solid #e5e7eb;word-break:keep-all;">${safeTitle}</td>
        </tr>
        ${
          input.booking.session_number > 1
            ? `<tr>
                 <td style="padding:10px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600;">회차</td>
                 <td style="padding:10px 12px;border:1px solid #e5e7eb;">${input.booking.session_number}회차</td>
               </tr>`
            : ""
        }
        <tr>
          <td style="padding:10px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600;">이전 일정</td>
          <td style="padding:10px 12px;border:1px solid #e5e7eb;color:#9ca3af;text-decoration:line-through;white-space:nowrap;">
            ${oldWhen}
          </td>
        </tr>
        <tr>
          <td style="padding:10px 12px;border:1px solid #fcd34d;background:#fffbeb;font-weight:700;color:#92400e;">변경된 일정</td>
          <td style="padding:10px 12px;border:1px solid #fcd34d;background:#fffbeb;font-weight:700;color:#92400e;white-space:nowrap;">
            ${newWhen}
          </td>
        </tr>
      </table>

      ${siblingBlock(input.otherActiveSessions)}

      ${input.experiment.experiment_mode === "online" ? "" : locationBlock(input.location)}

      <p style="margin:16px 0 6px 0;font-size:13px;color:#374151;word-break:keep-all;">
        변경된 일정에 참여가 어려우시면 가능한 빨리 담당 연구원에게 연락 부탁드립니다.
      </p>

      ${
        input.editLink
          ? `
      <div style="margin:18px 0;padding:12px 14px;background:#fff7ed;border:1px solid #fdba74;border-radius:8px;">
        <p style="margin:0 0 6px 0;font-size:13px;color:#9a3412;font-weight:600;">✏️ 일정 다시 변경 / 참여 취소</p>
        <p style="margin:0 0 8px 0;font-size:13px;color:#7c2d12;">
          아래 링크에서 본인 확인 후 다시 일정을 변경하거나 참여를 취소하실 수 있습니다. 각 회차 시작 ${BOOKING_EDIT_CUTOFF_HOURS}시간 전까지 가능합니다.
        </p>
        <p style="margin:0;">
          <a href="${input.editLink.url}" style="display:inline-block;padding:6px 12px;background:#c2410c;color:#ffffff;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600;">실험 일정 수정하기 →</a>
        </p>
      </div>`
          : ""
      }

      ${researcherBlock(input.researcher)}

      <p style="margin:24px 0 0 0;padding-top:14px;border-top:1px solid #e5e7eb;font-size:11px;color:#9ca3af;">
        ${BRAND_NAME} — 본 메일은 예약 일정 변경 시 자동 발송되었습니다.
      </p>
    </div>
    `,
    { title: subject },
  );

  return { to: input.participant.email, subject, html };
}

// ── reschedule REJECTED — participant notification ─────────────────────
//
// The experimenter reviewed a participant's reschedule request and did NOT
// approve it, so the ORIGINAL schedule is kept. We inform the participant
// gently, echo the (unchanged) slot so they know exactly what still stands,
// and surface the optional rejection reason. Reuses the file's existing
// helpers (whenLine, escapeHtml, researcherBlock, wrapEmailHtml, BRAND_NAME).

export interface RescheduleRejectedInput {
  participant: { name: string; email: string };
  experiment: { title: string };
  sessionNumber: number;
  oldSlotStart: string; // the kept (original) time
  oldSlotEnd: string;
  reason?: string | null; // experimenter rejection reason
  researcher: RescheduleEmailResearcher | null;
}

export function buildRescheduleRejectedEmail(
  input: RescheduleRejectedInput,
): BuiltRescheduleEmail {
  const safeName = escapeHtml(input.participant.name || "참여자");
  const safeTitle = escapeHtml(input.experiment.title);
  const sessionSuffix = input.sessionNumber > 1 ? ` (${input.sessionNumber}회차)` : "";

  const subject = `[${BRAND_NAME}] ${capTitle(input.experiment.title)} 일정 변경 요청 안내`;

  const keptWhen = escapeHtml(whenLine(input.oldSlotStart, input.oldSlotEnd));
  const reason = (input.reason ?? "").trim();

  // P0-Ι: <html><head> shell with color-scheme: light only
  const html = wrapEmailHtml(
    `
    <div style="font-family:-apple-system,'Segoe UI',sans-serif;max-width:620px;margin:0 auto;padding:8px;color:#111827;line-height:1.6;">
      <div style="padding:14px 18px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;margin-bottom:18px;">
        <p style="margin:0;font-size:15px;font-weight:600;color:#374151;">기존 일정이 유지됩니다</p>
      </div>

      <p style="margin:0 0 6px 0;">${safeName}님, 안녕하세요.</p>
      <p style="margin:0 0 14px 0;word-break:keep-all;">
        <b>${safeTitle}</b>${sessionSuffix} 실험에 대해 요청하신 일정 변경이 이번에는 반영되지 못했습니다.
        기존에 예약하신 일정 그대로 진행될 예정이니 아래 일정을 확인해 주세요.
      </p>

      <table style="border-collapse:collapse;width:100%;margin:14px 0;font-size:15px;">
        <tr>
          <td style="padding:10px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600;width:120px;">실험명</td>
          <td style="padding:10px 12px;border:1px solid #e5e7eb;word-break:keep-all;">${safeTitle}</td>
        </tr>
        ${
          input.sessionNumber > 1
            ? `<tr>
                 <td style="padding:10px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600;">회차</td>
                 <td style="padding:10px 12px;border:1px solid #e5e7eb;">${input.sessionNumber}회차</td>
               </tr>`
            : ""
        }
        <tr>
          <td style="padding:10px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600;">유지되는 일정</td>
          <td style="padding:10px 12px;border:1px solid #e5e7eb;font-weight:600;white-space:nowrap;">
            ${keptWhen}
          </td>
        </tr>
        ${
          reason
            ? `<tr>
                 <td style="padding:10px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600;">안내 사유</td>
                 <td style="padding:10px 12px;border:1px solid #e5e7eb;word-break:keep-all;white-space:pre-wrap;">${escapeHtml(reason)}</td>
               </tr>`
            : ""
        }
      </table>

      <p style="margin:16px 0 6px 0;font-size:13px;color:#374151;word-break:keep-all;">
        일정 참여가 어려우시거나 조정이 필요하시면 담당 연구원에게 연락 부탁드립니다.
      </p>

      ${researcherBlock(input.researcher)}

      <p style="margin:24px 0 0 0;padding-top:14px;border-top:1px solid #e5e7eb;font-size:11px;color:#9ca3af;">
        ${BRAND_NAME} — 본 메일은 일정 변경 요청 처리 결과로 발송되었습니다.
      </p>
    </div>
    `,
    { title: subject },
  );

  return { to: input.participant.email, subject, html };
}

// ── SMS body — short, before→after diff (P0 #4) ────────────────────────

export function buildRescheduleSMS(input: RescheduleEmailInput): string {
  const labContact =
    (input.researcher?.contact_email ?? "").trim() ||
    brandContactEmailOrNull();
  const inquiry = labContact ? `\n문의: ${labContact}` : "";
  const sessionSuffix =
    input.booking.session_number > 1 ? ` ${input.booking.session_number}회차` : "";
  // 한 줄에 이전→변경 비교를 넣어 SMS 한 통에 가능하면 들어가도록.
  const oldShort = `${formatDateKR(input.oldSlotStart)} ${formatTimeKR(input.oldSlotStart)}`;
  const newShort = `${formatDateKR(input.booking.slot_start)} ${formatTimeKR(input.booking.slot_start)}`;
  return `[${BRAND_NAME}] 일정 변경\n${input.participant.name}님, "${input.experiment.title}"${sessionSuffix}\n${oldShort} → ${newShort}${inquiry}`;
}
