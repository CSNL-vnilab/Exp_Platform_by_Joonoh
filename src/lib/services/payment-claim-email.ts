// Build the 행정 dispatch email — subject + HTML/text body + attachments
// — from a payment_claim row.
//
// Attachments are rebuilt on demand by re-fetching the payment_info rows
// pinned to the claim (regardless of their current status — typically
// 'claimed' at this stage) and replaying the same code path that
// generates the download bundle. This keeps a single source of truth for
// the form templates, the per-participant 지급신청서 PDF, and the
// embedded signatures.
//
// Designed as preview-friendly: returns a typed payload the API can
// either ship to the frontend (preview mode) or hand to nodemailer's
// sendMail (confirm mode).
//
// The four artifacts the 행정 office expects (and the email now ships):
//   ① 일회성경비지급자 업로드양식 (xlsx, 1+ files, 7 참여자/파일)
//   ② 실험참여자비 양식        (xlsx × N, 서명 포함)
//   ③ 연구참여비 지급신청서     (PDF × N, 무서명 — 회차/날짜/이름/생년월일)
//   ④ 통장사본                 (zip, 참여자별 스캔 모음)

import { createAdminClient } from "@/lib/supabase/admin";
import {
  fetchClaimRowsByClaimId,
  buildResearchPaymentRequestData,
  safeFilename,
} from "@/lib/payments/claim-bundle";
import {
  buildIndividualFormWorkbook,
  buildUploadFormWorkbooks,
  type ExportParticipant,
} from "@/lib/payments/excel";
import { generateResearchPaymentRequestPdf } from "@/lib/payments/template-filler";
import { type EmailAttachment } from "@/lib/google/gmail";
import JSZip from "jszip";

type Supabase = ReturnType<typeof createAdminClient>;

// Gmail rejects messages over ~25 MB. base64 transfer-encoding inflates
// raw bytes by ~37%, so cap the summed RAW attachment bytes at 18 MB
// (18 * 1.37 ≈ 24.7 MB on the wire). Over this we refuse to send and the
// route surfaces a 413 telling the researcher to download the ZIP and
// send it manually — far better than an opaque SMTP "message too large".
const MAX_ATTACHMENT_BYTES = 18 * 1024 * 1024;

export class PaymentEmailTooLargeError extends Error {
  readonly totalBytes: number;
  readonly limitBytes: number;
  readonly attachments: Array<{ filename: string; bytes: number }>;
  constructor(
    totalBytes: number,
    attachments: Array<{ filename: string; bytes: number }>,
  ) {
    super(
      `payment claim attachments total ${totalBytes} bytes, over the ${MAX_ATTACHMENT_BYTES}-byte email limit`,
    );
    this.name = "PaymentEmailTooLargeError";
    this.totalBytes = totalBytes;
    this.limitBytes = MAX_ATTACHMENT_BYTES;
    this.attachments = attachments;
  }
}

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

// period_start / period_end are DATE columns → "YYYY-MM-DD" strings. Parse
// the date prefix by slicing, never `new Date(iso)` + local getters
// (Vercel runs UTC today, but a server west of UTC would render the day
// one behind).
function parseYmd(iso: string | null): { y: number; mo: number; d: number } | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) };
}

function fmtKoreanDate(iso: string | null): string {
  const p = parseYmd(iso);
  if (!p) return "";
  return `${p.y}년 ${p.mo}월 ${p.d}일`;
}

