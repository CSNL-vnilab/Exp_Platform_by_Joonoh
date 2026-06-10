// Single source of truth for the 참여자비 청구 bundle pipeline.
//
// Two entry points share one set of helpers:
//   • fetchClaimRows(experimentId, bookingGroupIds?) — the original
//     /payment-claim path. Filters by status='submitted_to_admin' so
//     repeated clicks are idempotent.
//   • fetchClaimRowsByClaimId(experimentId, claimId, opts) — the
//     follow-up 행정 dispatch email path. Resolves rows via the claim's
//     stored booking_group_ids array, status-agnostic so it works after
//     rows have been flipped to 'claimed' or 'paid'.
//
// Both run through the same row-mapper, the same storage downloader,
// and the same ExportParticipant assembler. buildClaimBundle composes
// those plus workbook generation + ZIP packaging for download.

import JSZip from "jszip";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  buildIndividualFormWorkbook,
  buildUploadFormWorkbook,
  formatDateSpan,
  type ExportParticipant,
} from "@/lib/payments/excel";
import { fillResearchPaymentRequest } from "@/lib/payments/template-filler";

// 2026-06-10 user directive — auto-fill the 목적 (B13) cell with this
// standing description for every offline experiment participating in
// 지각적 의사결정 studies. Overrides only when the experiment ships its
// own purpose later (none today).
const DEFAULT_PURPOSE = "지각적 의사결정 오프라인 실험 참여";

type Supabase = ReturnType<typeof createAdminClient>;

// ── Types ──────────────────────────────────────────────────────────────

export interface BundleRow {
  participantId: string;
  bookingGroupId: string;
  participantName: string;
  participantEmail: string | null;
  participantPhone: string | null;
  rrnCipher: unknown;
  rrnIv: unknown;
  rrnTag: unknown;
  rrnKeyVersion: number;
  bankName: string | null;
  accountNumber: string | null;
  accountHolder: string | null;
  institution: string | null;
  signaturePath: string | null;
  bankbookPath: string | null;
  bankbookMime: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  amountKrw: number;
  sessions: Array<{ slot_start: string; slot_end: string }>;
  // Per-experiment context — surfaced into the individual form's B12
  // ("제목") + L11 ("장소") cells so the printed form names the actual
  // study + room instead of template defaults.
  experimentTitle: string | null;
  locationName: string | null;
  // 2026-06-10 — surface into the 연구참여비 지급신청서 docx (실험자 /
  // 참여자 / 생년월일 header fields).
  researcherName: string;
  participantBirthdate: string | null;
}

export interface ClaimReuseAssets {
  rows: BundleRow[];
  exportParticipants: ExportParticipant[];
  // Bankbook payloads pre-named for direct attachment composition.
  bankbookEntries: Array<{ filename: string; bytes: Buffer }>;
  // Whether any row has a bankbook_path. Lets the email preview show
  // "통장사본.zip will be attached" without paying the download cost.
  hasBankbooks: boolean;
}

export interface ClaimBundleResult {
  zipBuffer: Buffer;
  participantCount: number;
  totalKrw: number;
  includedBookingGroupIds: string[];
}

// ── Shared utilities ───────────────────────────────────────────────────

// Allow Korean + alphanum + underscore + hyphen + dot; collapse the rest
// to "_". Strip leading dots (path-traversal guard) and cap at 80 chars
// so Content-Disposition + filesystem entries stay short. Mirrors
// buildClaimFileName in the route.
export function safeFilename(raw: string): string {
  const trimmed = raw.trim() || "참가자";
  return (
    trimmed
      .replace(/[\\/:*?"<>|\r\n\t]/g, "_")
      .replace(/^\.+/, "")
      .slice(0, 80) || "참가자"
  );
}

function dedupeName(name: string, used: Map<string, number>): string {
  const count = used.get(name) ?? 0;
  used.set(name, count + 1);
  if (count === 0) return name;
  const dot = name.lastIndexOf(".");
  return dot > 0
    ? `${name.slice(0, dot)} (${count + 1})${name.slice(dot)}`
    : `${name} (${count + 1})`;
}

function extFromMime(mime: string | null): string {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "application/pdf":
      return "pdf";
    default:
      return "bin";
  }
}

function isoToHHMM(iso: string): string {
  // Explicit Asia/Seoul — Vercel runs UTC, getHours() would be off by -9h.
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

function totalHours(sessions: BundleRow["sessions"]): number {
  const ms = sessions.reduce(
    (a, s) =>
      a + (new Date(s.slot_end).getTime() - new Date(s.slot_start).getTime()),
    0,
  );
  return Math.round((ms / (1000 * 60 * 60)) * 10) / 10;
}

async function runConcurrent(
  tasks: Array<() => Promise<void>>,
  limit: number,
): Promise<void> {
  // Bounded concurrency runner. Errors are logged + swallowed so a
  // single failed download doesn't abort the whole bundle build —
  // empty file slot beats a hard failure here.
  let cursor = 0;
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, tasks.length); i++) {
    workers.push(
      (async () => {
        while (true) {
          const my = cursor++;
          if (my >= tasks.length) return;
          try {
            await tasks[my]();
          } catch (err) {
            console.error(
              "[ClaimBundle] download task failed:",
              err instanceof Error ? err.message : "unknown",
            );
          }
        }
      })(),
    );
  }
  await Promise.all(workers);
}

