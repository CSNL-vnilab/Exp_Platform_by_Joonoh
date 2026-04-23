import JSZip from "jszip";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  buildIndividualFormWorkbook,
  buildUploadFormWorkbook,
  formatDateSpan,
  type ExportParticipant,
} from "@/lib/payments/excel";

// Build a single ZIP containing:
//   - 일회성경비지급자_업로드양식_작성.xlsx   (combined upload form)
//   - 실험참여자비 양식_{name}.xlsx × N       (per-participant forms)
//   - 통장사본_{name}.{ext} × N              (bankbook scans from storage)
// for every payment_info row in the supplied booking-group-id list.
//
// The caller is responsible for the atomic status transition — this helper
// only does data collection + bundling so the transaction boundary stays
// in the API route.

type Supabase = ReturnType<typeof createAdminClient>;

interface BundleRow {
  participantId: string;
  bookingGroupId: string;
  participantName: string;
  participantEmail: string | null;
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
}

export async function fetchClaimRows(
  supabase: Supabase,
  experimentId: string,
  bookingGroupIds?: string[],
): Promise<BundleRow[]> {
  let query = supabase
    .from("participant_payment_info")
    .select(
      "participant_id, booking_group_id, rrn_cipher, rrn_iv, rrn_tag, rrn_key_version, bank_name, account_number, account_holder, institution, signature_path, bankbook_path, bankbook_mime_type, period_start, period_end, amount_krw, status, participants(name, email)",
    )
    .eq("experiment_id", experimentId)
    .eq("status", "submitted_to_admin")
    .order("submitted_at", { ascending: true });
  if (bookingGroupIds && bookingGroupIds.length > 0) {
    query = query.in("booking_group_id", bookingGroupIds);
  }
  const { data: rows } = await query;
  if (!rows || rows.length === 0) return [];

  const bgIds = rows.map((r) => r.booking_group_id);
  const { data: bookings } = await supabase
    .from("bookings")
    .select("booking_group_id, slot_start, slot_end")
    .in("booking_group_id", bgIds)
    .order("slot_start", { ascending: true });

  const sessionsBy = new Map<string, Array<{ slot_start: string; slot_end: string }>>();
  for (const b of bookings ?? []) {
    // booking_group_id is nullable in the bookings schema (single-session
    // records predating 00003 had it null) but every row returned here
    // came from a .in(bookingGroupIds) filter, so it's non-null.
    if (!b.booking_group_id) continue;
    const list = sessionsBy.get(b.booking_group_id) ?? [];
    list.push({ slot_start: b.slot_start, slot_end: b.slot_end });
    sessionsBy.set(b.booking_group_id, list);
  }

  return rows.map((r) => {
    const row = r as unknown as {
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
      participants: { name: string; email: string | null } | null;
    };
    return {
      participantId: row.participant_id,
      bookingGroupId: row.booking_group_id,
      participantName: row.participants?.name ?? "",
      participantEmail: row.participants?.email ?? null,
      rrnCipher: row.rrn_cipher,
      rrnIv: row.rrn_iv,
      rrnTag: row.rrn_tag,
      rrnKeyVersion: row.rrn_key_version,
      bankName: row.bank_name,
      accountNumber: row.account_number,
      accountHolder: row.account_holder,
      institution: row.institution,
      signaturePath: row.signature_path,
      bankbookPath: row.bankbook_path,
      bankbookMime: row.bankbook_mime_type,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      amountKrw: row.amount_krw,
      sessions: sessionsBy.get(row.booking_group_id) ?? [],
    };
  });
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

function safeFilename(raw: string): string {
  // Allow Korean + alphanum + underscore + hyphen + dot; collapse rest to _.
  // Also strip leading dots (prevents `..`-style entries) and cap length
  // at 80 chars so header values stay short. Matches the hardening in
  // src/app/api/experiments/[experimentId]/payment-claim/route.ts:buildClaimFileName.
  const trimmed = raw.trim() || "참가자";
  const cleaned = trimmed
    .replace(/[\\/:*?"<>|\r\n\t]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 80);
  return cleaned || "참가자";
}

async function runConcurrent(
  tasks: Array<() => Promise<void>>,
  limit: number,
): Promise<void> {
  // Minimal concurrency-bounded runner — each worker pulls from a shared
  // index. If any task throws we swallow (download failure = empty file
  // slot, not a hard bundle failure).
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

function dedupeName(name: string, used: Map<string, number>): string {
  const count = used.get(name) ?? 0;
  used.set(name, count + 1);
  if (count === 0) return name;
  // Second collision → "이름 (2)", etc.
  const dot = name.lastIndexOf(".");
  if (dot > 0) {
    return `${name.slice(0, dot)} (${count + 1})${name.slice(dot)}`;
  }
  return `${name} (${count + 1})`;
}

export interface ClaimBundleResult {
  zipBuffer: Buffer;
  participantCount: number;
  totalKrw: number;
  includedBookingGroupIds: string[];
}

export async function buildClaimBundle(
  supabase: Supabase,
  rows: BundleRow[],
): Promise<ClaimBundleResult> {
  const zip = new JSZip();

  // Fetch all signatures + bankbooks in parallel with a concurrency cap
  // so a 200-participant claim doesn't hit Vercel function timeout from
  // serial storage downloads (~400 round-trips otherwise). Bounded to 8
  // concurrent fetches to stay within Supabase's per-client limits.
  const CONCURRENCY = 8;
  const downloadTasks: Array<() => Promise<void>> = [];
  const signatures = new Map<string, Buffer>();
  const bankbooks = new Map<string, { bytes: Buffer; mime: string }>();

  for (const r of rows) {
    if (r.signaturePath) {
      const path = r.signaturePath;
      const bgId = r.bookingGroupId;
      downloadTasks.push(async () => {
        const { data } = await supabase.storage
          .from("participant-signatures")
          .download(path);
        if (data) {
          signatures.set(bgId, Buffer.from(await data.arrayBuffer()));
        }
      });
    }
    if (r.bankbookPath) {
      const path = r.bankbookPath;
      const bgId = r.bookingGroupId;
      const mime = r.bankbookMime ?? "application/octet-stream";
      downloadTasks.push(async () => {
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

  // Simple sliding-window concurrency — fire up to CONCURRENCY at a time,
  // advance as tasks resolve. Order doesn't matter since we look up by
  // bookingGroupId downstream.
  await runConcurrent(downloadTasks, CONCURRENCY);

  const exportParticipants: ExportParticipant[] = rows.map((r) => {
    const first = r.sessions[0];
    return {
      participantId: r.participantId,
      bookingGroupId: r.bookingGroupId,
      name: r.participantName,
      email: r.participantEmail,
      rrnCipher: r.rrnCipher,
      rrnIv: r.rrnIv,
      rrnTag: r.rrnTag,
      rrnKeyVersion: r.rrnKeyVersion,
      bankName: r.bankName,
      accountNumber: r.accountNumber,
      accountHolder: r.accountHolder,
      signaturePng: signatures.get(r.bookingGroupId) ?? null,
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      amountKrw: r.amountKrw,
      participationHours: totalHours(r.sessions),
      institution: r.institution ?? "서울대학교",
      activityDateSpan: formatDateSpan(r.periodStart, r.periodEnd),
      firstSessionStart: first ? isoToHHMM(first.slot_start) : null,
      firstSessionEnd: first ? isoToHHMM(first.slot_end) : null,
    };
  });

  // 1. Combined upload form.
  const uploadBuf = await buildUploadFormWorkbook(exportParticipants);
  zip.file(
    "일회성경비지급자_업로드양식_작성.xlsx",
    uploadBuf as unknown as ArrayBuffer,
  );

  // 2. Per-participant individual forms + bankbook scans — bucketed into
  //    subfolders so the admin sees a clean layout. Filenames deduped
  //    against collisions (same name different participant).
  const formNames = new Map<string, number>();
  const bankbookNames = new Map<string, number>();

  for (const p of exportParticipants) {
    const safe = safeFilename(p.name || p.bookingGroupId);
    const indivBuf = await buildIndividualFormWorkbook(p);
    const indivName = dedupeName(`실험참여자비 양식_${safe}.xlsx`, formNames);
    zip.file(`실험참여자비 양식/${indivName}`, indivBuf as unknown as ArrayBuffer);

    const bb = bankbooks.get(p.bookingGroupId);
    if (bb) {
      const ext = extFromMime(bb.mime);
      const bbName = dedupeName(`통장사본_${safe}.${ext}`, bankbookNames);
      zip.file(`통장사본/${bbName}`, bb.bytes);
    }
  }

  // 3. Summary README so the admin knows what's in the bundle.
  const readme = buildReadme(exportParticipants);
  zip.file("README.txt", readme);

  const zipBuffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  const totalKrw = exportParticipants.reduce((a, p) => a + p.amountKrw, 0);

  return {
    zipBuffer,
    participantCount: exportParticipants.length,
    totalKrw,
    includedBookingGroupIds: rows.map((r) => r.bookingGroupId),
  };
}

function buildReadme(participants: ExportParticipant[]): string {
  const lines: string[] = [];
  lines.push(`실험참여자비 청구 번들`);
  lines.push(`생성 시각: ${new Date().toISOString()}`);
  lines.push(`참가자 수: ${participants.length}명`);
  lines.push(
    `총 청구액: ${participants.reduce((a, p) => a + p.amountKrw, 0).toLocaleString()}원`,
  );
  lines.push("");
  lines.push("포함된 파일:");
  lines.push("  일회성경비지급자_업로드양식_작성.xlsx (행정 제출 파일)");
  lines.push("  실험참여자비 양식/ (참가자별 청구서)");
  lines.push("  통장사본/ (참가자별 통장 사본)");
  lines.push("");
  lines.push("참가자 목록:");
  for (const p of participants) {
    lines.push(
      `  - ${p.name.padEnd(8, " ")}  ${p.amountKrw.toLocaleString().padStart(10, " ")}원  ${p.bankName ?? "-"}`,
    );
  }
  return lines.join("\n");
}
