// 실험 종료 시 참여자에게 발송하는 "정산 정보 입력" 메일 빌더 — pure function.
//
// 예약 확정 메일 (booking-email-template) 에도 정산 링크가 함께 들어 있지만
// 참여자가 그 메일을 놓쳤거나, 다중 세션이라 마지막 세션이 끝난 시점에
// 다시 한번 알림이 필요한 경우를 위해 별도 전용 메일을 만든다. 본문은
// 짧고 CTA 중심이다.

import { escapeHtml } from "@/lib/utils/validation";
import { BRAND_NAME, BRAND_CONTACT_EMAIL } from "@/lib/branding";

export interface PaymentInfoEmailInput {
  participantName: string;
  participantEmail: string;
  experimentTitle: string;
  amountKrw: number;
  paymentUrl: string;
  // YYYY-MM-DD or empty. Shown in the body as 활동기간 안내.
  periodStart: string | null;
  periodEnd: string | null;
  // Researcher contact (optional — falls back to lab-wide contact).
  researcher: {
    displayName: string | null;
    contactEmail: string | null;
    phone: string | null;
  } | null;
  // Token expiry as ISO string. Shown in body so the participant knows the
  // window. Defaults to "발송일 + 60일".
  tokenExpiresAt: string;
}

export interface BuiltPaymentInfoEmail {
  to: string;
  subject: string;
  html: string;
}

export function buildPaymentInfoEmail(input: PaymentInfoEmailInput): BuiltPaymentInfoEmail {
  const safeName = escapeHtml(input.participantName || "참여자");
  const safeTitle = escapeHtml(input.experimentTitle);
  const amount = input.amountKrw.toLocaleString();

  const researcherName = (input.researcher?.displayName ?? "").trim() || "담당 연구원";
  const researcherContact =
    (input.researcher?.contactEmail ?? "").trim() || BRAND_CONTACT_EMAIL;
  const researcherPhone = (input.researcher?.phone ?? "").trim();

  const expiryDateKR = formatExpiryKR(input.tokenExpiresAt);
  const periodLine =
    input.periodStart && input.periodEnd
      ? `<p style="margin:0 0 6px 0;color:#374151;">실험 기간: ${escapeHtml(input.periodStart)} ~ ${escapeHtml(input.periodEnd)}</p>`
      : "";

  const subject = `[${BRAND_NAME}] ${input.experimentTitle} 참여비 정산 정보 입력 안내`;

  const html = `
    <div style="font-family:-apple-system,'Segoe UI',sans-serif;max-width:620px;margin:0 auto;padding:8px;color:#111827;line-height:1.55;">
      <h2 style="margin:0 0 12px 0;font-size:18px;color:#111827;">참여비 정산 정보 입력 안내</h2>

      <p style="margin:0 0 14px 0;">
        ${safeName}님, <strong>${safeTitle}</strong> 실험에 참여해 주셔서 감사합니다.
      </p>

      <div style="margin:18px 0;padding:16px 18px;background:#f5f3ff;border:1px solid #c4b5fd;border-radius:8px;">
        <p style="margin:0 0 6px 0;font-weight:600;color:#5b21b6;">📝 정산 정보 입력</p>
        <p style="margin:0 0 10px 0;font-size:13px;color:#4c1d95;">
          참여비 <strong>${amount}원</strong> 지급을 위해 아래 링크에서 정산 정보를 입력해 주세요.
        </p>
        ${periodLine}
        <p style="margin:14px 0 0 0;">
          <a href="${input.paymentUrl}"
             style="display:inline-block;padding:10px 18px;background:#6d28d9;color:#ffffff;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600;">
            정산 정보 입력하기 →
          </a>
        </p>
      </div>

      <p style="margin:16px 0 6px 0;font-weight:600;">필요한 정보</p>
      <ul style="margin:0 0 14px 18px;padding:0;color:#374151;">
        <li>성명 / 연락처 / 이메일 / 소속</li>
        <li>주민등록번호 (AES-256 암호화 저장)</li>
        <li>본인 명의 계좌 정보 (은행 / 계좌번호 / 예금주)</li>
        <li>통장 사본 (PDF, PNG, JPEG / 최대 5MB)</li>
        <li>전자서명 (캔버스에 직접 작성)</li>
      </ul>

      <p style="margin:14px 0;padding:10px 12px;background:#fff7ed;border:1px solid #fed7aa;border-radius:6px;font-size:13px;color:#9a3412;">
        ⚠ 링크는 본인에게만 발급된 일회성 링크입니다. 타인과 공유하지 마세요.<br/>
        링크는 <strong>${expiryDateKR}</strong>까지 유효합니다.
      </p>

      <p style="margin:18px 0 6px 0;font-weight:600;">담당 연구원 · 문의</p>
      <p style="margin:0;line-height:1.6;color:#374151;">
        ${escapeHtml(researcherName)}${researcherPhone ? ` · ${escapeHtml(researcherPhone)}` : ""}<br/>
        <a href="mailto:${researcherContact}" style="color:#2563eb;">${escapeHtml(researcherContact)}</a>
      </p>

      <p style="margin:24px 0 0 0;padding-top:14px;border-top:1px solid #e5e7eb;font-size:11px;color:#9ca3af;">
        본 메일은 ${BRAND_NAME} 정산 시스템에서 자동 발송되었습니다. 문의는 회신이 아닌 위 담당 연구원 이메일로 부탁드립니다.
      </p>
    </div>
  `;

  return { to: input.participantEmail, subject, html };
}

function formatExpiryKR(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "발송일로부터 60일";
    return new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "long",
      day: "numeric",
    }).format(d);
  } catch {
    return "발송일로부터 60일";
  }
}