// ── Supabase fetch helpers ─────────────────────────────────────────────

// name_override / email_override / phone come from migration 00050.
// participants.birthdate added 2026-06-10 for the 연구참여비 지급신청서 docx.
const PAYMENT_INFO_SELECT =
  "participant_id, booking_group_id, rrn_cipher, rrn_iv, rrn_tag, rrn_key_version, bank_name, account_number, account_holder, institution, signature_path, bankbook_path, bankbook_mime_type, period_start, period_end, amount_krw, status, name_override, email_override, phone, participants(name, email, phone, birthdate)";

interface RawPaymentInfoRow {
  participant_id: string;
  booking_group_id: string;
  rrn_cipher: unknown;
  rrn_iv: unknown;
  rrn_tag: unknown;
  rrn_key_version: number;
  bank_name: string | null;
  account_number: string | null;
  account_holder: string | null;
  institution: string | null;
  signature_path: string | null;
  bankbook_path: string | null;
  bankbook_mime_type: string | null;
  period_start: string | null;
  period_end: string | null;
  amount_krw: number;
  name_override: string | null;
  email_override: string | null;
  phone: string | null;
  participants: {
    name: string;
    email: string | null;
    phone: string | null;
    birthdate: string | null;
  } | null;
}

interface ExperimentContext {
  experimentTitle: string | null;
  locationName: string | null;
  /** Resolved from experiments.created_by → profiles.display_name. Used
   *  by the 연구참여비 지급신청서 docx as the 실험자 field. */
  researcherName: string;
}

async function loadExperimentContext(
  supabase: Supabase,
  experimentId: string,
): Promise<ExperimentContext> {
  const { data: expRow } = await supabase
    .from("experiments")
    .select("title, location_id, created_by")
    .eq("id", experimentId)
    .single();
  const exp = expRow as {
    title: string;
    location_id: string | null;
    created_by: string | null;
  } | null;
  const experimentTitle = exp?.title ?? null;
  let locationName: string | null = null;
  if (exp?.location_id) {
    const { data: locRow } = await supabase
      .from("experiment_locations")
      .select("name")
      .eq("id", exp.location_id)
      .maybeSingle();
    locationName = (locRow as { name: string } | null)?.name ?? null;
  }
  let researcherName = "-";
  if (exp?.created_by) {
    const { data: profRow } = await supabase
      .from("profiles")
      .select("display_name, email")
      .eq("id", exp.created_by)
      .maybeSingle();
    const prof = profRow as { display_name: string | null; email: string | null } | null;
    researcherName =
      prof?.display_name?.trim() || prof?.email?.trim() || "-";
  }
  return { experimentTitle, locationName, researcherName };
}

async function loadSessionsByBgId(
  supabase: Supabase,
  bgIds: string[],
): Promise<Map<string, Array<{ slot_start: string; slot_end: string }>>> {
  const { data: bookings } = await supabase
    .from("bookings")
    .select("booking_group_id, slot_start, slot_end")
    .in("booking_group_id", bgIds)
    .order("slot_start", { ascending: true });
  const sessionsBy = new Map<
    string,
    Array<{ slot_start: string; slot_end: string }>
  >();
  for (const b of (bookings ?? []) as Array<{
    booking_group_id: string | null;
    slot_start: string;
    slot_end: string;
  }>) {
    if (!b.booking_group_id) continue;
    const list = sessionsBy.get(b.booking_group_id) ?? [];
    list.push({ slot_start: b.slot_start, slot_end: b.slot_end });
    sessionsBy.set(b.booking_group_id, list);
  }
  return sessionsBy;
}

