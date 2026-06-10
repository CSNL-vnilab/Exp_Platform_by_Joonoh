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

// Re-export for callers that previously imported from this module.
export { DEFAULT_NATIONALITY };
