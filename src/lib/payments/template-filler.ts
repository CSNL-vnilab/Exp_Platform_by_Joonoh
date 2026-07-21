// JSZip + cell-level XML rewrite for payment-claim xlsx outputs.
//
// Why not ExcelJS? exceljs.xlsx.load → writeBuffer round-trips strip
// xl/ctrlProps/* (form-control checkboxes), xl/drawings/*, xl/externalLinks/*,
// and xl/printerSettings/*.bin. The lab's 행정 office rejects forms that
// have lost the printer page-setup and the consent-form checkboxes — exactly
// what we hit on a 43KB → 18KB load+save cycle.
//
// This module instead opens the .xlsx as a zip, mutates only cells inside
// xl/worksheets/sheet1.xml in-place, and rewrites that one entry. Every
// other archive member (styles, themes, drawings, ctrlProps, externalLinks,
// printerSettings, calcChain, the second sheet "업로드 양식 유효성 검사 기준")
// passes through byte-for-byte.

import { readFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { isCoveredByPaymentFont } from "@/lib/payments/payment-font-coverage";

const TEMPLATE_DIR = path.join(
  process.cwd(),
  "src",
  "lib",
  "payments",
  "templates",
);

export type CellValue =
  | { kind: "str"; value: string }
  | { kind: "num"; value: number }
  | { kind: "time"; hours: number; minutes: number };

// Cache file buffers so a 30-participant bundle reads each template once.
const templateCache = new Map<string, Buffer>();

async function loadTemplate(name: string): Promise<Buffer> {
  const cached = templateCache.get(name);
  if (cached) return cached;
  const buf = await readFile(path.join(TEMPLATE_DIR, name));
  templateCache.set(name, buf);
  return buf;
}

export async function loadIndividualTemplate(): Promise<Buffer> {
  return loadTemplate("individual-template.xlsx");
}

export async function loadUploadTemplate(): Promise<Buffer> {
  return loadTemplate("upload-template.xlsx");
}

export async function loadResearchPaymentRequestTemplate(): Promise<Buffer> {
  return loadTemplate("research-payment-request-template.docx");
}

// ── XML helpers ────────────────────────────────────────────────────────

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Match <c r="REF" ...> ... </c> or <c r="REF" ... /> for a specific ref.
// xlsx <c> elements never nest, so the minimal `>[\s\S]*?</c>` is safe.
function cellRegex(ref: string): RegExp {
  return new RegExp(
    `<c\\s+r="${ref}"([^/>]*?)(?:\\s*/>|>(?:[^<]|<[^/]|</[^c])*?</c>)`,
  );
}

function buildCell(ref: string, styleAttr: string, value: CellValue): string {
  if (value.kind === "str") {
    // Inline string ⇒ avoid touching sharedStrings.xml. Excel handles
    // t="inlineStr" identically for display.
    return `<c r="${ref}"${styleAttr} t="inlineStr"><is><t xml:space="preserve">${escapeXml(
      value.value,
    )}</t></is></c>`;
  }
  if (value.kind === "num") {
    return `<c r="${ref}"${styleAttr}><v>${value.value}</v></c>`;
  }
  // Time: Excel stores times as fractions of a day. The cell's existing
  // numFmt (preserved via the s= attribute) handles HH:MM rendering.
  const fraction =
    (Math.max(0, value.hours) * 3600 + Math.max(0, value.minutes) * 60) /
    86400;
  return `<c r="${ref}"${styleAttr}><v>${fraction}</v></c>`;
}

// Replace the single <c r="REF"…> in xml. Preserves the existing s= style
// attribute so the cell keeps its borders / font / numFmt from the
// template. Any t= or <v>/<f>/<is> child gets discarded — the template's
// formula in F (=IF(H="대한민국",…)) is not a target of this replacer; we
// build that cell ourselves when generating the upload form.
function replaceCell(
  xml: string,
  ref: string,
  value: CellValue,
): string {
  const re = cellRegex(ref);
  const match = re.exec(xml);
  if (!match) return xml;
  const attrs = match[1] ?? "";
  const sMatch = attrs.match(/\s+s="([^"]+)"/);
  const styleAttr = sMatch ? ` s="${sMatch[1]}"` : "";
  return xml.replace(match[0], buildCell(ref, styleAttr, value));
}

function replaceCells(
  xml: string,
  cells: Record<string, CellValue>,
): string {
  let out = xml;
  for (const [ref, value] of Object.entries(cells)) {
    out = replaceCell(out, ref, value);
  }
  return out;
}

// Update ONLY the cached `<v>` of an existing formula cell, leaving the
// `<f>` and `s=` attribute intact. Needed because the individual-form
// template ships formula cells (K10 = I10 - G10; AD10 = AB10 - Z10) with
// stale cached values (0.125 and 0, the template defaults). Excel's
// calcPr usually recomputes on open, but when calcOnLoad is unset some
// older Excel/Numbers builds display the stale cache instead — the
// 행정 office reported "활용시간 계산이 1시간이 아닌 다른 값으로 보이는"
// case (2026-06-10). Updating the cache here makes the displayed value
// correct regardless of the consumer's calc settings, while preserving
// the formula so manual edits to G10/I10 still recompute downstream.
function updateFormulaCacheValue(
  xml: string,
  ref: string,
  newValue: number,
): string {
  // Match `<c r="REF" s="..." ...><f...>...</f><v>...</v></c>` and replace
  // the `<v>` portion only.
  const re = new RegExp(
    `(<c\\s+r="${ref}"[^>]*?>\\s*<f[^>]*>[^<]*</f>\\s*<v>)([^<]*)(</v>\\s*</c>)`,
  );
  const m = re.exec(xml);
  if (!m) return xml;
  return xml.replace(re, `$1${newValue}$3`);
}