function mapRowToBundleRow(
  r: RawPaymentInfoRow,
  sessionsBy: Map<string, Array<{ slot_start: string; slot_end: string }>>,
  ctx: ExperimentContext,
): BundleRow {
  return {
    participantId: r.participant_id,
    bookingGroupId: r.booking_group_id,
    participantName: r.name_override ?? r.participants?.name ?? "",
    participantEmail: r.email_override ?? r.participants?.email ?? null,
    participantPhone: r.phone ?? r.participants?.phone ?? null,
    rrnCipher: r.rrn_cipher,
    rrnIv: r.rrn_iv,
    rrnTag: r.rrn_tag,
    rrnKeyVersion: r.rrn_key_version,
    bankName: r.bank_name,
    accountNumber: r.account_number,
    accountHolder: r.account_holder,
    institution: r.institution,
    signaturePath: r.signature_path,
    bankbookPath: r.bankbook_path,
    bankbookMime: r.bankbook_mime_type,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    amountKrw: r.amount_krw,
    sessions: sessionsBy.get(r.booking_group_id) ?? [],
    experimentTitle: ctx.experimentTitle,
    locationName: ctx.locationName,
    researcherName: ctx.researcherName,
    participantBirthdate: r.participants?.birthdate ?? null,
  };
}

function mapToExportParticipant(
  r: BundleRow,
  signaturePng: Buffer | null,
): ExportParticipant {
  const last = r.sessions[r.sessions.length - 1];
  return {
    participantId: r.participantId,
    bookingGroupId: r.bookingGroupId,
    name: r.participantName,
    email: r.participantEmail,
    phone: r.participantPhone,
    rrnCipher: r.rrnCipher,
    rrnIv: r.rrnIv,
    rrnTag: r.rrnTag,
    rrnKeyVersion: r.rrnKeyVersion,
    bankName: r.bankName,
    accountNumber: r.accountNumber,
    accountHolder: r.accountHolder,
    signaturePng,
    periodStart: r.periodStart,
    periodEnd: r.periodEnd,
    amountKrw: r.amountKrw,
    sessionCount: r.sessions.length,
    institution: r.institution ?? "서울대학교",
    experimentTitle: r.experimentTitle,
    locationName: r.locationName,
    activityDateSpan: formatDateSpan(r.periodStart, r.periodEnd),
    // 방문 시간 — LAST attended session (2026-06-10 directive).
    lastSessionStart: last ? isoToHHMM(last.slot_start) : null,
    lastSessionEnd: last ? isoToHHMM(last.slot_end) : null,
    purpose: DEFAULT_PURPOSE,
    researcherName: r.researcherName,
    participantBirthdate: r.participantBirthdate,
  };
}

async function downloadClaimAssets(
  supabase: Supabase,
  rows: BundleRow[],
  opts: { withSignatures: boolean; withBankbooks: boolean },
): Promise<{
  signatures: Map<string, Buffer>;
  bankbooks: Map<string, { bytes: Buffer; mime: string }>;
}> {
  const signatures = new Map<string, Buffer>();
  const bankbooks = new Map<string, { bytes: Buffer; mime: string }>();
  if (!opts.withSignatures && !opts.withBankbooks) {
    return { signatures, bankbooks };
  }
  const tasks: Array<() => Promise<void>> = [];
  for (const r of rows) {
    if (opts.withSignatures && r.signaturePath) {
      const path = r.signaturePath;
      const bgId = r.bookingGroupId;
      tasks.push(async () => {
        const { data } = await supabase.storage
          .from("participant-signatures")
          .download(path);
        if (data) {
          signatures.set(bgId, Buffer.from(await data.arrayBuffer()));
        }
      });
    }
    if (opts.withBankbooks && r.bankbookPath) {
      const path = r.bankbookPath;
      const bgId = r.bookingGroupId;
      const mime = r.bankbookMime ?? "application/octet-stream";
      tasks.push(async () => {
        const { data } = await supabase.storage
          .from("participant-bankbooks")
          .download(path);
        if (data) {
          bankbooks.set(bgId, {
            bytes: Buffer.from(await data.arrayBuffer()),
            mime,
          });
        }
      });
    }
  }
  // Bounded concurrency — Supabase Storage caps per-client connections;
  // 8 keeps us safely below the wall while still parallelising heavy
  // bundles (200 participants → 400 round-trips → ~50× speedup).
  await runConcurrent(tasks, 8);
  return { signatures, bankbooks };
}

