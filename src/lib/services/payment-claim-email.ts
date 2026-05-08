// Build the 행정 dispatch email — subject + HTML/text body + attachments
// — from a payment_claim row.
//
// Attachments are rebuilt on demand by re-fetching the payment_info rows
// pinned to the claim (regardless of their current status — typically
// 'claimed' at this stage) and replaying the same code path that
// generates the download bundle. This keeps a single source of truth for
// the form templates and the embedded signatures.
//
// Designed as preview-friendly: returns a typed payload the API can
// either ship to the frontend (preview mode) or hand to nodemailer's
// sendMail (confirm mode).

import { createAdminClient } from "@/lib/supabase/admin";
import { fetchClaimRowsByClaimId } from "@/lib/payments/claim-bundle";
import {
  buildIndividualFormWorkbook,
  buildUploadFormWorkbook,
  type ExportParticipant,
} from "@/lib/payments/excel";
import { type EmailAttachment } from "@/lib/google/gmail";
import JSZip from "jszip";

type Supabase = ReturnType<typeof createAdminClient>;

export interface PaymentClaimEmailPayload {
  to: string;
  // CC the researcher who triggered the dispatch so they have a record
  // in their own inbox + can forward / chase 행정 follow-ups directly.
  cc: string | null;
  replyTo: string | null;
  subject: string;
  html: string;
  text: string;
  attachments: EmailAttachment[];
  // Snapshot for the preview UI.
  meta: {
    researcherName: string;
    participantCount: number;
    totalKrw: number;
    periodLabel: string; // "2026.04.22~2026.05.06"
    participantNames: string[];
    attachmentNames: string[]; // for preview before serialization
  };
}

const SUBJECT = "실험참여자비 지급을 요청드립니다";

