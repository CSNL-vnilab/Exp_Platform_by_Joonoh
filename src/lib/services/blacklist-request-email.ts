// Approval-request email fired when a researcher submits a blacklist
// request via /api/participants/blacklist-requests.
//
// User directive 2026-05-20: "블랙리스트 등록 요청이 발생하면,
// vnilab@gmail.com에서 vnilab@gmail.com으로 승인요청 메일이
// 발송되고, cc로 해당 실험자의 이메일이 할당된다."
//
// → From = To = GMAIL_USER (= vnilab@gmail.com in this deploy).
// → CC = the requester's contact email (the researcher who clicked).
// → Body lists the participant + reason + an approve link.
//
// Fire-and-forget from the API route so a flaky SMTP step doesn't undo
// a successful request insert.

import { wrapEmailHtml } from "@/lib/services/email-shell";
import { escapeHtml } from "@/lib/utils/validation";
import { sendEmail } from "@/lib/google/gmail";
import { BRAND_NAME, brandContactEmailOrNull } from "@/lib/branding";
import { getAppOrigin } from "@/lib/http/origin";

// Hardcoded prod URL as last resort so a misconfigured dev env still
// renders a clickable link in blacklist confirmation mail. Production
// always sets NEXT_PUBLIC_APP_URL so this fallback is dev-only.
function appBase(): string {
  return getAppOrigin() || "https://lab-reservation-seven.vercel.app";
}

export interface BlacklistRequestEmailInput {
  requestId: string;
  participantName: string | null;
  participantEmail: string | null;
  participantPublicCode: string | null;
  phoneLast4: string | null;
  reason: string;
  requesterName: string | null;
  requesterContactEmail: string | null;
}

export async function sendBlacklistApprovalRequestEmail(
  input: BlacklistRequestEmailInput,
): Promise<{ ok: boolean; error?: string }> {
  const self = (process.env.GMAIL_USER ?? "").trim();
  if (!self) {
    return { ok: false, error: "GMAIL_USER not configured" };
  }

  const queueUrl = `${appBase()}/blacklist-requests`;
  const safeName = escapeHtml(input.participantName ?? "(이름 없음)");
  const safeEmail = escapeHtml(input.participantEmail ?? "-");
  const safeCode = escapeHtml(input.participantPublicCode ?? "-");
  const safeReason = escapeHtml(input.reason);
  const safeRequester = escapeHtml(
    input.requesterName ?? input.requesterContactEmail ?? "(연구원)",
  );
  const safeLast4 = escapeHtml(input.phoneLast4 ?? "(미입력)");
  const contact = brandContactEmailOrNull();

  const inner = `
    <div style="font-family:-apple-system,'Segoe UI','Apple SD Gothic Neo','Malgun Gothic',sans-serif;max-width:620px;margin:0 auto;padding:16px;color:#111827;line-height:1.65;font-size:14px;">
      <div style="padding:12px 16px;background:#fff7ed;border:1px solid #fdba74;border-radius:10px;margin-bottom:18px;">
        <p style="margin:0;font-size:15px;font-weight:600;color:#9a3412;">⚑ 블랙리스트 등록 승인 요청</p>
      </div>

      <p style="margin:0 0 6px 0;"><b>${safeRequester}</b> 연구원이 다음 참여자를
        블랙리스트로 등록하도록 요청했습니다.</p>

      <table style="border-collapse:collapse;width:100%;margin:14px 0;font-size:14px;">
        <tr><td style="padding:8px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600;width:110px;">이름</td>
            <td style="padding:8px 12px;border:1px solid #e5e7eb;">${safeName}</td></tr>
        <tr><td style="padding:8px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600;">이메일</td>
            <td style="padding:8px 12px;border:1px solid #e5e7eb;">${safeEmail}</td></tr>
        <tr><td style="padding:8px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600;">공개 ID</td>
            <td style="padding:8px 12px;border:1px solid #e5e7eb;font-family:monospace;">${safeCode}</td></tr>
        <tr><td style="padding:8px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600;">연락처(끝4)</td>
            <td style="padding:8px 12px;border:1px solid #e5e7eb;font-family:monospace;">${safeLast4}</td></tr>
        <tr><td style="padding:8px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600;vertical-align:top;">사유</td>
            <td style="padding:8px 12px;border:1px solid #e5e7eb;white-space:pre-wrap;">${safeReason}</td></tr>
      </table>

      <p style="margin:20px 0;">
        <a href="${queueUrl}" style="display:inline-block;padding:10px 18px;background:#2563eb;color:#ffffff;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600;">승인 큐로 이동 →</a>
      </p>

      <p style="margin:14px 0 0 0;font-size:12px;color:#6b7280;">
        이 메일은 ${escapeHtml(BRAND_NAME)} 시스템이 발신 계정에서 자신에게 보낸
        승인 요청입니다. 신청자(${safeRequester}) 연락처가 CC 로 포함됩니다.
        ${contact ? `문의: <a href="mailto:${contact}" style="color:#2563eb;">${contact}</a>` : ""}
      </p>
    </div>
  `;

  const html = wrapEmailHtml(inner, { title: "블랙리스트 승인 요청" });
  const text =
    `[블랙리스트 승인 요청] 신청자: ${input.requesterName ?? "-"}\n` +
    `참여자: ${input.participantName ?? "-"} (${input.participantEmail ?? "-"})\n` +
    `공개 ID: ${input.participantPublicCode ?? "-"} · 끝4: ${input.phoneLast4 ?? "-"}\n` +
    `사유: ${input.reason}\n\n승인 큐: ${queueUrl}`;

  try {
    const cc = input.requesterContactEmail?.trim();
    const res = await sendEmail({
      to: self,
      cc: cc && /@/.test(cc) ? cc : undefined,
      subject: `[${BRAND_NAME}] 블랙리스트 승인 요청 — ${input.participantName ?? "(이름 없음)"}`,
      html,
      text,
    });
    if (!res.success) return { ok: false, error: res.error };
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "send threw",
    };
  }
}