// ── fetchClaimRows: status='submitted_to_admin' path ──────────────────

export async function fetchClaimRows(
  supabase: Supabase,
  experimentId: string,
  bookingGroupIds?: string[],
): Promise<BundleRow[]> {
  let query = supabase
    .from("participant_payment_info")
    .select(PAYMENT_INFO_SELECT)
    .eq("experiment_id", experimentId)
    .eq("status", "submitted_to_admin")
    .order("submitted_at", { ascending: true });
  if (bookingGroupIds && bookingGroupIds.length > 0) {
    query = query.in("booking_group_id", bookingGroupIds);
  }
  const { data: rows } = await query;
  if (!rows || rows.length === 0) return [];

  const ctx = await loadExperimentContext(supabase, experimentId);
  const typedRows = rows as unknown as RawPaymentInfoRow[];
  const bgIds = typedRows.map((r) => r.booking_group_id);
  const sessionsBy = await loadSessionsByBgId(supabase, bgIds);
  return typedRows.map((r) => mapRowToBundleRow(r, sessionsBy, ctx));
}

// ── fetchClaimRowsByClaimId: status-agnostic, claim-pinned ────────────
//
// Used by the 행정 dispatch email path which can fire after the rows are
// already 'claimed' or 'paid'. Resolves rows via payment_claims's
// stored booking_group_ids array.

export async function fetchClaimRowsByClaimId(
  supabase: Supabase,
  experimentId: string,
  claimId: string,
  opts: { withBankbooks: boolean; withSignatures: boolean },
): Promise<ClaimReuseAssets> {
  const { data: claimRow, error: claimErr } = await supabase
    .from("payment_claims")
    .select("booking_group_ids, experiment_id")
    .eq("id", claimId)
    .single();
  if (claimErr) throw new Error(`payment_claims fetch: ${claimErr.message}`);
  if (!claimRow) throw new Error(`payment_claim ${claimId} not found`);
  const claim = claimRow as {
    booking_group_ids: string[];
    experiment_id: string;
  };
  if (claim.experiment_id !== experimentId) {
    throw new Error("claim_id does not belong to experiment_id");
  }
  const bgIds = claim.booking_group_ids ?? [];
  if (bgIds.length === 0) {
    return {
      rows: [],
      exportParticipants: [],
      bankbookEntries: [],
      hasBankbooks: false,
    };
  }

  const { data: rawRows, error: rowsErr } = await supabase
    .from("participant_payment_info")
    .select(PAYMENT_INFO_SELECT)
    .eq("experiment_id", experimentId)
    .in("booking_group_id", bgIds)
    .order("submitted_at", { ascending: true });
  if (rowsErr) throw new Error(`payment_info fetch: ${rowsErr.message}`);
  if (!rawRows || rawRows.length === 0) {
    return {
      rows: [],
      exportParticipants: [],
      bankbookEntries: [],
      hasBankbooks: false,
    };
  }

  const ctx = await loadExperimentContext(supabase, experimentId);
  const sessionsBy = await loadSessionsByBgId(supabase, bgIds);
  const rows: BundleRow[] = (rawRows as unknown as RawPaymentInfoRow[]).map(
    (r) => mapRowToBundleRow(r, sessionsBy, ctx),
  );
  const hasBankbooks = rows.some((r) => Boolean(r.bankbookPath));

  const { signatures, bankbooks } = await downloadClaimAssets(supabase, rows, {
    withSignatures: opts.withSignatures,
    withBankbooks: opts.withBankbooks,
  });

  const exportParticipants = rows.map((r) =>
    mapToExportParticipant(r, signatures.get(r.bookingGroupId) ?? null),
  );

  const bankbookEntries: Array<{ filename: string; bytes: Buffer }> = [];
  if (opts.withBankbooks) {
    for (const r of rows) {
      const bb = bankbooks.get(r.bookingGroupId);
      if (!bb) continue;
      const ext = extFromMime(bb.mime);
      bankbookEntries.push({
        filename: `통장사본_${safeFilename(r.participantName || r.bookingGroupId)}.${ext}`,
        bytes: bb.bytes,
      });
    }
  }

  return { rows, exportParticipants, bankbookEntries, hasBankbooks };
}

