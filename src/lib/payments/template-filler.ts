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
  // First-session start/end as HH:MM in KST. The template renders these
  // as Excel time values via numFmt h:mm.
  firstSessionStart: { hours: number; minutes: number } | null;
  firstSessionEnd: { hours: number; minutes: number } | null;
  participationHours: number; // total across all sessions (rounded 0.1h)
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
    // 활용시간 — start/end (template numFmt: h:mm)
    ...(data.firstSessionStart && {
      G10: {
        kind: "time",
        hours: data.firstSessionStart.hours,
        minutes: data.firstSessionStart.minutes,
      } satisfies CellValue,
    }),
    ...(data.firstSessionEnd && {
      I10: {
        kind: "time",
        hours: data.firstSessionEnd.hours,
        minutes: data.firstSessionEnd.minutes,
      } satisfies CellValue,
    }),
    // 시간/회당/장 — total participation hours
    B11: { kind: "num", value: data.participationHours },
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
    ...(data.firstSessionStart && {
      W10: {
        kind: "time",
        hours: data.firstSessionStart.hours,
        minutes: data.firstSessionStart.minutes,
      } satisfies CellValue,
    }),
    ...(data.firstSessionEnd && {
      Z10: {
        kind: "time",
        hours: data.firstSessionEnd.hours,
        minutes: data.firstSessionEnd.minutes,
      } satisfies CellValue,
    }),
    AB10: { kind: "num", value: data.participationHours },
    U16: { kind: "str", value: data.name },
    W16: { kind: "str", value: data.institution },
    Y16: { kind: "str", value: data.email ?? "" },
    Z16: { kind: "str", value: data.bankName ?? "" },
    AB16: { kind: "str", value: data.accountNumber ?? "" },
    AE16: { kind: "str", value: data.accountHolder ?? data.name },
    W19: { kind: "num", value: data.amountKrw },
  });

  xml = replaceCells(xml, updates);
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
