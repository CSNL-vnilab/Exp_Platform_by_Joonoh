// Booking-confirmation email HTML builder — pure function.
//
// Extracted from booking.service.ts:runEmail so the email-retry service
// can re-render the same confirmation email (minus runLinks + paymentLink
// which require fresh token issuance) when the first-attempt send fails.
//
// No DB reads here. Caller loads the booking rows, creator profile, and
// any Location record beforehand and passes them in; the template just
// stitches the HTML. Safe to call from server components, cron routes,
// or anywhere that already has the BookingRow-ish inputs.

import { formatDateKR, formatTimeKR } from "@/lib/utils/date";
import { escapeHtml } from "@/lib/utils/validation";
import { BRAND_NAME, BRAND_CONTACT_EMAIL } from "@/lib/branding";
import { wrapEmailHtml } from "@/lib/services/email-shell";
import type { ExperimentMode } from "@/types/database";

export interface EmailRunLink {
  bookingId: string;
  url: string;
}

export interface EmailPaymentLink {
  url: string;
}

export interface EmailLocation {
  name: string;
  address_lines: string[];
  naver_url: string | null;
}

export interface EmailCreator {
  email: string;
  display_name: string | null;
  phone: string | null;
  contact_email: string | null;
}

export interface EmailBookingRow {
  id: string;
  slot_start: string;
  slot_end: string;
  session_number: number;
}

export interface EmailExperiment {
  title: string;
  participation_fee: number;
  experiment_mode: ExperimentMode;
  precautions: Array<{ question: string; required_answer: boolean }> | null;
}

export interface EmailParticipant {
  name: string;
  email: string;
}

export interface BuildConfirmationEmailInput {
  participant: EmailParticipant;
  experiment: EmailExperiment;
  rows: EmailBookingRow[];
  creator: EmailCreator | null;
  location: EmailLocation | null;
  runLinks?: EmailRunLink[];
  paymentLink?: EmailPaymentLink | null;
  // When set, prepend a one-line note explaining the context (used by the
  // retry path to soften the duplicate-delivery scenario if the original
  // email actually did arrive and this is a re-send).
  preface?: string;
}

export interface BuiltEmail {
  subject: string;
  html: string;
  to: string;
  cc?: string[];
}