// Replace whole <row r="N" …>…</row> elements wholesale. Used for the
// upload form where we rewrite each data row from scratch (cells include
// formulas + styles inferred from the template's row 3 sample).
function replaceRow(xml: string, rowNum: number, replacement: string): string {
  const re = new RegExp(`<row\\s+r="${rowNum}"[^>]*>[\\s\\S]*?</row>`, "g");
  if (re.test(xml)) {
    return xml.replace(re, replacement);
  }
  // Row didn't exist — insert before </sheetData>. Cells must be in row
  // order, so we splice based on the next existing row.
  const sheetDataClose = xml.lastIndexOf("</sheetData>");
  if (sheetDataClose < 0) return xml;
  return (
    xml.slice(0, sheetDataClose) + replacement + xml.slice(sheetDataClose)
  );
}

// ── Public API ─────────────────────────────────────────────────────────

export interface IndividualFormData {
  name: string;
  institution: string;
  rrn: string; // raw "YYMMDDXXXXXXX" or formatted "YYMMDD-XXXXXXX"
  email: string | null;
  phone: string | null; // currently not surfaced — template has no slot
  bankName: string | null;
  accountNumber: string | null;
  accountHolder: string | null;
  amountKrw: number;
  experimentTitle: string | null; // overrides template's pre-filled "인지행동실험"
  // Period covered (for "활용일자" row 10) — preformatted by caller, e.g.
  // "2026.03.06~03.12".
  activityDateSpan: string;
  // 방문 시간 (visit time) — 2026-06-10 user directive switched this from
  // FIRST session to the participant's LAST attended session, so the form
  // reflects when they actually finished the study.
  lastSessionStart: { hours: number; minutes: number } | null;
  lastSessionEnd: { hours: number; minutes: number } | null;
  // Session count for B11 (and English mirror AB10). 2026-06-10 directive:
  // the "시간/회당/장" cell now shows N회 (sessions) instead of total hours
  // — paired with the D11 unit toggle flipping from "시간" to "회".
  sessionCount: number;
  // 목적 / 활용내용 (row 13 B-side). Auto-set per user directive to
  // "지각적 의사결정 오프라인 실험 참여"; caller may override.
  purpose: string;
  // Location name (e.g. "649호"). Overrides the template default at L11
  // when the experiment runs in a different room.
  locationName?: string | null;
  // Signature PNG bytes. When supplied, embedded into xl/media/ and
  // anchored to B17:C17 inside the workbook's existing drawing1.xml.
  // Falsy → leave the template's "(수령인 서명)" placeholder text
  // untouched (researcher can sign on print).
  signaturePng?: Buffer | null;
}

export async function fillIndividualForm(
  data: IndividualFormData,
): Promise<Buffer> {
  const templateBuf = await loadIndividualTemplate();
  const zip = await JSZip.loadAsync(templateBuf);

  const sheetEntry = zip.file("xl/worksheets/sheet1.xml");
  if (!sheetEntry) {
    throw new Error("individual-template.xlsx missing xl/worksheets/sheet1.xml");
  }
  let xml = await sheetEntry.async("text");

  const updates: Record<string, CellValue> = {
    // 활용일자 — period span
    C10: { kind: "str", value: data.activityDateSpan },
    // 활용시간 — start/end (template numFmt: h:mm). 2026-06-10: LAST session.
    ...(data.lastSessionStart && {
      G10: {
        kind: "time",
        hours: data.lastSessionStart.hours,
        minutes: data.lastSessionStart.minutes,
      } satisfies CellValue,
    }),
    ...(data.lastSessionEnd && {
      I10: {
        kind: "time",
        hours: data.lastSessionEnd.hours,
        minutes: data.lastSessionEnd.minutes,
      } satisfies CellValue,
    }),
    // 시간/회당/장 — session count (dropdown D11 flipped from "시간" → "회").
    B11: { kind: "num", value: data.sessionCount },
    // D11 unit dropdown options: "시간,회,장,words" — set to "회".
    D11: { kind: "str", value: "회" },
    // 구분 (K9:L9 merged dropdown, options "내국인, 외국인") — recipient
    // is a domestic experiment participant (default 내국인 per 2026-06-10
    // directive; foreign-national overrides handled by the researcher).
    K9: { kind: "str", value: "내국인" },
    // 대면/비대면 (G9 dropdown, options "대면, 비대면") — default 대면
    // for offline experiments (2026-06-10 follow-up). The 비대면 case
    // applies to online-runtime experiments which don't use this form.
    G9: { kind: "str", value: "대면" },
    // 직급/직위 (G11:I11 merged dropdown, options "연구책임자 급,연구자 급")
    // — set to "연구자 급" per 2026-06-10 directive. Picking a value that
    // matches one of the formula1 options keeps Excel's data-validation
    // green-tick intact.
    G11: { kind: "str", value: "연구자 급" },
    // 목적 / 활용내용 (row 13, merged B13:L13). Auto-fill per directive.
    B13: { kind: "str", value: data.purpose },
    // 장소 — override template's "649호" when the experiment ran elsewhere
    ...(data.locationName && {
      L11: { kind: "str", value: data.locationName } satisfies CellValue,
    }),
    // 제목 — override template's "인지행동실험" with experiment-specific
    ...(data.experimentTitle && {
      B12: { kind: "str", value: data.experimentTitle } satisfies CellValue,
    }),
    // Row 16 — 인적사항 + 계좌이체정보
    B16: { kind: "str", value: data.name },
    D16: { kind: "str", value: data.institution },
    E16: { kind: "str", value: data.rrn },
    F16: { kind: "str", value: data.email ?? "" },
    G16: { kind: "str", value: data.bankName ?? "" },
    I16: { kind: "str", value: data.accountNumber ?? "" },
    L16: { kind: "str", value: data.accountHolder ?? data.name },
    // Row 19 — 활용비 (matches template's =D19+F19+G19+I19+K19 sum formula
    // in L19; we leave the formula alone and only set D19).
    D19: { kind: "num", value: data.amountKrw },
  };

  // English-side mirror so the bilingual form is internally consistent
  // (admins occasionally cross-check). The English columns mirror the
  // Korean side at the same row.
  Object.assign(updates, {
    U10: { kind: "str", value: data.activityDateSpan },
    ...(data.lastSessionStart && {
      W10: {
        kind: "time",
        hours: data.lastSessionStart.hours,
        minutes: data.lastSessionStart.minutes,
      } satisfies CellValue,
    }),
    ...(data.lastSessionEnd && {
      Z10: {
        kind: "time",
        hours: data.lastSessionEnd.hours,
        minutes: data.lastSessionEnd.minutes,
      } satisfies CellValue,
    }),
    AB10: { kind: "num", value: data.sessionCount },
    // English unit toggle (W11 dropdown: "hour(s),time(s),sheet(s),words")
    // mirrors the Korean "회" selection.
    W11: { kind: "str", value: "time(s)" },
    // English Position toggle (Z11:AB11 dropdown:
    // "Superior(Senior),Junior(Assistant)") mirrors Korean G11 "연구자 급"
    // → "Junior(Assistant)".
    Z11: { kind: "str", value: "Junior(Assistant)" },
    // English 대면/비대면 mirror (Z9 dropdown: "contact,untact") →
    // "contact" for offline experiments.
    Z9: { kind: "str", value: "contact" },
    U16: { kind: "str", value: data.name },
    W16: { kind: "str", value: data.institution },
    Y16: { kind: "str", value: data.email ?? "" },
    Z16: { kind: "str", value: data.bankName ?? "" },
    AB16: { kind: "str", value: data.accountNumber ?? "" },
    AE16: { kind: "str", value: data.accountHolder ?? data.name },
    W19: { kind: "num", value: data.amountKrw },
  });

  xml = replaceCells(xml, updates);

  // Refresh the cached values of the duration formulas (K10 = I10-G10
  // on the Korean side, AD10 = AB10-Z10 on the English mirror). Without
  // this, Excel/Numbers consumers that honour cached values over
  // calcChain show 3:00 (template default 9–12) for every form regardless
  // of the actual session window. See updateFormulaCacheValue comment.
  if (data.lastSessionStart && data.lastSessionEnd) {
    const startFraction =
      (data.lastSessionStart.hours * 3600 +
        data.lastSessionStart.minutes * 60) /
      86400;
    const endFraction =
      (data.lastSessionEnd.hours * 3600 + data.lastSessionEnd.minutes * 60) /
      86400;
    const durationFraction = endFraction - startFraction;
    xml = updateFormulaCacheValue(xml, "K10", durationFraction);
    xml = updateFormulaCacheValue(xml, "AD10", durationFraction);
  }

  zip.file("xl/worksheets/sheet1.xml", xml);

  if (data.signaturePng && data.signaturePng.length > 0) {
    await embedSignatureImage(zip, data.signaturePng);
  }

  // Excel re-derives the calc chain on open since we don't touch
  // calcChain.xml; nothing to invalidate.

  return Buffer.from(
    await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    }),
  );
}