function fmtCompactDate(iso: string | null): string {
  const p = parseYmd(iso);
  if (!p) return "";
  const yy = String(p.y).slice(-2);
  const mm = String(p.mo).padStart(2, "0");
  const dd = String(p.d).padStart(2, "0");
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

// Group the flat attachment filenames into the four 행정 categories, in
// dispatch order (①②③④). Derived from attachmentNames so the body list
// can never drift from what is actually attached.
function buildAttachmentGuide(
  names: string[],
): Array<{ label: string; note: string }> {
  const count = (prefix: string) =>
    names.filter((n) => n.startsWith(prefix)).length;
  const out: Array<{ label: string; note: string }> = [];
  const upload = count("일회성경비지급자");
  if (upload > 0) {
    out.push({
      label: `일회성경비지급자 업로드양식${upload > 1 ? ` (${upload}개 파일)` : ""}`,
      note: "행정 일괄 업로드용",
    });
  }
  const forms = count("실험참여자비");
  if (forms > 0) {
    out.push({
      label: `실험참여자비 양식 (${forms}건)`,
      note: "참여자별 청구서 (서명 포함)",
    });
  }
  const pdfs = count("연구참여비_지급신청서");
  if (pdfs > 0) {
    out.push({
      label: `연구참여비 지급신청서 (${pdfs}건)`,
      note: "참여자별 지급신청서 (회차·날짜·이름·생년월일)",
    });
  }
  const bankbooks = count("통장사본");
  if (bankbooks > 0) {
    out.push({ label: "통장사본", note: "참여자별 통장 사본 모음" });
  }
  return out;
}

function buildBody(args: {
  researcherName: string;
  periodLabel: string;
  count: number;
  totalKrw: number;
  participantNames: string[];
  attachmentNames: string[];
}): { html: string; text: string } {
  const {
    researcherName,
    periodLabel,
    count,
    totalKrw,
    participantNames,
    attachmentNames,
  } = args;
  const lead =
    periodLabel.length > 0
      ? `${periodLabel} 진행한 실험에 대하여 ${count}건의 실험참여자비를 지급요청드립니다.`
      : `${count}건의 실험참여자비를 지급요청드립니다.`;

  const guide = buildAttachmentGuide(attachmentNames);
  const circled = ["①", "②", "③", "④", "⑤", "⑥"];

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
      ...guide.map(
        (g, i) => `  ${circled[i] ?? `${i + 1}.`} ${g.label} — ${g.note}`,
      ),
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
    guide
      .map(
        (g) =>
          `<li><strong>${htmlEscape(g.label)}</strong> — ${htmlEscape(g.note)}</li>`,
      )
      .join("") +
    `</ol>` +
    `<p>감사합니다.<br/>${htmlEscape(researcherName)} 올림</p>` +
    `</body></html>`;

  return { html, text };
}

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// Filename dedupe: two participants sharing a 이름 get distinct filenames.
// One map instance per filename family so "실험참여자비 양식_홍길동.xlsx"
// and "연구참여비_지급신청서_홍길동.pdf" number independently.
function makeDedupe(): (name: string) => string {
  const used = new Map<string, number>();
  return (name: string): string => {
    const c = used.get(name) ?? 0;
    used.set(name, c + 1);
    if (c === 0) return name;
    const dot = name.lastIndexOf(".");
    return dot > 0
      ? `${name.slice(0, dot)} (${c + 1})${name.slice(dot)}`
      : `${name} (${c + 1})`;
  };
}

function uploadFormName(datestamp: string, idx: number, total: number): string {
  const base = datestamp
    ? `일회성경비지급자_업로드양식_작성_${datestamp}`
    : `일회성경비지급자_업로드양식_작성`;
  return total === 1 ? `${base}.xlsx` : `${base}_${idx + 1}.xlsx`;
}

/**
 * Reconstruct the email payload (preview-ready) from a payment_claim id.
 * Throws if the claim is missing or has no payment_info rows. Throws
 * PaymentEmailTooLargeError when the built attachments exceed the mail
 * size cap (send mode only).
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

  const { rows, exportParticipants, bankbookEntries, hasBankbooks } =
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

  // For the attachment file naming we want a single yymmdd suffix that
  // captures the claim's date range. Use endIso (or startIso fallback)
  // since 행정 sorts by the latest experiment date in our convention.
  const datestamp = fmtCompactDate(endIso) || fmtCompactDate(startIso) || "";

  const attachments: EmailAttachment[] = [];
  const attachmentNames: string[] = [];

  // Names must match EXACTLY between preview and send. The counting logic
  // below is shared: we always know the participant count and (in send
  // mode) the number of upload-form chunks; in preview we compute the
  // chunk count from participant count without building the workbooks.
  const UPLOAD_ROWS_PER_FILE = 7;
  const uploadChunkCount = Math.max(
    1,
    Math.ceil(exportParticipants.length / UPLOAD_ROWS_PER_FILE),
  );
  const formDedupe = makeDedupe();
  const pdfDedupe = makeDedupe();

  if (includeAttachments) {
    // ① upload form(s) — one per chunk of 7 participants.
    const uploadBufs = await buildUploadFormWorkbooks(exportParticipants);
    uploadBufs.forEach((buf, idx) => {
      const name = uploadFormName(datestamp, idx, uploadBufs.length);
      attachments.push({ filename: name, content: buf, contentType: XLSX_MIME });
      attachmentNames.push(name);
    });

    // ② per-participant 실험참여자비 양식 (xlsx, signature embedded).
    for (const p of exportParticipants) {
      const buf = await buildIndividualFormWorkbook(p);
      const name = formDedupe(`실험참여자비 양식_${safeFilename(p.name)}.xlsx`);
      attachments.push({ filename: name, content: buf, contentType: XLSX_MIME });
      attachmentNames.push(name);
    }

    // ③ per-participant 연구참여비 지급신청서 (PDF, no signature —
    //    회차/날짜/이름/생년월일). Built from the same shared reqData
    //    helper as the ZIP-download path so the two never drift. A single
    //    fill failure degrades to skipping that one PDF rather than
    //    aborting the whole dispatch.
    for (let i = 0; i < exportParticipants.length; i++) {
      const p = exportParticipants[i];
      const r = rows[i];
      try {
        const pdfBuf = await generateResearchPaymentRequestPdf(
          buildResearchPaymentRequestData(p, r),
        );
        const name = pdfDedupe(
          `연구참여비_지급신청서_${safeFilename(p.name)}.pdf`,
        );
        attachments.push({
          filename: name,
          content: pdfBuf,
          contentType: "application/pdf",
        });
        attachmentNames.push(name);
      } catch (err) {
        console.error(
          `[PaymentClaimEmail] 지급신청서 PDF gen failed for ${p.bookingGroupId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    // ④ bankbooks (single nested zip — keeps the attachment count low for
    //    mail clients that throttle on >10 attachments).
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
      const bbName = datestamp ? `통장사본_${datestamp}.zip` : `통장사본.zip`;
      attachments.push({
        filename: bbName,
        content: bbBuf,
        contentType: "application/zip",
      });
      attachmentNames.push(bbName);
    }

    // Size preflight (B11): refuse to send an over-cap message; the route
    // turns this into a 413 with the per-file breakdown.
    const totalBytes = attachments.reduce(
      (a, at) => a + Buffer.byteLength(at.content),
      0,
    );
    if (totalBytes > MAX_ATTACHMENT_BYTES) {
      throw new PaymentEmailTooLargeError(
        totalBytes,
        attachments.map((at) => ({
          filename: at.filename,
          bytes: Buffer.byteLength(at.content),
        })),
      );
    }
  } else {
    // Preview: surface the file names we WILL attach when confirmed,
    // without paying the rebuild cost. Names + dedupe MUST match the send
    // path exactly (same makeDedupe order, same chunk count).
    for (let idx = 0; idx < uploadChunkCount; idx++) {
      attachmentNames.push(uploadFormName(datestamp, idx, uploadChunkCount));
    }
    for (const p of exportParticipants) {
      attachmentNames.push(
        formDedupe(`실험참여자비 양식_${safeFilename(p.name)}.xlsx`),
      );
    }
    for (const p of exportParticipants) {
      attachmentNames.push(
        pdfDedupe(`연구참여비_지급신청서_${safeFilename(p.name)}.pdf`),
      );
    }
    // hasBankbooks (from the row-level bankbook_path check) — preview
    // mode skips the storage download, so bankbookEntries is always empty
    // there. Use hasBankbooks to honestly preview what the send path will
    // include.
    if (hasBankbooks) {
      attachmentNames.push(
        datestamp ? `통장사본_${datestamp}.zip` : `통장사본.zip`,
      );
    }
  }

  const { html, text } = buildBody({
    researcherName,
    periodLabel,
    count: exportParticipants.length,
    totalKrw,
    participantNames,
    attachmentNames,
  });

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