export function buildConfirmationEmail(
  input: BuildConfirmationEmailInput,
): BuiltEmail {
  const { participant, experiment, rows, creator, location } = input;
  const runLinks = input.runLinks ?? [];
  const paymentLink = input.paymentLink ?? null;

  const safeName = escapeHtml(participant.name);
  const safeTitle = escapeHtml(experiment.title);

  const slotList = rows
    .map(
      (b) =>
        `<li style="margin:4px 0;">${formatDateKR(b.slot_start)} · ${formatTimeKR(b.slot_start)} – ${formatTimeKR(b.slot_end)}${rows.length > 1 ? ` <span style="color:#6b7280;">(${b.session_number}회차)</span>` : ""}</li>`,
    )
    .join("");

  const researcherEmail =
    (creator?.contact_email || creator?.email || "").trim() || null;
  const researcherName = (creator?.display_name ?? "").trim() || "담당 연구원";
  const researcherPhone = (creator?.phone ?? "").trim();
  const contactLine = researcherEmail || BRAND_CONTACT_EMAIL;

  const precautionsBlock =
    experiment.precautions && experiment.precautions.length > 0
      ? `
      <div style="margin:20px 0;padding:14px 16px;background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;">
        <p style="margin:0 0 8px 0;font-weight:600;color:#92400e;">예약 시 확인하신 참여 주의사항</p>
        <ul style="margin:0;padding-left:18px;color:#78350f;">
          ${experiment.precautions
            .map(
              (p) =>
                `<li style="margin:3px 0;">${escapeHtml(p.question)}</li>`,
            )
            .join("")}
        </ul>
        <p style="margin:10px 0 0 0;font-size:12px;color:#92400e;">
          위 항목에 모두 "예"로 응답해 주셔서 감사합니다. 실험 당일까지 조건이 변경되면 미리 담당자에게 알려주세요.
        </p>
      </div>`
      : "";

  const isOnline = experiment.experiment_mode === "online";
  const runLinkByBooking = new Map(runLinks.map((l) => [l.bookingId, l.url]));
  const onlineBlock =
    runLinks.length > 0
      ? `
      <div style="margin:20px 0;padding:14px 16px;background:#eff6ff;border:1px solid #93c5fd;border-radius:8px;">
        <p style="margin:0 0 8px 0;font-weight:600;color:#1d4ed8;">${
          isOnline ? "온라인 실험 참여 링크" : "사전 온라인 세션 링크"
        }</p>
        <p style="margin:0 0 10px 0;font-size:13px;color:#1e3a8a;">
          아래 링크를 예약 시간에 열어주세요. 링크는 본인에게만 발급된 것이므로 타인과 공유하지 마세요.
        </p>
        <ul style="margin:0;padding-left:18px;color:#1e40af;">
          ${rows
            .map((b) => {
              const url = runLinkByBooking.get(b.id);
              if (!url) return "";
              const label =
                rows.length > 1
                  ? `${b.session_number}회차 — ${formatDateKR(b.slot_start)}`
                  : `${formatDateKR(b.slot_start)} ${formatTimeKR(b.slot_start)}`;
              return `<li style="margin:3px 0;"><a href="${url}" style="color:#1d4ed8;word-break:break-all;">${escapeHtml(label)}</a></li>`;
            })
            .join("")}
        </ul>
      </div>`
      : "";

  const locationBlock =
    isOnline
      ? ""
      : location
      ? `
      <p style="margin:18px 0 6px 0;font-weight:600;">찾아오시는 길</p>
      <p style="margin:0;line-height:1.55;">
        ${escapeHtml(location.name)}<br/>
        ${location.address_lines.map((l) => escapeHtml(l)).join("<br/>")}
      </p>
      ${
        location.naver_url
          ? `<p style="margin:8px 0 0 0;"><a href="${location.naver_url}" style="color:#2563eb;">네이버 지도에서 열기 →</a></p>`
          : ""
      }`
      : "";

  const feeLine =
    experiment.participation_fee > 0
      ? `<tr><td style="padding:10px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600;width:110px;">참여비</td><td style="padding:10px 12px;border:1px solid #e5e7eb;">${experiment.participation_fee.toLocaleString()}원 (실험 종료 후 지급)</td></tr>`
      : "";

  const paymentBlock = paymentLink
    ? `
      <div style="margin:20px 0;padding:14px 16px;background:#f5f3ff;border:1px solid #c4b5fd;border-radius:8px;">
        <p style="margin:0 0 8px 0;font-weight:600;color:#5b21b6;">📝 실험 종료 후 정산 정보 입력</p>
        <p style="margin:0 0 10px 0;font-size:13px;color:#4c1d95;">
          참여비 지급을 위해 모든 실험 세션이 종료된 후 아래 링크에서 주민등록번호·계좌정보·서명을 입력해 주세요. 링크는 본인에게만 발급되며, 실험 종료 후 60일간 유효합니다.
        </p>
        <p style="margin:0;">
          <a href="${paymentLink.url}" style="display:inline-block;padding:8px 14px;background:#6d28d9;color:#ffffff;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600;">정산 정보 입력하기 →</a>
        </p>
      </div>`
    : "";

  const contactBlock = `
      <p style="margin:20px 0 6px 0;font-weight:600;">담당 연구원 · 문의</p>
      <p style="margin:0;line-height:1.6;">
        ${escapeHtml(researcherName)}${
          researcherPhone ? ` · ${escapeHtml(researcherPhone)}` : ""
        }<br/>
        <a href="mailto:${contactLine}" style="color:#2563eb;">${escapeHtml(contactLine)}</a>
      </p>`;

  const prefaceBlock = input.preface
    ? `<p style="margin:0 0 14px 0;padding:8px 12px;background:#f3f4f6;border-radius:6px;font-size:13px;color:#374151;">${escapeHtml(input.preface)}</p>`
    : "";

  // P0-Ι: wrap in proper <html><head> shell so iOS Gmail / dark-mode
  // clients honor color-scheme: light only and don't crush our light
  // box backgrounds.
  const html = wrapEmailHtml(
    `
    <div style="font-family:-apple-system,'Segoe UI',sans-serif;max-width:620px;margin:0 auto;padding:8px;color:#111827;line-height:1.55;">
      ${prefaceBlock}
      <div style="padding:14px 18px;background:#ecfdf5;border:1px solid #6ee7b7;border-radius:10px;margin-bottom:18px;">
        <p style="margin:0;font-size:15px;font-weight:600;color:#065f46;">✓ 실험 예약이 확정되었습니다</p>
        <p style="margin:6px 0 0 0;font-size:13px;color:#047857;">
          변경·취소가 필요하시면 실험 시작 <b>24시간 전까지</b> 담당 연구원에게 알려주세요.
        </p>
      </div>

      <p style="margin:0 0 6px 0;">안녕하세요, ${safeName}님.</p>
      <p style="margin:0 0 14px 0;">
        <b>${safeTitle}</b> 실험에 참여 신청해 주셔서 진심으로 감사드립니다. 아래 일정으로 예약이 확정되었습니다.
      </p>

      <table style="border-collapse:collapse;width:100%;margin:14px 0;font-size:15px;">
        <tr><td style="padding:10px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600;width:110px;">실험명</td><td style="padding:10px 12px;border:1px solid #e5e7eb;">${safeTitle}</td></tr>
        ${feeLine}
      </table>

      <p style="margin:18px 0 6px 0;font-weight:600;">예약하신 시간</p>
      <ul style="margin:0;padding-left:20px;">${slotList}</ul>

      ${onlineBlock}
      ${locationBlock}
      ${precautionsBlock}
      ${paymentBlock}
      ${contactBlock}

      <p style="margin:22px 0 6px 0;font-size:13px;color:#6b7280;">
        일정 변경이 필요하시면 실험 시작 24시간 전까지 담당 연구원에게 알려주세요. 실험 전날과 당일에 리마인더 메일이 한 번 더 발송됩니다.
      </p>
      <p style="margin:4px 0 0 0;font-size:12px;color:#9ca3af;">
        ${BRAND_NAME} — 본 메일은 예약 신청 확인용입니다.
      </p>
    </div>
    `,
    { title: `[${BRAND_NAME}] 예약 확정` },
  );

  // Case-insensitive compare: Foo@x vs foo@x are the same inbox.
  const cc =
    researcherEmail &&
    researcherEmail.toLowerCase() !== participant.email.toLowerCase()
      ? [researcherEmail]
      : undefined;

  return {
    to: participant.email,
    cc,
    subject: `[${BRAND_NAME}] 실험 예약 확정 — ${experiment.title}`,
    html,
  };
}