// ── Signature embedding ────────────────────────────────────────────────
//
// The 실험참여자비 양식 reserves B17:C17 (merged) for the recipient's
// signature. We anchor a PNG there using a two-cell-anchor inside the
// existing drawing1.xml, add an image relationship, drop the binary into
// xl/media/, and register the png content-type. Care points:
//
//  - drawing1.xml in the template carries 18 form-control checkbox
//    anchors wrapped in <mc:AlternateContent>. Our <xdr:twoCellAnchor>
//    sits as a sibling at the end (just before </xdr:wsDr>). No
//    namespace conflict because xdr/a are declared at the root and the
//    blip's xmlns:r is declared inline.
//
//  - The template's drawing1.xml.rels has only rId1 (a hyperlink). We
//    use rId500 to avoid collision — Excel does not require monotonic
//    rIds, just uniqueness within the rels file.
//
//  - The cNvPr id namespace is shared with the form-control shapes
//    (which use VML-derived ids in the 1025+ range). Picking 5000
//    avoids any plausible collision.

const SIGNATURE_REL_ID = "rId500";
const SIGNATURE_CNVPR_ID = 5000;
const SIGNATURE_MEDIA_PATH = "xl/media/image-signature.png";

function buildSignatureAnchorXml(): string {
  // B17:C17 is the merged signature area. In drawing-coords (0-indexed):
  //   B = col 1, row 17 = row 16
  //   D = col 3 (exclusive bottom-right) — fills B17 + C17 width
  //   row 18 = 17 (exclusive bottom) — fills row 17 height
  return [
    `<xdr:twoCellAnchor editAs="oneCell">`,
    `<xdr:from>`,
    `<xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff>`,
    `<xdr:row>16</xdr:row><xdr:rowOff>0</xdr:rowOff>`,
    `</xdr:from>`,
    `<xdr:to>`,
    `<xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff>`,
    `<xdr:row>17</xdr:row><xdr:rowOff>0</xdr:rowOff>`,
    `</xdr:to>`,
    `<xdr:pic>`,
    `<xdr:nvPicPr>`,
    `<xdr:cNvPr id="${SIGNATURE_CNVPR_ID}" name="Signature"/>`,
    `<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr>`,
    `</xdr:nvPicPr>`,
    `<xdr:blipFill>`,
    `<a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="${SIGNATURE_REL_ID}"/>`,
    `<a:stretch><a:fillRect/></a:stretch>`,
    `</xdr:blipFill>`,
    `<xdr:spPr>`,
    `<a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm>`,
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`,
    `</xdr:spPr>`,
    `</xdr:pic>`,
    `<xdr:clientData/>`,
    `</xdr:twoCellAnchor>`,
  ].join("");
}

async function embedSignatureImage(
  zip: JSZip,
  pngBuffer: Buffer,
): Promise<void> {
  // 1. Write image binary.
  zip.file(SIGNATURE_MEDIA_PATH, pngBuffer);

  // 2. Append <Relationship> to drawing1.xml.rels.
  const relsPath = "xl/drawings/_rels/drawing1.xml.rels";
  const relsEntry = zip.file(relsPath);
  if (!relsEntry) {
    throw new Error(
      "individual-template: drawing1.xml.rels missing — template integrity broken",
    );
  }
  const relsXml = await relsEntry.async("text");
  const newRel = `<Relationship Id="${SIGNATURE_REL_ID}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image-signature.png"/>`;
  // Idempotency guard — rerunning fillIndividualForm on the same buffer
  // (e.g. unit-test reuse) shouldn't double-add. The cache returns a
  // fresh buffer from disk each templateCache miss, so this guard only
  // matters in pathological reuse, but cheap to add.
  if (!relsXml.includes(SIGNATURE_REL_ID)) {
    zip.file(
      relsPath,
      relsXml.replace("</Relationships>", `${newRel}</Relationships>`),
    );
  }

  // 3. Append picture anchor to drawing1.xml.
  const drawingPath = "xl/drawings/drawing1.xml";
  const drawingEntry = zip.file(drawingPath);
  if (!drawingEntry) {
    throw new Error(
      "individual-template: drawing1.xml missing — template integrity broken",
    );
  }
  const drawingXml = await drawingEntry.async("text");
  if (!drawingXml.includes(`name="Signature"`)) {
    zip.file(
      drawingPath,
      drawingXml.replace(
        "</xdr:wsDr>",
        `${buildSignatureAnchorXml()}</xdr:wsDr>`,
      ),
    );
  }

  // 4. Register png content-type if not already present.
  const ctPath = "[Content_Types].xml";
  const ctEntry = zip.file(ctPath);
  if (!ctEntry) {
    throw new Error(
      "individual-template: [Content_Types].xml missing — template integrity broken",
    );
  }
  const ctXml = await ctEntry.async("text");
  if (!/Extension="png"/i.test(ctXml)) {
    // Insert before the first <Default> so png joins the same band as
    // bin/rels/vml/xml. Position-independent in the spec, but consistent
    // ordering keeps diffs readable.
    zip.file(
      ctPath,
      ctXml.replace(
        /(<Default\s+Extension="bin")/,
        `<Default Extension="png" ContentType="image/png"/>$1`,
      ),
    );
  }
}

export interface UploadParticipant {
  seq: number;
  name: string;
  institution: string;
  rrnFront: string; // 6 digits
  rrnBack: string; // 7 digits
  amountKrw: number;
  accountNumber: string;
  bankName: string;
  accountHolder: string;
}

const UPLOAD_DATA_START_ROW = 3;
const UPLOAD_NOTES_START_ROW = 10; // first row of instructional notes
export const UPLOAD_MAX_ROWS = UPLOAD_NOTES_START_ROW - UPLOAD_DATA_START_ROW; // 7

function buildUploadDataRow(
  rowNum: number,
  p: UploadParticipant,
): string {
  // Cell styles inferred from template row 3:
  //   A: s=6 (number)        B: s=6 (string)        C: s=6 (string)
  //   D: s=7 (RRN front)     E: s=7 (RRN back)
  //   F: s=6 (formula)       G: s=6 (passport — empty)
  //   H: s=6 (국적)           I: s=21 (소득구분)
  //   J: s=8 (소득상세)       K: s=9 (지급액 numeric)
  //   L: s=10 (계좌)          M: s=6 (은행)         N: s=6 (예금주)
  //   O–R: s=9 (출장경비 0)
  const esc = escapeXml;
  return [
    `<row r="${rowNum}" spans="1:18">`,
    `<c r="A${rowNum}" s="6"><v>${p.seq}</v></c>`,
    `<c r="B${rowNum}" s="6" t="inlineStr"><is><t xml:space="preserve">${esc(p.name)}</t></is></c>`,
    `<c r="C${rowNum}" s="6" t="inlineStr"><is><t xml:space="preserve">${esc(p.institution)}</t></is></c>`,
    `<c r="D${rowNum}" s="7" t="inlineStr"><is><t xml:space="preserve">${esc(p.rrnFront)}</t></is></c>`,
    `<c r="E${rowNum}" s="7" t="inlineStr"><is><t xml:space="preserve">${esc(p.rrnBack)}</t></is></c>`,
    `<c r="F${rowNum}" s="6" t="str"><f>IF(H${rowNum}="대한민국","N","Y")</f><v>N</v></c>`,
    `<c r="G${rowNum}" s="6"/>`,
    `<c r="H${rowNum}" s="6" t="inlineStr"><is><t xml:space="preserve">대한민국</t></is></c>`,
    `<c r="I${rowNum}" s="21" t="inlineStr"><is><t xml:space="preserve">기타소득</t></is></c>`,
    `<c r="J${rowNum}" s="8" t="inlineStr"><is><t xml:space="preserve">강연료 등 필요경비 있는 기타소득</t></is></c>`,
    `<c r="K${rowNum}" s="9"><v>${p.amountKrw}</v></c>`,
    `<c r="L${rowNum}" s="10" t="inlineStr"><is><t xml:space="preserve">${esc(p.accountNumber)}</t></is></c>`,
    `<c r="M${rowNum}" s="6" t="inlineStr"><is><t xml:space="preserve">${esc(p.bankName)}</t></is></c>`,
    `<c r="N${rowNum}" s="6" t="inlineStr"><is><t xml:space="preserve">${esc(p.accountHolder)}</t></is></c>`,
    `<c r="O${rowNum}" s="9"><v>0</v></c>`,
    `<c r="P${rowNum}" s="9"><v>0</v></c>`,
    `<c r="Q${rowNum}" s="9"><v>0</v></c>`,
    `<c r="R${rowNum}" s="9"><v>0</v></c>`,
    `</row>`,
  ].join("");
}

function buildUploadEndRow(rowNum: number): string {
  // Template style: A row with literal "END" in column A, s=11, t="s".
  // We use inlineStr to avoid sharedStrings dependency.
  return [
    `<row r="${rowNum}" spans="1:18">`,
    `<c r="A${rowNum}" s="11" t="inlineStr"><is><t xml:space="preserve">END</t></is></c>`,
    `</row>`,
  ].join("");
}

export async function fillUploadForm(
  participants: UploadParticipant[],
): Promise<Buffer> {
  if (participants.length > UPLOAD_MAX_ROWS) {
    // Up to 7 participants fit between row 3 and the instructional notes
    // at row 10. For larger claims, split into multiple uploads — the lab
    // tool already supports concatenation upstream and the admin
    // accepts it.
    throw new Error(
      `Upload form supports up to ${UPLOAD_MAX_ROWS} participants per file (got ${participants.length}). Split the claim.`,
    );
  }

  const templateBuf = await loadUploadTemplate();
  const zip = await JSZip.loadAsync(templateBuf);

  const sheetEntry = zip.file("xl/worksheets/sheet1.xml");
  if (!sheetEntry) {
    throw new Error("upload-template.xlsx missing xl/worksheets/sheet1.xml");
  }
  let xml = await sheetEntry.async("text");

  // Build replacement rows for the data area (rows 3..3+N-1) plus END.
  const dataRows = participants.map((p, idx) =>
    buildUploadDataRow(UPLOAD_DATA_START_ROW + idx, p),
  );
  const endRow = buildUploadEndRow(UPLOAD_DATA_START_ROW + participants.length);

  // Replace template rows 3..max(5, dataEnd+1) with our content. Template
  // ships rows 3, 4 (samples), 5 (END), and 6–9 (empty placeholder rows
  // with styled cells but no values). We replace as many of those as we
  // need, and leave any unused tail placeholders untouched — they don't
  // render and Excel ignores them.
  const lastTouchedRow = UPLOAD_DATA_START_ROW + participants.length;
  for (
    let rowNum = UPLOAD_DATA_START_ROW;
    rowNum <= Math.max(5, lastTouchedRow);
    rowNum++
  ) {
    // Drop the row entirely; we'll splice replacements in below.
    const re = new RegExp(`<row\\s+r="${rowNum}"[^>]*>[\\s\\S]*?</row>`, "g");
    xml = xml.replace(re, "");
  }
  // Splice all new rows in immediately after row 2 (the header rows).
  const row2End = xml.indexOf("</row>", xml.indexOf('<row r="2"'));
  if (row2End < 0) {
    throw new Error("upload-template: could not locate row 2 anchor");
  }
  const insertionPoint = row2End + "</row>".length;
  const newRowsBlob = [...dataRows, endRow].join("");
  xml = xml.slice(0, insertionPoint) + newRowsBlob + xml.slice(insertionPoint);

  zip.file("xl/worksheets/sheet1.xml", xml);

  return Buffer.from(
    await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    }),
  );
}

// ── 연구참여비 지급신청서 (docx) ───────────────────────────────────────
//
// The 행정실 accepts an extra dispatch document — `연구참여비_지급신청서.docx`
// — alongside the SNU R&D xlsx forms. It is a Word table where each row
// describes one session attended by the participant; the bottom row sums
// the per-session payments. User-supplied template (2026-06-10) ships
// with sample values ("Psychophysics" / "05/02" / "1.5만") — we mutate the
// document.xml inside the docx zip the same way we mutate sheet1.xml in
// the xlsx flow: surgical text-node replacement so the document's
// formatting / themes / fonts pass through untouched.

export interface ResearchPaymentRequestData {
  /** Researcher display name (실험자) — resolved from
   *  experiments.created_by → profiles.display_name. */
  researcherName: string;
  /** Participant display name (참여자). */
  participantName: string;
  /** YYYY-MM-DD; null when the participant row has no birthdate. */
  participantBirthdate: string | null;
  /** Used as the per-row "실험내용" cell (single value, repeated per row
   *  because every session is the same study). */
  experimentTitle: string;
  /** Chronological session list. The table has 10 data rows; sessions
   *  beyond the 10th overflow into a follow-up "..." line in the last
   *  row's 실험내용 cell. */
  sessions: Array<{ slot_start: string; slot_end: string }>;
  /** Total amount in KRW. Per-session amount is `totalAmountKrw /
   *  sessions.length` (display rounded to 0.1 만원). */
  totalAmountKrw: number;
}

const RPR_TABLE_DATA_ROW_COUNT = 10; // template ships with 10 data rows

function formatDateMMDD(iso: string): string {
  // KST month/day; envelope-style "06/09".
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Seoul",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
  // en-GB gives "DD/MM"; flip to "MM/DD" to match the template sample.
  const [d, m] = fmt.split("/");
  return `${m}/${d}`;
}

function sessionDurationHoursLabel(slot_start: string, slot_end: string): string {
  const minutes =
    (new Date(slot_end).getTime() - new Date(slot_start).getTime()) / 60_000;
  // Whole hours stay as integer ("1"), partials carry one decimal ("1.5").
  const hours = minutes / 60;
  return Number.isInteger(hours)
    ? `${hours}`
    : (Math.round(hours * 10) / 10).toString();
}

// Per-session display amounts that SUM to the total (2026-06-10 review
// [14]): naive total/N rounding made rows that didn't add up to the
// printed 총액 (e.g. 90,000/7). First N-1 rows get the rounded
// per-session figure; the LAST row absorbs the remainder so
// sum(rows) === total exactly.
function perSessionAmounts(totalKrw: number, n: number): number[] {
  if (n <= 0) return [];
  const per = Math.round(totalKrw / n);
  const head = Array.from({ length: n - 1 }, () => per);
  const last = totalKrw - per * (n - 1);
  return [...head, last];
}

function formatManwon(krw: number): string {
  // 만원 with at most 2 decimals, trailing-zero stripped ("1.8", "3", "0.5").
  const manwon = krw / 10_000;
  if (Number.isInteger(manwon)) return `${manwon}`;
  return (Math.round(manwon * 100) / 100).toString();
}

/** Replace the FIRST occurrence of `<w:t>oldText</w:t>` (with any attrs)
 *  in `xml` with the same wrapper but `newText` inside. xml:space=preserve
 *  is added so leading/trailing spaces survive Word's whitespace
 *  normalisation. */
function replaceFirstWT(
  xml: string,
  oldText: string,
  newText: string,
): string {
  // Build a regex that matches the SPECIFIC inner text. The text is
  // escaped for regex; attribute-list is wildcarded.
  const esc = oldText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<w:t(\\s[^>]*)?>${esc}</w:t>`);
  return xml.replace(
    re,
    `<w:t xml:space="preserve">${escapeXml(newText)}</w:t>`,
  );
}

