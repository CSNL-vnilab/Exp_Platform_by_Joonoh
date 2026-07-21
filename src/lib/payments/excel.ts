// Per-participant 실험참여자비 양식 + combined upload form. Both go through
// src/lib/payments/template-filler.ts which keeps the original SNU R&D
// templates byte-for-byte except for the data cells we fill — that's the
// only way the 행정 office accepts the output (page setup, form-control
// checkboxes, external workbook links, and styles must all survive).

import { bytesFromSupabase, decryptRrn } from "@/lib/crypto/payment-info";
import { safeCellText } from "@/lib/payments/sanitize";
import {
  fillIndividualForm,
  fillUploadForm,
  UPLOAD_MAX_ROWS,
  type IndividualFormData,
  type UploadParticipant,
} from "@/lib/payments/template-filler";

// ── Types (kept stable for callers — claim-bundle.ts depends on this) ──

export interface ExportParticipant {
  participantId: string;
  bookingGroupId: string;
  name: string;
  email: string | null;
  phone: string | null;
  rrnCipher: unknown;
  rrnIv: unknown;
  rrnTag: unknown;
  rrnKeyVersion: number;
  bankName: string | null;
  accountNumber: string | null;
  accountHolder: string | null;
  // Signature PNG bytes — embedded into the per-participant xlsx via
  // template-filler.ts's drawing1.xml manipulation (anchored at B17:C17).
  signaturePng: Buffer | null;
  periodStart: string | null;
  periodEnd: string | null;
  amountKrw: number;
  // Number of attended sessions in this booking_group. Drives B11 +
  // English-mirror AB10 (paired with the D11/W11 unit dropdowns flipped
  // to "회" / "time(s)"). Replaces the prior participationHours (total
  // hours) which the 행정 office found confusing for multi-session
  // experiments — 2026-06-10 directive.
  sessionCount: number;
  institution: string;
  // Experiment title — overrides the template's pre-filled "인지행동실험"
  // at B12 so the form names the actual study.
  experimentTitle?: string | null;
  // Location name (e.g. "649호") — overrides template default at L11.
  locationName?: string | null;
  activityDateSpan: string;
  // Used by the per-participant form's "방문 시간" cells (G10/I10 and
  // English-mirror W10/Z10). 2026-06-10 directive switched from FIRST
  // session to the LAST attended session so the form reflects the
  // participant's final visit time.
  lastSessionStart: string | null; // "HH:MM" in KST
  lastSessionEnd: string | null;
  // 목적 / 활용내용 cell (B13). Defaults to the lab's standing description.
  purpose: string;
  // 연구참여비 지급신청서 (docx) inputs — researcher display name +
  // participant birthdate. Both pulled in claim-bundle's row mapper.
  researcherName: string;
  participantBirthdate: string | null;
}

const DEFAULT_NATIONALITY = "대한민국";

// ── Upload form ────────────────────────────────────────────────────────
//
// Wraps the template-filler. Returns a Buffer compatible with the
// existing claim-bundle.ts (which writes via `zip.file(name, buf)`).

export async function buildUploadFormWorkbook(
  participants: ExportParticipant[],
): Promise<Buffer> {
  const rows: UploadParticipant[] = participants.map((p, idx) => {
    const rrn = decryptRrnFromExport(p);
    const [front, back] = splitRrn(rrn);
    return {
      seq: idx + 1,
      // Every user-controlled string passes through safeCellText to
      // neutralize Excel/CSV formula injection (leading =, +, -, @, tab).
      name: safeCellText(p.name),
      institution: safeCellText(p.institution),
      rrnFront: front,
      rrnBack: back,
      amountKrw: p.amountKrw,
      accountNumber: safeCellText(p.accountNumber ?? ""),
      bankName: safeCellText(p.bankName ?? ""),
      accountHolder: safeCellText(p.accountHolder ?? p.name),
    };
  });
  return fillUploadForm(rows);
}