// ── buildClaimBundle: ZIP for download ────────────────────────────────

export async function buildClaimBundle(
  supabase: Supabase,
  rows: BundleRow[],
): Promise<ClaimBundleResult> {
  const { signatures, bankbooks } = await downloadClaimAssets(supabase, rows, {
    withSignatures: true,
    withBankbooks: true,
  });

  const exportParticipants = rows.map((r) =>
    mapToExportParticipant(r, signatures.get(r.bookingGroupId) ?? null),
  );

  // Outer ZIP layout (참여자별 파일 + 전체 청구 파일 + 통장사본 zip):
  //   실험참여자비 양식_{이름}.xlsx × N      (signature embedded at B17:C17)
  //   연구참여비_지급신청서_{이름}.docx × N   (2026-06-10 — per-row session breakdown)
  //   일회성경비지급자_업로드양식_작성.xlsx
  //   통장사본.zip                          (nested)
  //
  // README.txt removed 2026-06-10 per user directive — the bundle now
  // ships data-only, no descriptive sidecar.
  //
  // Signatures are embedded inside each xlsx via XML drawing manipulation
  // (template-filler.ts:embedSignatureImage). Dedup per category so two
  // participants sharing a 이름 still get distinct filenames.
  const formNames = new Map<string, number>();
  const docxNames = new Map<string, number>();
  const bankbookNames = new Map<string, number>();
  const zip = new JSZip();

  // 1. Combined admin upload form.
  const uploadBuf = await buildUploadFormWorkbook(exportParticipants);
  zip.file(
    "일회성경비지급자_업로드양식_작성.xlsx",
    uploadBuf as unknown as ArrayBuffer,
  );

  // 2. Per-participant forms (xlsx) + 지급신청서 (docx).
  for (let i = 0; i < exportParticipants.length; i++) {
    const p = exportParticipants[i];
    const r = rows[i];
    const safe = safeFilename(p.name || p.bookingGroupId);
    const indivBuf = await buildIndividualFormWorkbook(p);
    const indivName = dedupeName(`실험참여자비 양식_${safe}.xlsx`, formNames);
    zip.file(indivName, indivBuf as unknown as ArrayBuffer);

    // 연구참여비 지급신청서 docx — 행정실에 함께 발송하는 보조 신청서.
    // 참여비/세션 = 1회당 지급액으로 자동 계산.
    try {
      const docxBuf = await fillResearchPaymentRequest({
        researcherName: p.researcherName,
        participantName: p.name,
        participantBirthdate: p.participantBirthdate,
        experimentTitle: p.experimentTitle ?? "-",
        sessions: r.sessions,
        totalAmountKrw: p.amountKrw,
      });
      const docxName = dedupeName(
        `연구참여비_지급신청서_${safe}.docx`,
        docxNames,
      );
      zip.file(docxName, docxBuf as unknown as ArrayBuffer);
    } catch (err) {
      console.error(
        `[ClaimBundle] 연구참여비 지급신청서 fill failed for ${p.bookingGroupId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // 3. Bankbook scans bundled into a nested zip — single attachment for
  //    행정 선생님 instead of N loose files.
  const bankbookZip = new JSZip();
  for (const p of exportParticipants) {
    const bb = bankbooks.get(p.bookingGroupId);
    if (!bb) continue;
    const safe = safeFilename(p.name || p.bookingGroupId);
    const ext = extFromMime(bb.mime);
    const bbName = dedupeName(`통장사본_${safe}.${ext}`, bankbookNames);
    bankbookZip.file(bbName, bb.bytes);
  }
  if (bankbookNames.size > 0) {
    const innerZipBuffer = await bankbookZip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });
    zip.file("통장사본.zip", innerZipBuffer);
  }

  const zipBuffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  return {
    zipBuffer,
    participantCount: exportParticipants.length,
    totalKrw: exportParticipants.reduce((a, p) => a + p.amountKrw, 0),
    includedBookingGroupIds: rows.map((r) => r.bookingGroupId),
  };
}

// Re-export the SupabaseClient type signature for tests / scripts that
// want to import a typed admin handle without depending on the full
// admin module.
export type { SupabaseClient };
