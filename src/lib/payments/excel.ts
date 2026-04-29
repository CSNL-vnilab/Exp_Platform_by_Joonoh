import ExcelJS from "exceljs";
import { bytesFromSupabase, decryptRrn } from "@/lib/crypto/payment-info";
import { safeCellText } from "@/lib/payments/sanitize";

// ── Types ─────────────────────────────────────────────────────────────────

export interface ExportParticipant {
  participantId: string;
  bookingGroupId: string;
  name: string;
  email: string | null;
  // Korean mobile/landline as entered on the payment form (already
  // pre-formatted by the client). Optional because legacy rows pre-00050
  // don't have a snapshot.
  phone: string | null;
  // Raw ciphertext triple — decrypted here, never leaves the server.
  rrnCipher: unknown;
  rrnIv: unknown;
  rrnTag: unknown;
  rrnKeyVersion: number;
  bankName: string | null;
  accountNumber: string | null;
  accountHolder: string | null;
  // PNG bytes (already fetched from Storage).
  signaturePng: Buffer | null;
  periodStart: string | null; // YYYY-MM-DD
  periodEnd: string | null;
  amountKrw: number;
  participationHours: number; // total hours across all sessions
  institution: string;
  // For the period column in the individual form (e.g. "2026.03.19~03.20")
  activityDateSpan: string;
  // For the time cells (first session start/end; individual rows lose the
  // multi-session distinction in the admin's template — the hours column
  // captures total time)
  firstSessionStart: string | null; // "HH:MM"
  firstSessionEnd: string | null;
}

const DEFAULT_NATIONALITY = "대한민국";
const DEFAULT_INCOME_TYPE = "기타소득";
const DEFAULT_INCOME_DETAIL = "강연료 등 필요경비 있는 기타소득";

// ── Upload form (일회성경비지급자_업로드양식_작성.xlsx) ──────────────────
//
// Column layout (18 cols) follows lab_chore/app.py append_upload_row:
//   A  순번
//   B  성명
//   C  소속
//   D  주민등록번호 앞자리 (YYMMDD)
//   E  주민등록번호 뒷자리 (GSSSSSC)
//   F  =IF(H="대한민국","N","Y")   — 외국인 여부
//   G  여권번호 (내국인 공란)
//   H  국적                          (default "대한민국")
//   I  소득구분                      (default "기타소득")
//   J  소득구분 상세                 (default "강연료 등 필요경비 있는 기타소득")
//   K  지급액
//   L  계좌번호
//   M  은행명
//   N  예금주
//   O..R  출장경비 4컬럼 (0,0,0,0)
//
// Rows 1–2: header (we emulate a minimal header since we don't load the
// admin's template).
// Row 3+ : data rows
// Last row: "END" marker in column A.

export async function buildUploadFormWorkbook(
  participants: ExportParticipant[],
): Promise<ExcelJS.Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Exp_Platform";
  wb.created = new Date();
  const ws = wb.addWorksheet("Sheet1");

  const headers1 = [
    "순번", "성명", "소속",
    "주민등록번호 앞자리", "주민등록번호 뒷자리",
    "외국인여부", "여권번호", "국적",
    "소득구분", "소득구분 상세", "지급액",
    "계좌번호", "은행명", "예금주",
    "출장경비1", "출장경비2", "출장경비3", "출장경비4",
  ];
  ws.addRow(headers1);
  ws.addRow([]); // row 2 — second header row in the admin's template
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { horizontal: "center", vertical: "middle" };

  participants.forEach((p, idx) => {
    const seq = idx + 1;
    const rrn = decryptRrnFromExport(p);
    const [jidFront, jidBack] = splitRrn(rrn);
    // Every user-controlled text goes through safeCellText to neutralize
    // Excel / CSV formula injection (leading =, +, -, @, tab, CR). RRN
    // digits are numeric-only by validator contract, so they're safe.
    const row = ws.addRow([
      seq,
      safeCellText(p.name),
      safeCellText(p.institution),
      jidFront,
      jidBack,
      { formula: `IF(H${idx + 3}="${DEFAULT_NATIONALITY}","N","Y")` },
      "",
      DEFAULT_NATIONALITY,
      DEFAULT_INCOME_TYPE,
      DEFAULT_INCOME_DETAIL,
      p.amountKrw,
      safeCellText(p.accountNumber ?? ""),
      safeCellText(p.bankName ?? ""),
      safeCellText(p.accountHolder ?? p.name),
      0, 0, 0, 0,
    ]);
    // Borders + center align for each data cell — matches the admin's
    // template feel even without loading it directly.
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.border = {
        top: { style: "thin", color: { argb: "FFE5E7EB" } },
        left: { style: "thin", color: { argb: "FFE5E7EB" } },
        bottom: { style: "thin", color: { argb: "FFE5E7EB" } },
        right: { style: "thin", color: { argb: "FFE5E7EB" } },
      };
      cell.alignment = { vertical: "middle" };
    });
  });

  // END marker so the admin tool's find_end_row() keeps working if it ever
  // consumes our output.
  ws.addRow(["END"]);

  // Column widths roughly matching the Python output.
  ws.columns = [
    { width: 6 },  { width: 10 }, { width: 14 }, { width: 10 }, { width: 12 },
    { width: 10 }, { width: 12 }, { width: 10 }, { width: 12 }, { width: 34 },
    { width: 10 }, { width: 18 }, { width: 12 }, { width: 10 },
    { width: 10 }, { width: 10 }, { width: 10 }, { width: 10 },
  ];

  return wb.xlsx.writeBuffer();
}