/** Replace the FIRST `<w:t>oldText</w:t>` that appears AFTER `anchor`
 *  (a text fragment occurring earlier in the XML). Lets us safely target
 *  the total-row "3" by anchoring on "연구참여비 지급 총액" — without
 *  this, naive global replace would also match any data-row amount that
 *  happens to equal "3". */
function replaceFirstWTAfter(
  xml: string,
  anchor: string,
  oldText: string,
  newText: string,
): string {
  const anchorIdx = xml.indexOf(anchor);
  if (anchorIdx < 0) return xml;
  const esc = oldText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<w:t(\\s[^>]*)?>${esc}</w:t>`);
  const tail = xml.slice(anchorIdx);
  const replaced = tail.replace(
    re,
    `<w:t xml:space="preserve">${escapeXml(newText)}</w:t>`,
  );
  if (replaced === tail) return xml;
  return xml.slice(0, anchorIdx) + replaced;
}

export async function fillResearchPaymentRequest(
  data: ResearchPaymentRequestData,
): Promise<Buffer> {
  const templateBuf = await loadResearchPaymentRequestTemplate();
  const zip = await JSZip.loadAsync(templateBuf);

  const docEntry = zip.file("word/document.xml");
  if (!docEntry) {
    throw new Error(
      "research-payment-request-template: word/document.xml missing",
    );
  }
  let xml = await docEntry.async("text");

  // 1) Header fields — append the actual values to the labels in place.
  //    Word's run-splitting puts "실험자" and ":" in separate `<w:t>`
  //    elements (verified on the live template); 참여자: + 생년월일: are
  //    each one combined run. So the 실험자 path anchors on the label
  //    and rewrites the FOLLOWING ":" run; the other two collapse into a
  //    single `<w:t>` rewrite.
  const birthDisplay = data.participantBirthdate
    ? data.participantBirthdate.slice(0, 10)
    : "-";
  xml = replaceFirstWTAfter(xml, "실험자", ":", `: ${data.researcherName}`);
  xml = replaceFirstWT(xml, "참여자:", `참여자: ${data.participantName}`);
  xml = replaceFirstWT(xml, "생년월일:", `생년월일: ${birthDisplay}`);

  // 2) Table data rows. The template ships with 2 sample rows + 8 empty.
  //    Row layout per cell:
  //      Col 1 (실험내용): one `<w:t>Psychophysics</w:t>` per filled row
  //      Col 2 (방문일):   one `<w:t>MM/DD</w:t>`
  //      Col 3 (실험 시간): `<w:t>N</w:t><w:t>시간</w:t>`
  //      Col 4 (연구참여비): `<w:t>X.Y</w:t><w:t>만</w:t>`
  //    The two sample rows have unique date strings ("05/02", "05/07")
  //    which lets us target them precisely. For sessions beyond the
  //    2 sample rows we splice plain-text replacements into the rest of
  //    the empty-row scaffold.
  const N = data.sessions.length;
  const rowAmounts = perSessionAmounts(data.totalAmountKrw, N);

  // Sample row mutations (rows 1 + 2 of the data table).
  const sample = [
    { dateAnchor: "05/02", amountAnchor: "1.5" },
    { dateAnchor: "05/07", amountAnchor: "1.5" },
  ];
  for (let i = 0; i < Math.min(2, sample.length); i++) {
    const s = data.sessions[i];
    const a = sample[i];
    if (s) {
      // Anchor the duration + amount replacements on THIS row's ORIGINAL,
      // still-unique date literal ("05/02" / "05/07") — and replace the date
      // LAST. The template's sample dates are distinct per row, so
      // replaceFirstWTAfter targets the correct row even when two real
      // sessions fall on the SAME calendar day (anchoring on the freshly
      // written date would collide in that case). This also stops a row-1
      // amount that formats to "1.5" from clobbering row 0, and the duration
      // "1" from matching an unrelated earlier text node.
      const hrsLabel = sessionDurationHoursLabel(s.slot_start, s.slot_end);
      if (hrsLabel !== "1") {
        xml = replaceFirstWTAfter(xml, a.dateAnchor, "1", hrsLabel);
      }
      xml = replaceFirstWTAfter(
        xml,
        a.dateAnchor,
        a.amountAnchor,
        formatManwon(rowAmounts[i] ?? 0),
      );
      xml = replaceFirstWT(xml, a.dateAnchor, formatDateMMDD(s.slot_start));
      // Per-row 실험내용: the first row's anchor is the "Psychophysics"
      // sample, reused as anchor for the second row too.
      xml = replaceFirstWT(xml, "Psychophysics", data.experimentTitle);
    } else {
      // No session for this template row — blank out the sample content.
      xml = replaceFirstWT(xml, a.dateAnchor, "");
      xml = replaceFirstWT(xml, a.amountAnchor, "");
      xml = replaceFirstWT(xml, "Psychophysics", "");
    }
  }

  // Sessions 3..min(N, 10) get appended to the document body as additional
  // plain paragraphs after the table. This is a fallback because the
  // empty template rows lack `<w:t>` anchors we can target without a full
  // OOXML row builder. The visual effect is the data still ships; the
  // researcher / 행정 선생님 can copy the lines into a fresh row if they
  // want pixel-perfect layout. For typical 2-3 session experiments this
  // path doesn't trigger.
  const overflow = data.sessions.slice(2, RPR_TABLE_DATA_ROW_COUNT);
  if (overflow.length > 0) {
    const lines = overflow
      .map((s, idx) => {
        const visit = formatDateMMDD(s.slot_start);
        const hrs = sessionDurationHoursLabel(s.slot_start, s.slot_end);
        return `  ${idx + 3}회차 · ${data.experimentTitle} · ${visit} · ${hrs}시간 · ${formatManwon(rowAmounts[idx + 2] ?? 0)}만`;
      })
      .join("\n");
    const overflowPara = [
      `<w:p><w:pPr><w:rPr><w:lang w:eastAsia="ko-KR"/></w:rPr></w:pPr>`,
      `<w:r><w:rPr><w:lang w:eastAsia="ko-KR"/></w:rPr>`,
      `<w:t xml:space="preserve">${escapeXml(`(추가 회차: ${overflow.length}건)\n${lines}`)}</w:t>`,
      `</w:r></w:p>`,
    ].join("");
    xml = xml.replace("</w:body>", `${overflowPara}</w:body>`);
  }

  // 3) Total line: literal "3" sits immediately after the "연구참여비
  //    지급 총액" label in the bottom row. Anchor on that label so we
  //    don't accidentally rewrite a data-row amount that happened to
  //    equal "3" (e.g. 9만 / 3sess = 3만/session).
  const totalManwon = formatManwon(data.totalAmountKrw);
  xml = replaceFirstWTAfter(xml, "지급 총액", "3", totalManwon);

  zip.file("word/document.xml", xml);

  return Buffer.from(
    await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    }),
  );
}

// ── 연구참여비 지급신청서 — PDF overlay on the locked template ──────
//
// Earlier iteration (pdfkit, removed 2026-06-10) built the PDF from
// scratch; the result diverged visibly from the user-supplied docx
// layout (".PDF에서 기존 양식이 지나치게 파괴됨" feedback). The current
// approach instead:
//
//   1. ONE-TIME locally: take the blank-data docx, run it through
//      LibreOffice (`soffice --headless --convert-to pdf`), check the
//      resulting PDF into the repo as
//      `research-payment-request-template.pdf`. The PDF carries every
//      visual detail of the original docx — title font, table borders,
//      colored header, footer text, page header — because LibreOffice
//      renders it exactly the way Word would.
//
//   2. RUNTIME on Vercel: pdf-lib + fontkit load that template PDF,
//      embed NanumGothic, and draw the variable text (실험자 /
//      참여자 / 생년월일 / 실험내용 / 방문일 / 시간 / 참여비 / 총액)
//      at the coordinates extracted from the template via pdf2json.
//
// Vercel runtime never needs LibreOffice. The template PDF is a fixed
// asset (~60 KB); pdf-lib + fontkit + NanumGothic add ~3 MB to the
// bundle, far cheaper than chromium-min (~50 MB) or libreoffice
// (~700 MB).
//
// Coordinate system note: pdf2json emits page units = (PDF point /
// 16). The template PDF is US Letter (612 × 792 pt) → pdf2json units
// 38.25 × 49.5. The `px` / `py` helpers below scale by 16 and flip Y
// (pdf-lib origin = bottom-left, pdf2json origin = top-left).

// Full NanumGothic (2 MB, ~11k glyphs) — the fallback embed for the rare
// name/title carrying a glyph outside the curated subset.
const RPR_PDF_FONT_PATH = path.join(
  TEMPLATE_DIR,
  "fonts",
  "NanumGothic-Regular.ttf",
);
// Curated subset (743 KB): ASCII + KS X 1001 hangul (2,350 syllables) +
// common symbols, pre-generated by scripts/build-payment-font.mjs. Because
// it is ALREADY a subset we still embed it with subset:false — pdf-lib's
// runtime subsetter (subset:true) is what dropped glyphs in the 2026-06-10
// "글씨 누락" bug, so we avoid it entirely and just embed a smaller font.
// N=10 claims drop from ~20 MB to ~7.5 MB of PDF attachments this way.
const RPR_PDF_SUBSET_FONT_PATH = path.join(
  TEMPLATE_DIR,
  "fonts",
  "NanumGothic-payment.ttf",
);
const RPR_PDF_TEMPLATE_PATH = path.join(
  TEMPLATE_DIR,
  "research-payment-request-template.pdf",
);

let cachedFontBuffer: Buffer | null = null;
async function loadKoreanFont(): Promise<Buffer> {
  if (cachedFontBuffer) return cachedFontBuffer;
  cachedFontBuffer = await readFile(RPR_PDF_FONT_PATH);
  return cachedFontBuffer;
}

let cachedSubsetFontBuffer: Buffer | null = null;
async function loadKoreanSubsetFont(): Promise<Buffer> {
  if (cachedSubsetFontBuffer) return cachedSubsetFontBuffer;
  cachedSubsetFontBuffer = await readFile(RPR_PDF_SUBSET_FONT_PATH);
  return cachedSubsetFontBuffer;
}

let cachedTemplatePdfBuffer: Buffer | null = null;
async function loadTemplatePdf(): Promise<Buffer> {
  if (cachedTemplatePdfBuffer) return cachedTemplatePdfBuffer;
  cachedTemplatePdfBuffer = await readFile(RPR_PDF_TEMPLATE_PATH);
  return cachedTemplatePdfBuffer;
}

// pdf2json-extracted coordinates from the clean blank template (units:
// pdf2json scaled, where the template page is 38.25 × 49.5). The blank
// template carries only labels — every data row + total cell is empty,
// so we derive row Y values from a header offset + measured row step
// (sample-filled docx confirmed row1 y=20.21 → row2 y=21.51 = step 1.30).
const TEMPLATE_COORDS = {
  // Header value positions: right of each ":" label.
  researcherValueX: 7.5, // just past 실험자 ":"
  participantValueX: 7.5, // just past 참여자 ":"
  birthdateValueX: 17.2, // just past 생년월일 ":"
  headerLine1Y: 13.39, // 실험자 row
  headerLine2Y: 15.27, // 참여자 + 생년월일 row (shared)
  // Table column left edges (centered text drawn at column-center -
  // text-width/2 at draw time for the narrower columns).
  colExperimentTitleX: 4.4, // "실험내용" column left
  colExperimentTitleCenter: 9.99, // header label center
  colVisitDateCenter: 20.20, // 방문일 column center
  colDurationCenter: 24.90 + 1.0, // 실험 시간 column center (header +1 for cell drift)
  colAmountCenter: 29.65 + 1.5, // 연구참여비 column center
  // Row baselines. Row 1 = 20.21, row 2 = 21.51, step = 1.30.
  rowYStart: 20.21,
  rowYStep: 1.30,
  rowCount: 10,
  // Total row anchored on the docx total label position.
  totalAmountCenter: 29.65 + 1.5,
  totalAmountY: 34.29,
};

const SCALE = 16;
function px(x: number): number {
  return x * SCALE;
}
function py(yTopDown: number, pageHeight: number): number {
  return pageHeight - yTopDown * SCALE;
}

export async function generateResearchPaymentRequestPdf(
  data: ResearchPaymentRequestData,
): Promise<Buffer> {
  const [{ PDFDocument, rgb }, { default: fontkit }] = await Promise.all([
    import("pdf-lib"),
    import("@pdf-lib/fontkit"),
  ]);
  // Pick the smallest font that can render this PDF's variable text. The
  // only non-ASCII strings we draw are the researcher name, participant
  // name, and experiment title (dates/durations/amounts are digits + the
  // KS X 1001 syllables 시간/만, all inside the subset). If every glyph in
  // those three is covered by the curated subset (~743 KB) we embed it;
  // otherwise we fall back to the full NanumGothic (~2 MB) so a rare name
  // never renders blank. Either way subset:false (see below).
  const variableText = `${data.researcherName}${data.participantName}${data.experimentTitle}`;
  const useSubset = isCoveredByPaymentFont(variableText);
  const [templateBuf, fontBuf] = await Promise.all([
    loadTemplatePdf(),
    useSubset ? loadKoreanSubsetFont() : loadKoreanFont(),
  ]);

  const doc = await PDFDocument.load(templateBuf);
  doc.registerFontkit(fontkit);
  // subset:false (full embed) — subset:true was dropping every glyph the
  // template-PDF didn't already reference, leaving us with only "만" /
  // partial "길동" visible while pdf2json still SAW the full text in the
  // content stream (2026-06-10 user-reported "글씨가 누락" bug). We embed
  // the whole (already-curated) font instead. The curated subset keeps
  // this to ~0.75 MB/PDF; the full-font fallback is ~2 MB.
  const font = await doc.embedFont(fontBuf, { subset: false });

  doc.setTitle("연구참여비 지급신청서");
  doc.setAuthor(data.researcherName);
  doc.setSubject(`${data.experimentTitle} — ${data.participantName}`);
  doc.setCreator("CSNL lab-reservation");

  const page = doc.getPages()[0];
  const H = page.getHeight();

  // Vertical visual-center offset: the template baselines in pdf2json
  // sit roughly at the row's text TOP edge; pdf-lib draws text from
  // baseline. Empirical −13 pt offset puts text inside the row band
  // for the 10-pt body font; header lines use −10 pt (11 pt font).
  const HEADER_Y_OFFSET = -10;
  const ROW_Y_OFFSET = -13;

  // Header lines — 실험자 / 참여자 / 생년월일 values painted just to
  // the right of the existing ":" anchor.
  const fontSizeHeader = 11;
  const drawHeader = (xUnits: number, yUnits: number, text: string) => {
    page.drawText(text, {
      x: px(xUnits),
      y: py(yUnits, H) + HEADER_Y_OFFSET,
      font,
      size: fontSizeHeader,
    });
  };
  const birth = data.participantBirthdate
    ? data.participantBirthdate.slice(0, 10)
    : "-";
  drawHeader(
    TEMPLATE_COORDS.researcherValueX,
    TEMPLATE_COORDS.headerLine1Y,
    data.researcherName,
  );
  drawHeader(
    TEMPLATE_COORDS.participantValueX,
    TEMPLATE_COORDS.headerLine2Y,
    data.participantName,
  );
  drawHeader(
    TEMPLATE_COORDS.birthdateValueX,
    TEMPLATE_COORDS.headerLine2Y,
    birth,
  );

  // Table data rows — left-aligned for the 실험내용 column (long
  // strings), center-aligned for the 3 narrower columns. The blank
  // template has empty data rows so we draw the FULL unit-suffixed
  // strings ("1시간", "1.8만"), keeping every row visually identical.
  const fontSizeRow = 10;
  const drawCenter = (xCenterUnits: number, yUnits: number, text: string) => {
    const textWidth = font.widthOfTextAtSize(text, fontSizeRow);
    page.drawText(text, {
      x: px(xCenterUnits) - textWidth / 2,
      y: py(yUnits, H) + ROW_Y_OFFSET,
      font,
      size: fontSizeRow,
    });
  };
  const drawLeft = (xLeftUnits: number, yUnits: number, text: string) => {
    page.drawText(text, {
      x: px(xLeftUnits),
      y: py(yUnits, H) + ROW_Y_OFFSET,
      font,
      size: fontSizeRow,
    });
  };

  const N = data.sessions.length;
  const rowAmounts = perSessionAmounts(data.totalAmountKrw, N);
  const filledRows = Math.min(N, TEMPLATE_COORDS.rowCount);
  for (let i = 0; i < filledRows; i++) {
    const ry =
      TEMPLATE_COORDS.rowYStart + i * TEMPLATE_COORDS.rowYStep;
    const s = data.sessions[i];
    drawLeft(TEMPLATE_COORDS.colExperimentTitleX, ry, data.experimentTitle);
    drawCenter(
      TEMPLATE_COORDS.colVisitDateCenter,
      ry,
      formatDateMMDD(s.slot_start),
    );
    drawCenter(
      TEMPLATE_COORDS.colDurationCenter,
      ry,
      `${sessionDurationHoursLabel(s.slot_start, s.slot_end)}시간`,
    );
    drawCenter(
      TEMPLATE_COORDS.colAmountCenter,
      ry,
      `${formatManwon(rowAmounts[i] ?? 0)}만`,
    );
  }

  // Total — centered in the right-half of the total row.
  const totalText = `${formatManwon(data.totalAmountKrw)}만`;
  const totalSize = fontSizeRow + 1;
  const totalWidth = font.widthOfTextAtSize(totalText, totalSize);
  page.drawText(totalText, {
    x: px(TEMPLATE_COORDS.totalAmountCenter) - totalWidth / 2,
    y: py(TEMPLATE_COORDS.totalAmountY, H) + ROW_Y_OFFSET,
    font,
    size: totalSize,
  });

  // Silence unused-var lint for rgb (kept for future white-out reuse).
  void rgb;

  return Buffer.from(await doc.save());
}