function safeFilename(raw: string): string {
  return (raw.trim() || "참가자")
    .replace(/[\\/:*?"<>|\r\n\t]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 80);
}

function fmtKoreanDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;
}

function fmtCompactDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const yy = d.getFullYear().toString().slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

function periodSpan(participants: ExportParticipant[]): {
  startIso: string | null;
  endIso: string | null;
  label: string;
} {
  let startIso: string | null = null;
  let endIso: string | null = null;
  for (const p of participants) {
    if (p.periodStart && (!startIso || p.periodStart < startIso)) {
      startIso = p.periodStart;
    }
    if (p.periodEnd && (!endIso || p.periodEnd > endIso)) {
      endIso = p.periodEnd;
    }
  }
  const startLabel = fmtKoreanDate(startIso);
  const endLabel = fmtKoreanDate(endIso);
  let label = "";
  if (startLabel && endLabel) {
    label = startLabel === endLabel ? startLabel : `${startLabel} ~ ${endLabel}`;
  } else if (startLabel) {
    label = startLabel;
  }
  return { startIso, endIso, label };
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildBody(args: {
  researcherName: string;
  periodLabel: string;
  count: number;
  totalKrw: number;
  participantNames: string[];
}): { html: string; text: string } {
  const { researcherName, periodLabel, count, totalKrw, participantNames } =
    args;
  const lead =
    periodLabel.length > 0
      ? `${periodLabel} 진행한 실험에 대하여 ${count}건의 실험참여자비를 지급요청드립니다.`
      : `${count}건의 실험참여자비를 지급요청드립니다.`;

  const text =
    [
      "안녕하세요 선생님,",
      "",
      `${researcherName} 연구원입니다.`,
      "",
      lead,
      "",
      `- 실험자: ${researcherName}`,
      `- 총 청구액: ${totalKrw.toLocaleString("ko-KR")}원`,
      `- 참여자: ${participantNames.join(", ")}`,
      "",
      "첨부 파일 안내:",
      "  ① 일회성경비지급자_업로드양식_작성_*.xlsx — 행정 일괄 업로드용",
      "  ② 실험참여자비 양식_*.xlsx — 참여자별 청구서 (서명 포함)",
      "  ③ 통장사본_*.zip — 참여자별 통장 사본 모음",
      "",
      "감사합니다.",
      `${researcherName} 올림`,
      "",
    ].join("\n");

  const html =
    `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;color:#111;line-height:1.7;font-size:14px;">` +
    `<p>안녕하세요 선생님,</p>` +
    `<p>${htmlEscape(researcherName)} 연구원입니다.</p>` +
    `<p>${htmlEscape(lead)}</p>` +
    `<table style="border-collapse:collapse;margin:12px 0;font-size:14px;">` +
    `<tr><td style="padding:4px 12px 4px 0;color:#666;">실험자</td><td style="padding:4px 0;"><strong>${htmlEscape(researcherName)}</strong></td></tr>` +
    `<tr><td style="padding:4px 12px 4px 0;color:#666;">총 청구액</td><td style="padding:4px 0;"><strong>${totalKrw.toLocaleString("ko-KR")}원</strong> (${count}건)</td></tr>` +
    `<tr><td style="padding:4px 12px 4px 0;color:#666;vertical-align:top;">참여자</td><td style="padding:4px 0;">${htmlEscape(participantNames.join(", "))}</td></tr>` +
    `</table>` +
    `<p style="margin-top:16px;color:#444;font-size:13px;">첨부 파일 안내:</p>` +
    `<ol style="margin:4px 0 16px 22px;padding:0;font-size:13px;color:#444;">` +
    `<li><strong>일회성경비지급자_업로드양식_작성_*.xlsx</strong> — 행정 일괄 업로드용</li>` +
    `<li><strong>실험참여자비 양식_*.xlsx</strong> — 참여자별 청구서 (서명 포함)</li>` +
    `<li><strong>통장사본_*.zip</strong> — 참여자별 통장 사본 모음</li>` +
    `</ol>` +
    `<p>감사합니다.<br/>${htmlEscape(researcherName)} 올림</p>` +
    `</body></html>`;

  return { html, text };
}

/**
 * Reconstruct the email payload (preview-ready) from a payment_claim id.
 * Throws if the claim is missing or has no payment_info rows.
 */
export async function buildPaymentClaimEmail(args: {
  supabase: Supabase;
  experimentId: string;
  claimId: string;
  recipientEmail: string;
  researcherName: string;
  researcherReplyEmail: string | null;
  // CC the researcher (their own work email — typically same as
  // researcherReplyEmail). Surfaced as a separate arg so the caller can
  // pass auth.users.email as a fallback when contact_email is unset.
  ccEmail: string | null;
  // When false → only build subject/body/meta, skip the (expensive)
  // attachment generation. The frontend uses this for the preview modal.
  includeAttachments: boolean;
}): Promise<PaymentClaimEmailPayload> {
  const {
    supabase,
    experimentId,
    claimId,
    recipientEmail,
    researcherName,
    researcherReplyEmail,
    ccEmail,
    includeAttachments,
  } = args;

  const { rows, exportParticipants, bankbookEntries } =
    await fetchClaimRowsByClaimId(supabase, experimentId, claimId, {
      withBankbooks: includeAttachments,
      withSignatures: includeAttachments,
    });

  if (rows.length === 0) {
    throw new Error("claim has no payment rows");
  }

  const { startIso, endIso, label: periodLabel } =
    periodSpan(exportParticipants);

  const totalKrw = exportParticipants.reduce((a, p) => a + p.amountKrw, 0);
  const participantNames = exportParticipants.map((p) => p.name);

  const { html, text } = buildBody({
    researcherName,
    periodLabel,
    count: exportParticipants.length,
    totalKrw,
    participantNames,
  });

  // For the attachment file naming we want a single yymmdd suffix that
  // captures the claim's date range. Use endIso (or startIso fallback)
  // since 행정 sorts by the latest experiment date in our convention.
  const datestamp =
    fmtCompactDate(endIso) || fmtCompactDate(startIso) || "";

  const attachments: EmailAttachment[] = [];
  const attachmentNames: string[] = [];

  if (includeAttachments) {
    // ① upload form — combined
    const uploadBuf = await buildUploadFormWorkbook(exportParticipants);
    const uploadName = datestamp
      ? `일회성경비지급자_업로드양식_작성_${datestamp}.xlsx`
      : `일회성경비지급자_업로드양식_작성.xlsx`;
    attachments.push({
      filename: uploadName,
      content: uploadBuf,
      contentType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    attachmentNames.push(uploadName);

    // ② per-participant forms
    const formNames = new Map<string, number>();
    const dedupe = (name: string): string => {
      const c = formNames.get(name) ?? 0;
      formNames.set(name, c + 1);
      if (c === 0) return name;
      const dot = name.lastIndexOf(".");
      return dot > 0
        ? `${name.slice(0, dot)} (${c + 1})${name.slice(dot)}`
        : `${name} (${c + 1})`;
    };
    for (const p of exportParticipants) {
      const buf = await buildIndividualFormWorkbook(p);
      const name = dedupe(`실험참여자비 양식_${safeFilename(p.name)}.xlsx`);
      attachments.push({
        filename: name,
        content: buf,
        contentType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      attachmentNames.push(name);
    }

    // ③ bankbooks (single nested zip — keeps the attachment count low for
    // mail clients that throttle on >10 attachments)
    if (bankbookEntries.length > 0) {
      const bankbookZip = new JSZip();
      const bankbookNames = new Map<string, number>();
      for (const { filename, bytes } of bankbookEntries) {
        const c = bankbookNames.get(filename) ?? 0;
        bankbookNames.set(filename, c + 1);
        const dotIdx = filename.lastIndexOf(".");
        const out =
          c === 0
            ? filename
            : dotIdx > 0
              ? `${filename.slice(0, dotIdx)} (${c + 1})${filename.slice(dotIdx)}`
              : `${filename} (${c + 1})`;
        bankbookZip.file(out, bytes);
      }
      const bbBuf = Buffer.from(
        await bankbookZip.generateAsync({
          type: "nodebuffer",
          compression: "DEFLATE",
          compressionOptions: { level: 6 },
        }),
      );
      const bbName = datestamp
        ? `통장사본_${datestamp}.zip`
        : `통장사본.zip`;
      attachments.push({
        filename: bbName,
        content: bbBuf,
        contentType: "application/zip",
      });
      attachmentNames.push(bbName);
    }
  } else {
    // Preview: surface the file names we WILL attach when confirmed,
    // without paying the rebuild cost. Names match what the send path
    // will produce.
    const uploadName = datestamp
      ? `일회성경비지급자_업로드양식_작성_${datestamp}.xlsx`
      : `일회성경비지급자_업로드양식_작성.xlsx`;
    attachmentNames.push(uploadName);
    for (const p of exportParticipants) {
      attachmentNames.push(`실험참여자비 양식_${safeFilename(p.name)}.xlsx`);
    }
    if (bankbookEntries.length > 0) {
      attachmentNames.push(
        datestamp ? `통장사본_${datestamp}.zip` : `통장사본.zip`,
      );
    }
  }

  return {
    to: recipientEmail,
    cc: ccEmail,
    replyTo: researcherReplyEmail,
    subject: SUBJECT,
    html,
    text,
    attachments,
    meta: {
      researcherName,
      participantCount: exportParticipants.length,
      totalKrw,
      periodLabel,
      participantNames,
      attachmentNames,
    },
  };
}