// ── Individual form (실험참여자비 양식_이름.xlsx) ─────────────────────────
//
// The admin's template (실험참여자비 양식(중견).xlsx) is not bundled with
// this app — researchers keep their copy under their paperwork folder.
// We emit a compatible "surface form" populating the same cells the lab
// tool's read_participant_info() expects, so the two are interchangeable
// in a pinch:
//   C10 — 활용일자
//   G10 — 시작 시간
//   I10 — 종료 시간
//   B11 — 총 참여 시간
//   B13 — 연락처 (added 2026-04 — row 13 is unused in lab_chore's
//          read_participant_info, so adding a value here is non-breaking)
//   B16 — 성명
//   D16 — 소속
//   E16 — 주민등록번호
//   F16 — 이메일
//   G16 — 은행명
//   I16 — 계좌번호
//   L16 — 예금주
//   D19 — 지급액
//   B17 — 전자서명 image anchor (160 × 55 px)
//
// Visual layout (logos / heading / section banners) is NOT reproduced —
// for the fully-formatted admin-submittable copy, researchers should keep
// using the lab_chore GUI with their original template file, or upload
// that template into this repo under src/lib/payments/templates/ and
// switch buildIndividualFormWorkbook to ExcelJS.xlsx.load(template).

export async function buildIndividualFormWorkbook(
  p: ExportParticipant,
): Promise<ExcelJS.Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Exp_Platform";
  wb.created = new Date();
  const ws = wb.addWorksheet("실험참여자비");

  // Title banner
  ws.mergeCells("A1:L2");
  const title = ws.getCell("A1");
  title.value = "실험참여자비 청구서";
  title.font = { size: 16, bold: true };
  title.alignment = { horizontal: "center", vertical: "middle" };

  // Activity info row (row 10 so C10/G10/I10 hit the admin tool's cells)
  ws.getCell("A10").value = "활용일자";
  ws.getCell("A10").font = { bold: true };
  ws.getCell("C10").value = p.activityDateSpan;
  ws.getCell("F10").value = "시작";
  ws.getCell("F10").font = { bold: true };
  ws.getCell("G10").value = p.firstSessionStart ?? "";
  ws.getCell("H10").value = "종료";
  ws.getCell("H10").font = { bold: true };
  ws.getCell("I10").value = p.firstSessionEnd ?? "";

  ws.getCell("A11").value = "총 참여시간";
  ws.getCell("A11").font = { bold: true };
  ws.getCell("B11").value = p.participationHours;
  ws.getCell("C11").value = "시간";

  // Row 13 — 연락처 (lab_chore's reader doesn't touch this row, so the
  // admin still gets a clean read; we just surface the phone for the
  // human checking the form).
  ws.getCell("A13").value = "연락처";
  ws.getCell("A13").font = { bold: true };
  ws.getCell("B13").value = safeCellText(p.phone ?? "");

  // Section header row 15
  ws.getCell("A15").value = "수령인 정보";
  ws.getCell("A15").font = { bold: true };
  ws.mergeCells("A15:L15");

  // Row 16 — the admin tool's read_participant_info picks these up.
  // User-controlled strings go through safeCellText (Excel formula guard).
  ws.getCell("A16").value = "성명";
  ws.getCell("A16").font = { bold: true };
  ws.getCell("B16").value = safeCellText(p.name);
  ws.getCell("C16").value = "소속";
  ws.getCell("C16").font = { bold: true };
  ws.getCell("D16").value = safeCellText(p.institution);
  ws.getCell("E16").value = decryptRrnFromExport(p);
  ws.getCell("F16").value = safeCellText(p.email ?? "");
  ws.getCell("G16").value = safeCellText(p.bankName ?? "");
  ws.getCell("H16").value = "계좌";
  ws.getCell("H16").font = { bold: true };
  ws.getCell("I16").value = safeCellText(p.accountNumber ?? "");
  ws.getCell("K16").value = "예금주";
  ws.getCell("K16").font = { bold: true };
  ws.getCell("L16").value = safeCellText(p.accountHolder ?? p.name);

  ws.getCell("A18").value = "수령인 서명";
  ws.getCell("A18").font = { bold: true };

  // Signature image anchored at B17 (matches lab_chore xl_img.anchor = "B17")
  if (p.signaturePng && p.signaturePng.length > 0) {
    const imageId = wb.addImage({
      buffer: p.signaturePng as unknown as ArrayBuffer,
      extension: "png",
    });
    ws.addImage(imageId, {
      tl: { col: 1, row: 16 }, // B17 (0-indexed → col 1, row 16)
      ext: { width: 160, height: 55 },
      editAs: "oneCell",
    });
  }

  // Amount row
  ws.getCell("A19").value = "지급액";
  ws.getCell("A19").font = { bold: true };
  ws.getCell("D19").value = p.amountKrw;
  ws.getCell("D19").numFmt = "#,##0";
  ws.getCell("E19").value = "원";

  // Column widths (loose approximation)
  const widths = [10, 12, 10, 16, 14, 10, 10, 10, 14, 10, 10, 10];
  ws.columns = widths.map((w) => ({ width: w }));

  // Row heights — give row 17 enough to hold the signature image
  ws.getRow(17).height = 40;

  return wb.xlsx.writeBuffer();
}

