// Builder for the participant→experimenter "일정 변경 승인 요청" NOTIFY email.
//
// Pure function — no DB / no SMTP. A participant submitted a reschedule
// request via the self-edit page; the caller resolves the experimenter's
// recipient address + the requested vs. current slots and passes them in.
// This mail is internal (experimenter-facing), so its job is to make the
// diff scannable and drop the reader straight into the approval queue.
//
// Tone: neutral, action-oriented. A table shows 참여자 / 회차 /
// 기존 일정(struck) → 요청 일정, an optional 사유, and a button to the
// approval screen. Shared helpers (whenLine, escapeHtml, wrapEmailHtml,
// BRAND_NAME) mirror booking-reschedule-email.ts so both mails render the
// same way.

import { formatDateKR, formatTimeKR } from "@/lib/utils/date";
import { escapeHtml } from "@/lib/utils/validation";
import { BRAND_NAME } from "@/lib/branding";
import { wrapEmailHtml } from "@/lib/services/email-shell";

export interface RescheduleRequestNotifyInput {
  to: string; // experimenter recipient email (caller resolves it)
  participant: { name: string };
  experiment: { title: string };
  sessionNumber: number;
  oldSlotStart: string; // current session time (ISO)
  oldSlotEnd: string;
  newSlotStart: string; // requested new time (ISO)
  newSlotEnd: string;
  reason?: string | null;
  approveUrl: string; // full URL to the approval queue: origin + /experiments/{experimentId}/bookings
}

export interface BuiltRescheduleRequestEmail {
  to: string;
  subject: string;
  html: string;
}

// ── helpers (mirror booking-reschedule-email.ts) ────────────────────────

function whenLine(start: string, end: string): string {
  return `${formatDateKR(start)} · ${formatTimeKR(start)} – ${formatTimeKR(end)}`;
}

export function buildRescheduleRequestEmail(
  input: RescheduleRequestNotifyInput,
): BuiltRescheduleRequestEmail {
  const safeName = escapeHtml(input.participant.name || "참여자");
  const safeTitle = escapeHtml(input.experiment.title);

  const subject = `[${BRAND_NAME}] 일정 변경 승인 요청 — ${input.participant.name} (${input.experiment.title})`;

  const oldWhen = escapeHtml(whenLine(input.oldSlotStart, input.oldSlotEnd));
  const newWhen = escapeHtml(whenLine(input.newSlotStart, input.newSlotEnd));
  const reason = (input.reason ?? "").trim();

  // P0-Ι: <html><head> shell with color-scheme: light only
  const html = wrapEmailHtml(
    `
    <div style="font-family:-apple-system,'Segoe UI',sans-serif;max-width:620px;margin:0 auto;padding:8px;color:#111827;line-height:1.6;">
      <div style="padding:14px 18px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;margin-bottom:18px;">
        <p style="margin:0;font-size:15px;font-weight:600;color:#1e40af;">📥 일정 변경 승인 요청</p>
      </div>

      <p style="margin:0 0 14px 0;word-break:keep-all;">
        <b>${safeName}</b>님이 <b>${safeTitle}</b> 실험의 일정 변경을 요청했습니다.
        아래 요청 내용을 확인한 뒤 승인 화면에서 처리해 주세요.
      </p>

      <table style="border-collapse:collapse;width:100%;margin:14px 0;font-size:15px;">
        <tr>
          <td style="padding:10px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600;width:120px;">참여자</td>
          <td style="padding:10px 12px;border:1px solid #e5e7eb;word-break:keep-all;">${safeName}</td>
        </tr>
        <tr>
          <td style="padding:10px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600;">회차</td>
          <td style="padding:10px 12px;border:1px solid #e5e7eb;">${input.sessionNumber}회차</td>
        </tr>
        <tr>
          <td style="padding:10px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600;">기존 일정</td>
          <td style="padding:10px 12px;border:1px solid #e5e7eb;color:#9ca3af;text-decoration:line-through;white-space:nowrap;">
            ${oldWhen}
          </td>
        </tr>
        <tr>
          <td style="padding:10px 12px;border:1px solid #bfdbfe;background:#eff6ff;font-weight:700;color:#1e40af;">요청 일정</td>
          <td style="padding:10px 12px;border:1px solid #bfdbfe;background:#eff6ff;font-weight:700;color:#1e40af;white-space:nowrap;">
            ${newWhen}
          </td>
        </tr>
        ${
          reason
            ? `<tr>
                 <td style="padding:10px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600;">사유</td>
                 <td style="padding:10px 12px;border:1px solid #e5e7eb;word-break:keep-all;white-space:pre-wrap;">${escapeHtml(reason)}</td>
               </tr>`
            : ""
        }
      </table>

      <div style="margin:20px 0;text-align:center;">
        <a href="${input.approveUrl}"
           style="display:inline-block;padding:12px 22px;background:#2563eb;color:#ffffff;border-radius:8px;text-decoration:none;font-size:15px;font-weight:700;">
          승인 화면으로 이동 →
        </a>
      </div>

      <p style="margin:16px 0 6px 0;font-size:13px;color:#374151;word-break:keep-all;">
        승인하면 요청된 일정이 캘린더와 리마인더에 반영되고, 참여자에게 변경 안내 메일이 발송됩니다.
      </p>

      <p style="margin:24px 0 0 0;padding-top:14px;border-top:1px solid #e5e7eb;font-size:11px;color:#9ca3af;">
        ${BRAND_NAME} — 본 메일은 참여자의 일정 변경 요청 시 발송되었습니다.
      </p>
    </div>
    `,
    { title: subject },
  );

  return { to: input.to, subject, html };
}
