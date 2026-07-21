// Builder for the researcher→participant "일정을 재조정해 주세요" INVITE email.
//
// Pure function — no DB / no SMTP. The caller resolves the participant,
// experiment title, a fresh token-gated edit URL, the researcher profile,
// and (optionally) a custom note the researcher typed, then passes them in.
//
// Tone: friendly request. We explain the researcher would like the
// participant to re-pick / adjust their session time, surface a prominent
// button to the self-edit page, and set the expectation that the change
// only takes effect once the researcher confirms the requested slot. Same
// structural skeleton + shared helpers as booking-reschedule-email.ts so
// the participant's inbox stays consistent.

import { escapeHtml } from "@/lib/utils/validation";
import { BRAND_NAME, brandContactEmailOrNull } from "@/lib/branding";
import { wrapEmailHtml } from "@/lib/services/email-shell";
import type { RescheduleEmailResearcher } from "@/lib/services/booking-reschedule-email";

export interface RescheduleInviteInput {
  participant: { name: string; email: string };
  experiment: { title: string };
  editUrl: string; // full URL: origin + /booking-edit/{token}
  researcher: RescheduleEmailResearcher | null; // import the type from ./booking-reschedule-email
  message?: string | null; // optional custom note the researcher typed
}

export interface BuiltRescheduleInviteEmail {
  to: string;
  subject: string;
  html: string;
}

// ── helpers (mirror booking-reschedule-email.ts) ────────────────────────

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

function messageBlock(message: string | null | undefined): string {
  const trimmed = (message ?? "").trim();
  if (!trimmed) return "";
  return `
    <div style="margin:14px 0;padding:12px 14px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;">
      <p style="margin:0 0 6px 0;font-size:13px;font-weight:600;color:#374151;">담당 연구원 메모</p>
      <p style="margin:0;font-size:14px;color:#374151;line-height:1.6;white-space:pre-wrap;word-break:keep-all;">${escapeHtml(trimmed)}</p>
    </div>`;
}

export function buildRescheduleInviteEmail(
  input: RescheduleInviteInput,
): BuiltRescheduleInviteEmail {
  const safeName = escapeHtml(input.participant.name || "참여자");
  const safeTitle = escapeHtml(input.experiment.title);

  const subject = `[${BRAND_NAME}] ${input.experiment.title} 실험 일정 재조정 안내`;

  // P0-Ι: <html><head> shell with color-scheme: light only
  const html = wrapEmailHtml(
    `
    <div style="font-family:-apple-system,'Segoe UI',sans-serif;max-width:620px;margin:0 auto;padding:8px;color:#111827;line-height:1.6;">
      <div style="padding:14px 18px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;margin-bottom:18px;">
        <p style="margin:0;font-size:15px;font-weight:600;color:#1e40af;">📅 실험 일정을 재조정해 주세요</p>
      </div>

      <p style="margin:0 0 6px 0;">${safeName}님, 안녕하세요.</p>
      <p style="margin:0 0 14px 0;word-break:keep-all;">
        <b>${safeTitle}</b> 실험 담당 연구원이 예약 일정을 다시 정해 주시기를 요청드립니다.
        아래 버튼을 눌러 참여 가능한 시간을 다시 선택하거나 기존 일정을 조정해 주세요.
      </p>

      ${messageBlock(input.message)}

      <div style="margin:20px 0;text-align:center;">
        <a href="${input.editUrl}"
           style="display:inline-block;padding:12px 22px;background:#2563eb;color:#ffffff;border-radius:8px;text-decoration:none;font-size:15px;font-weight:700;">
          일정 변경하기 →
        </a>
      </div>

      <p style="margin:16px 0 6px 0;font-size:13px;color:#374151;word-break:keep-all;">
        선택하신 일정은 담당 연구원이 확인한 뒤에 최종 반영됩니다. 확정되면 변경된 일정으로 안내 메일을 다시 보내 드립니다.
      </p>

      ${researcherBlock(input.researcher)}

      <p style="margin:24px 0 0 0;padding-top:14px;border-top:1px solid #e5e7eb;font-size:11px;color:#9ca3af;">
        ${BRAND_NAME} — 본 메일은 실험 일정 재조정 요청 시 발송되었습니다.
      </p>
    </div>
    `,
    { title: subject },
  );

  return { to: input.participant.email, subject, html };
}