// The SNU upload template fits at most UPLOAD_MAX_ROWS (7) participants
// between the data-start row and the instructional notes. For larger
// claims we emit one workbook per chunk of 7 so an 8+-participant claim
// can still be built and emailed (previously fillUploadForm threw). The
// 행정 office concatenates the chunks upstream. Returns 1 buffer for the
// common ≤7 case, N buffers otherwise; callers name them _1/_2/… when >1.
export async function buildUploadFormWorkbooks(
  participants: ExportParticipant[],
): Promise<Buffer[]> {
  if (participants.length === 0) return [];
  const chunks: ExportParticipant[][] = [];
  for (let i = 0; i < participants.length; i += UPLOAD_MAX_ROWS) {
    chunks.push(participants.slice(i, i + UPLOAD_MAX_ROWS));
  }
  const bufs: Buffer[] = [];
  for (const chunk of chunks) {
    bufs.push(await buildUploadFormWorkbook(chunk));
  }
  return bufs;
}

// ── Individual form ────────────────────────────────────────────────────

export async function buildIndividualFormWorkbook(
  p: ExportParticipant,
): Promise<Buffer> {
  const data: IndividualFormData = {
    name: safeCellText(p.name),
    institution: safeCellText(p.institution),
    rrn: decryptRrnFromExport(p),
    email: p.email ? safeCellText(p.email) : null,
    phone: p.phone ? safeCellText(p.phone) : null,
    bankName: p.bankName ? safeCellText(p.bankName) : null,
    accountNumber: p.accountNumber ? safeCellText(p.accountNumber) : null,
    accountHolder: p.accountHolder ? safeCellText(p.accountHolder) : null,
    amountKrw: p.amountKrw,
    experimentTitle: p.experimentTitle
      ? safeCellText(p.experimentTitle)
      : null,
    locationName: p.locationName ?? null,
    activityDateSpan: p.activityDateSpan,
    lastSessionStart: parseHHMM(p.lastSessionStart),
    lastSessionEnd: parseHHMM(p.lastSessionEnd),
    sessionCount: p.sessionCount,
    purpose: safeCellText(p.purpose),
    signaturePng: p.signaturePng,
  };
  return fillIndividualForm(data);
}

// ── Helpers ────────────────────────────────────────────────────────────

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

function parseHHMM(
  s: string | null,
): { hours: number; minutes: number } | null {
  if (!s) return null;
  const m = s.match(/^(\d{1,2}):(\d{1,2})$/);
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return { hours, minutes };
}

// period_start / period_end are DATE-typed columns → "YYYY-MM-DD" strings.
// Parse the date prefix by slicing, NOT via `new Date(iso)` + local
// getters: Vercel runs UTC today so the getters happen to be correct, but
// any server west of UTC would render the day one behind. String slicing
// is timezone-independent.
type Ymd = { y: number; mo: number; d: number };
function parseYmd(iso: string): Ymd | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) };
}

export function formatDateSpan(
  startIso: string | null,
  endIso: string | null,
): string {
  const s = startIso ? parseYmd(startIso) : null;
  if (!s) return "";
  const full = (p: Ymd) => `${p.y}.${pad(p.mo)}.${pad(p.d)}`;
  const e = endIso ? parseYmd(endIso) : null;
  if (!e) return full(s);
  const sameYear = s.y === e.y;
  const sameMonth = sameYear && s.mo === e.mo;
  const sameDay = sameMonth && s.d === e.d;
  if (sameDay) return full(s);
  if (sameMonth) return `${s.y}.${pad(s.mo)}.${pad(s.d)}~${pad(e.d)}`;
  if (sameYear) return `${s.y}.${pad(s.mo)}.${pad(s.d)}~${pad(e.mo)}.${pad(e.d)}`;
  return `${full(s)}~${full(e)}`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

// Re-export for callers that previously imported from this module.
export { DEFAULT_NATIONALITY };