// ── Helpers ───────────────────────────────────────────────────────────────

function decryptRrnFromExport(p: ExportParticipant): string {
  const cipher = bytesFromSupabase(p.rrnCipher);
  const iv = bytesFromSupabase(p.rrnIv);
  const tag = bytesFromSupabase(p.rrnTag);
  if (cipher.length === 0 || iv.length === 0 || tag.length === 0) return "";
  try {
    return decryptRrn({ cipher, iv, tag, keyVersion: p.rrnKeyVersion });
  } catch (err) {
    console.error(
      `[PaymentExport] RRN decrypt failed for ${p.bookingGroupId}:`,
      err instanceof Error ? err.message : err,
    );
    return "";
  }
}

function splitRrn(rrn: string): [string, string] {
  const digits = rrn.replace(/\D/g, "");
  if (digits.length >= 13) {
    return [digits.slice(0, 6), digits.slice(6, 13)];
  }
  if (rrn.includes("-")) {
    const [a, b] = rrn.split("-");
    return [a?.trim() ?? "", b?.trim() ?? ""];
  }
  return [digits, ""];
}

export function formatDateSpan(
  startIso: string | null,
  endIso: string | null,
): string {
  if (!startIso) return "";
  const s = new Date(startIso);
  if (!endIso) {
    return `${s.getFullYear()}.${pad(s.getMonth() + 1)}.${pad(s.getDate())}`;
  }
  const e = new Date(endIso);
  const sameYear = s.getFullYear() === e.getFullYear();
  const sameMonth = sameYear && s.getMonth() === e.getMonth();
  const sameDay = sameMonth && s.getDate() === e.getDate();
  // Same calendar day → single date, no range suffix (matches lab_chore's
  // placeholder "2026.03.19"). Cross-day / cross-month / cross-year all
  // render with "~".
  if (sameDay) {
    return `${s.getFullYear()}.${pad(s.getMonth() + 1)}.${pad(s.getDate())}`;
  }
  if (sameMonth) {
    return `${s.getFullYear()}.${pad(s.getMonth() + 1)}.${pad(s.getDate())}~${pad(e.getDate())}`;
  }
  if (sameYear) {
    return `${s.getFullYear()}.${pad(s.getMonth() + 1)}.${pad(s.getDate())}~${pad(e.getMonth() + 1)}.${pad(e.getDate())}`;
  }
  return `${s.getFullYear()}.${pad(s.getMonth() + 1)}.${pad(s.getDate())}~${e.getFullYear()}.${pad(e.getMonth() + 1)}.${pad(e.getDate())}`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}
