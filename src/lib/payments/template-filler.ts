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
const UPLOAD_MAX_ROWS = UPLOAD_NOTES_START_ROW - UPLOAD_DATA_START_ROW; // 7

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
  const perSession =
    N > 0 ? Math.round((data.totalAmountKrw / N) * 100) / 100 : 0;

  // Sample row mutations (rows 1 + 2 of the data table).
  const sample = [
    { dateAnchor: "05/02", amountAnchor: "1.5" },
    { dateAnchor: "05/07", amountAnchor: "1.5" },
  ];
  for (let i = 0; i < Math.min(2, sample.length); i++) {
    const s = data.sessions[i];
    const a = sample[i];
    if (s) {
      xml = replaceFirstWT(xml, a.dateAnchor, formatDateMMDD(s.slot_start));
      const hrsLabel = sessionDurationHoursLabel(s.slot_start, s.slot_end);
      // Both sample rows share the literal "1" before "시간"; replace
      // the FIRST surviving occurrence each iteration. To keep targeting
      // stable, only replace when the duration differs from the template
      // default — otherwise leave the "1" alone.
      if (hrsLabel !== "1") {
        xml = replaceFirstWT(xml, "1", hrsLabel);
      }
      // Replace the FIRST surviving "1.5" anchor with this row's amount.
      xml = replaceFirstWT(xml, a.amountAnchor, formatManwon(perSession));
    } else {
      // No session for this template row — blank out the sample content.
      xml = replaceFirstWT(xml, a.dateAnchor, "");
      xml = replaceFirstWT(xml, a.amountAnchor, "");
    }
    // Always rename the per-row 실험내용 if we have a session; for the
    // first row the anchor is "Psychophysics" (sample), reused as anchor
    // for the second row too.
    if (s) {
      xml = replaceFirstWT(xml, "Psychophysics", data.experimentTitle);
    } else {
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
        return `  ${idx + 3}회차 · ${data.experimentTitle} · ${visit} · ${hrs}시간 · ${formatManwon(perSession)}만`;
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

// ── 연구참여비 지급신청서 — PDF parallel renderer ────────────────────
//
// pdfkit-based PDF that mirrors the data carried by the same-named docx,
// so the 행정 office can either keep the editable docx or send the PDF
// directly. Layout aims for parity with the docx (centered title,
// labelled header lines, a session table, total row) but the rendering
// engine is different — alignment is pixel-equivalent, font is
// NanumGothic Regular (bundled at src/lib/payments/templates/fonts/).
//
// Why pdfkit (not libreoffice or puppeteer): libreoffice is too large
// for Vercel functions; puppeteer + @sparticuz/chromium adds ~50MB
// compressed and a cold-start hit. pdfkit is pure JS + a 2MB font, no
// native deps, no headless browser.

const RPR_PDF_FONT_PATH = path.join(
  TEMPLATE_DIR,
  "fonts",
  "NanumGothic-Regular.ttf",
);

let cachedFontBuffer: Buffer | null = null;
async function loadKoreanFont(): Promise<Buffer> {
  if (cachedFontBuffer) return cachedFontBuffer;
  cachedFontBuffer = await readFile(RPR_PDF_FONT_PATH);
  return cachedFontBuffer;
}

export async function generateResearchPaymentRequestPdf(
  data: ResearchPaymentRequestData,
): Promise<Buffer> {
  // Dynamic import keeps pdfkit out of the cold-path bundle when callers
  // don't need PDF — only the bundle builder + admin export pull it in.
  const PDFDocument = (await import("pdfkit")).default;
  const fontBuf = await loadKoreanFont();

  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 56, bottom: 56, left: 56, right: 56 },
    info: {
      Title: "연구참여비 지급신청서",
      Author: data.researcherName,
      Subject: `${data.experimentTitle} — ${data.participantName}`,
    },
  });

  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });

  doc.registerFont("KR", fontBuf);
  doc.font("KR");

  // Title.
  doc.fontSize(20).text("연구참여비 지급신청서", { align: "center" });
  doc.moveDown(1.5);

  // Header lines (실험자 / 참여자 / 생년월일).
  const birth = data.participantBirthdate
    ? data.participantBirthdate.slice(0, 10)
    : "-";
  doc.fontSize(12);
  doc.text(`실험자: ${data.researcherName}`);
  doc.moveDown(0.3);
  doc.text(`참여자: ${data.participantName}`);
  doc.moveDown(0.3);
  doc.text(`생년월일: ${birth}`);
  doc.moveDown(1);

  // Session table.
  const tableX = doc.page.margins.left;
  const tableWidth =
    doc.page.width - doc.page.margins.left - doc.page.margins.right;
  // Column widths: content (44%), date (16%), duration (18%), amount (22%).
  const colW = [
    Math.floor(tableWidth * 0.44),
    Math.floor(tableWidth * 0.16),
    Math.floor(tableWidth * 0.18),
    tableWidth -
      Math.floor(tableWidth * 0.44) -
      Math.floor(tableWidth * 0.16) -
      Math.floor(tableWidth * 0.18),
  ];
  const headerRowH = 28;
  const dataRowH = 26;

  function drawRow(
    yPos: number,
    cells: string[],
    opts: { headerRow?: boolean } = {},
  ): void {
    const h = opts.headerRow ? headerRowH : dataRowH;
    if (opts.headerRow) {
      doc.save();
      doc.rect(tableX, yPos, tableWidth, h).fillAndStroke("#EAF3FB", "#9FC9EB");
      doc.restore();
      doc.fillColor("black");
    } else {
      doc.rect(tableX, yPos, tableWidth, h).stroke("#9FC9EB");
    }
    let x = tableX;
    for (let i = 0; i < cells.length; i++) {
      const w = colW[i];
      doc
        .fontSize(opts.headerRow ? 11 : 10)
        .text(cells[i], x + 4, yPos + (opts.headerRow ? 8 : 7), {
          width: w - 8,
          align: "center",
        });
      x += w;
    }
  }

  let y = doc.y;
  drawRow(y, ["실험내용", "방문일", "실험 시간", "연구참여비"], {
    headerRow: true,
  });
  y += headerRowH;

  const N = data.sessions.length;
  const perSession = N > 0 ? data.totalAmountKrw / N : 0;
  for (let i = 0; i < N; i++) {
    const s = data.sessions[i];
    drawRow(y, [
      data.experimentTitle,
      formatDateMMDD(s.slot_start),
      `${sessionDurationHoursLabel(s.slot_start, s.slot_end)}시간`,
      `${formatManwon(perSession)}만`,
    ]);
    y += dataRowH;
  }
  // Pad to at least 5 visible rows so the table feels balanced.
  const minRows = 5;
  for (let i = N; i < minRows; i++) {
    drawRow(y, ["", "", "", ""]);
    y += dataRowH;
  }

  // Total row — span first two columns with the label, sum on the right.
  const totalLabelW = colW[0] + colW[1];
  const totalValueW = colW[2] + colW[3];
  doc.rect(tableX, y, tableWidth, headerRowH).stroke("#9FC9EB");
  doc
    .fontSize(11)
    .text("연구참여비 지급 총액", tableX + 4, y + 8, {
      width: totalLabelW - 8,
      align: "center",
    });
  doc.text(`${formatManwon(data.totalAmountKrw)}만`, tableX + totalLabelW, y + 8, {
    width: totalValueW - 4,
    align: "center",
  });

  doc.end();
  return done;
}
