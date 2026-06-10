// scripts/regenerate-payment-bundle.ts
//
// Regenerate the 행정-submittable participant-fee bundle for an existing
// experiment WITHOUT mutating any participant_payment_info status. Used
// when a previously-generated bundle was malformed (e.g. before the
// 2026-05-08 template-preservation fix) and needs to be re-emitted with
// the same set of participants.
//
// Usage:
//   npx tsx scripts/regenerate-payment-bundle.ts <exp-id-or-title-substring> [--out=PATH]
//
// Behaviour:
//   - SELECT-only against participant_payment_info (any status).
//   - Decrypts RRN locally using PAYMENT_INFO_KEY_V{N} from .env.local.
//   - Writes the bundle ZIP to <out> (default ~/Downloads/<expTitle>_<YYYYMMDD>_<N>명.zip)
//     and also drops the unzipped per-participant xlsx files alongside
//     so the user can open them directly.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import JSZip from "jszip";
import {
  buildIndividualFormWorkbook,
  buildUploadFormWorkbook,
  formatDateSpan,
  type ExportParticipant,
} from "../src/lib/payments/excel.js";

// .env.local loader (no dotenv dep — keep this script lean).
async function loadEnvLocal(): Promise<void> {
  const envPath = path.join(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return;
  const content = await readFile(envPath, "utf8");
  for (const line of content.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function isoToHHMM(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

function totalHours(
  sessions: Array<{ slot_start: string; slot_end: string }>,
): number {
  const ms = sessions.reduce(
    (a, s) =>
      a +
      (new Date(s.slot_end).getTime() - new Date(s.slot_start).getTime()),
    0,
  );
  return Math.round((ms / (1000 * 60 * 60)) * 10) / 10;
}

function safeFilename(raw: string): string {
  return (raw.trim() || "참가자")
    .replace(/[\\/:*?"<>|\r\n\t]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 80);
}

async function findExperiment(
  sb: SupabaseClient,
  query: string,
): Promise<{ id: string; title: string; location_id: string | null } | null> {
  // UUID? exact match.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(query)) {
    const { data } = await sb
      .from("experiments")
      .select("id, title, location_id")
      .eq("id", query)
      .maybeSingle();
    return (data as never) ?? null;
  }
  const { data: matches } = await sb
    .from("experiments")
    .select("id, title, location_id, status, created_at")
    .ilike("title", `%${query}%`)
    .order("created_at", { ascending: false })
    .limit(10);
  if (!matches || matches.length === 0) return null;
  if (matches.length > 1) {
    console.error(`Multiple experiments matched "${query}":`);
    for (const m of matches as Array<{
      id: string;
      title: string;
      status: string;
      created_at: string;
    }>) {
      console.error(`  ${m.id}  [${m.status}]  ${m.title}  (${m.created_at})`);
    }
    console.error("Pass an exact id.");
    return null;
  }
  return matches[0] as never;
}

async function fetchAllPaymentRows(
  sb: SupabaseClient,
  experimentId: string,
  statusFilter: string[] | null,
) {
  let query = sb
    .from("participant_payment_info")
    .select(
      "participant_id, booking_group_id, rrn_cipher, rrn_iv, rrn_tag, rrn_key_version, bank_name, account_number, account_holder, institution, signature_path, bankbook_path, bankbook_mime_type, period_start, period_end, amount_krw, status, name_override, email_override, phone, submitted_at, participants(name, email, phone, birthdate)",
    )
    .eq("experiment_id", experimentId)
    .order("submitted_at", { ascending: true });
  if (statusFilter && statusFilter.length > 0) {
    query = query.in("status", statusFilter);
  }
  const { data: rows, error } = await query;
  if (error) throw new Error(`payment_info fetch: ${error.message}`);
  return rows ?? [];
}

async function main() {
  await loadEnvLocal();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
    process.exit(1);
  }

  const arg = process.argv[2];
  if (!arg) {
    console.error(
      "Usage: npx tsx scripts/regenerate-payment-bundle.ts <exp-id-or-title-substring> [--out=DIR]",
    );
    process.exit(1);
  }

  const outArg = process.argv.find((a) => a.startsWith("--out="));
  const baseOutDir = outArg
    ? outArg.slice("--out=".length)
    : path.join(os.homedir(), "Downloads");

  // Status filter — default to the two states most likely to mean
  // "currently in flight": submitted_to_admin (not yet bundled) and
  // claimed (already bundled but maybe with a broken format we want to
  // re-emit). Pass --status=all for no filter, or --status=submitted_to_admin
  // / claimed / paid_offline for a single state.
  const statusArg = process.argv.find((a) => a.startsWith("--status="));
  const statusValue = statusArg ? statusArg.slice("--status=".length) : "regen";
  const statusFilter: string[] | null = (() => {
    if (statusValue === "all") return null;
    if (statusValue === "regen") return ["submitted_to_admin", "claimed"];
    return statusValue.split(",").map((s) => s.trim()).filter(Boolean);
  })();

  const sb = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log(`Looking up experiment by "${arg}"…`);
  const exp = await findExperiment(sb, arg);
  if (!exp) {
    console.error("No matching experiment.");
    process.exit(1);
  }
  console.log(`  ✓ ${exp.id}  ${exp.title}`);

  let locationName: string | null = null;
  if (exp.location_id) {
    const { data } = await sb
      .from("experiment_locations")
      .select("name")
      .eq("id", exp.location_id)
      .maybeSingle();
    locationName = (data as { name: string } | null)?.name ?? null;
    console.log(`  Location: ${locationName ?? "(none)"}`);
  }

  console.log(
    `Fetching participant_payment_info rows (status filter: ${
      statusFilter ? statusFilter.join("|") : "ALL"
    })…`,
  );
  const rows = await fetchAllPaymentRows(sb, exp.id, statusFilter);
  console.log(`  ${rows.length} payment rows`);

  if (rows.length === 0) {
    console.error("No payment rows for this experiment. Nothing to regenerate.");
    process.exit(1);
  }

  // Show status histogram so the operator knows which rows they're
  // including (regen does not respect the submitted_to_admin filter).
  const statusHist = new Map<string, number>();
  for (const r of rows as Array<{ status: string }>) {
    statusHist.set(r.status, (statusHist.get(r.status) ?? 0) + 1);
  }
  console.log("  Status histogram:");
  for (const [s, n] of statusHist) console.log(`    ${s}: ${n}`);

  const bgIds = (rows as Array<{ booking_group_id: string }>).map(
    (r) => r.booking_group_id,
  );
  console.log("Fetching session timestamps…");
  const { data: bookings } = await sb
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

  console.log("Downloading signatures + bankbooks…");
  const signatures = new Map<string, Buffer>();
  const bankbooks = new Map<string, { bytes: Buffer; mime: string }>();
  await Promise.all(
    (rows as Array<{
      booking_group_id: string;
      signature_path: string | null;
      bankbook_path: string | null;
      bankbook_mime_type: string | null;
    }>).map(async (r) => {
      if (r.signature_path) {
        const { data } = await sb.storage
          .from("participant-signatures")
          .download(r.signature_path);
        if (data) {
          signatures.set(
            r.booking_group_id,
            Buffer.from(await data.arrayBuffer()),
          );
        }
      }
      if (r.bankbook_path) {
        const { data } = await sb.storage
          .from("participant-bankbooks")
          .download(r.bankbook_path);
        if (data) {
          bankbooks.set(r.booking_group_id, {
            bytes: Buffer.from(await data.arrayBuffer()),
            mime: r.bankbook_mime_type ?? "application/octet-stream",
          });
        }
      }
    }),
  );
  console.log(`  ${signatures.size} signatures, ${bankbooks.size} bankbooks`);

  const exportParticipants: ExportParticipant[] = (
    rows as unknown as Array<{
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
      period_start: string | null;
      period_end: string | null;
      amount_krw: number;
      name_override: string | null;
      email_override: string | null;
      phone: string | null;
      // Supabase JS surfaces foreign-row joins as arrays at the type
      // level even when the relationship is many-to-one. Coerce via
      // unknown above; here we describe the runtime shape we actually
      // get for one-to-one joins.
      participants: {
        name: string;
        email: string | null;
        phone: string | null;
        birthdate: string | null;
      } | null;
    }>
  ).map((r) => {
    const sessions = sessionsBy.get(r.booking_group_id) ?? [];
    const last = sessions[sessions.length - 1];
    return {
      participantId: r.participant_id,
      bookingGroupId: r.booking_group_id,
      name: r.name_override ?? r.participants?.name ?? "",
      email: r.email_override ?? r.participants?.email ?? null,
      phone: r.phone ?? r.participants?.phone ?? null,
      rrnCipher: r.rrn_cipher,
      rrnIv: r.rrn_iv,
      rrnTag: r.rrn_tag,
      rrnKeyVersion: r.rrn_key_version,
      bankName: r.bank_name,
      accountNumber: r.account_number,
      accountHolder: r.account_holder,
      signaturePng: signatures.get(r.booking_group_id) ?? null,
      periodStart: r.period_start,
      periodEnd: r.period_end,
      amountKrw: r.amount_krw,
      sessionCount: sessions.length,
      institution: r.institution ?? "서울대학교",
      experimentTitle: exp.title,
      locationName,
      activityDateSpan: formatDateSpan(r.period_start, r.period_end),
      lastSessionStart: last ? isoToHHMM(last.slot_start) : null,
      lastSessionEnd: last ? isoToHHMM(last.slot_end) : null,
      purpose: "지각적 의사결정 오프라인 실험 참여",
      researcherName: "-",
      participantBirthdate: r.participants?.birthdate ?? null,
    };
  });

  console.log("\nBuilding workbooks…");
  const zip = new JSZip();

  const uploadBuf = await buildUploadFormWorkbook(exportParticipants);
  zip.file("일회성경비지급자_업로드양식_작성.xlsx", uploadBuf);
  console.log(`  + 일회성경비지급자_업로드양식_작성.xlsx (${uploadBuf.length} bytes)`);

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

  const indivBuffers: Array<{ filename: string; buf: Buffer }> = [];
  for (const p of exportParticipants) {
    const buf = await buildIndividualFormWorkbook(p);
    const name = dedupe(`실험참여자비 양식_${safeFilename(p.name)}.xlsx`);
    zip.file(name, buf);
    indivBuffers.push({ filename: name, buf });
    console.log(`  + ${name} (${buf.length} bytes)`);
  }

  // Bankbooks zip
  const bankbookZip = new JSZip();
  let bankbookCount = 0;
  for (const p of exportParticipants) {
    const bb = bankbooks.get(p.bookingGroupId);
    if (!bb) continue;
    const ext =
      bb.mime === "image/png"
        ? "png"
        : bb.mime === "image/jpeg"
          ? "jpg"
          : bb.mime === "application/pdf"
            ? "pdf"
            : "bin";
    bankbookZip.file(`통장사본_${safeFilename(p.name)}.${ext}`, bb.bytes);
    bankbookCount++;
  }
  if (bankbookCount > 0) {
    const bbBuf = await bankbookZip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });
    zip.file("통장사본.zip", bbBuf);
    console.log(`  + 통장사본.zip (${bbBuf.length} bytes, ${bankbookCount} files)`);
  }

  const totalKrw = exportParticipants.reduce((a, p) => a + p.amountKrw, 0);
  zip.file(
    "README.txt",
    [
      `실험참여자비 청구 번들 (재생성)`,
      `실험: ${exp.title}`,
      `생성 시각: ${new Date().toISOString()}`,
      `참가자 수: ${exportParticipants.length}명`,
      `총 청구액: ${totalKrw.toLocaleString()}원`,
      ``,
      `포함된 파일:`,
      `  ① 일회성경비지급자_업로드양식_작성.xlsx — 행정 제출용 통합 파일`,
      `  ② 실험참여자비 양식_*.xlsx — 참가자별 청구서 (서명 임베드)`,
      `  ③ 통장사본.zip — 참가자별 통장 사본 모음`,
      ``,
      `참가자 목록:`,
      ...exportParticipants.map(
        (p) =>
          `  - ${p.name.padEnd(8, " ")}  ${p.amountKrw.toLocaleString().padStart(10, " ")}원  ${p.bankName ?? "-"}`,
      ),
    ].join("\n"),
  );

  const outBuf = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const safeTitle = safeFilename(exp.title);
  const outDir = path.join(
    baseOutDir,
    `실험참여자비청구_${safeTitle}_${ymd}_${exportParticipants.length}명_REGEN`,
  );
  await mkdir(outDir, { recursive: true });

  const zipPath = `${outDir}.zip`;
  await writeFile(zipPath, outBuf);
  console.log(`\n✓ Bundle ZIP: ${zipPath} (${outBuf.length} bytes)`);

  // Also drop unzipped xlsx files in the dir for easy preview.
  await writeFile(
    path.join(outDir, "일회성경비지급자_업로드양식_작성.xlsx"),
    uploadBuf,
  );
  for (const { filename, buf } of indivBuffers) {
    await writeFile(path.join(outDir, filename), buf);
  }
  console.log(`✓ Unzipped previews: ${outDir}/`);
  console.log(`\nDone.`);
}

main().catch((err) => {
  console.error("\n[regenerate-payment-bundle] FAILED:", err);
  process.exit(1);
});
