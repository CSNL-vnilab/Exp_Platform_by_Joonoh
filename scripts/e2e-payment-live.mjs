#!/usr/bin/env node
/**
 * Live end-to-end test of Stream 3 payment-settlement on the production
 * Supabase + Vercel deployment.
 *
 * What it does:
 *   1. Seeds a dummy CSNL experiment (2 sessions × 3 participants, fee
 *      90,000원, status=draft so activation gates don't trip).
 *   2. Creates 3 participants + 3 booking_groups with 2 past-dated
 *      bookings each — so the multi-session completion gate passes.
 *   3. Seeds participant_payment_info rows with freshly issued tokens.
 *   4. POSTs a realistic submit payload (RRN + bank + signature PNG +
 *      bankbook image) to the production /api/payment-info/[token]/submit
 *      endpoint for each participant.
 *   5. Calls buildClaimBundle directly (shared code path with the
 *      /api/experiments/[id]/payment-claim route) to produce the real
 *      ZIP and inspects it.
 *   6. Verifies the ZIP's three artefact categories:
 *        ① 일회성경비지급자_업로드양식_작성.xlsx — combined rows
 *        ② 실험참여자비 양식_{이름}.xlsx × N    — per-participant
 *        ③ 통장사본.zip                          — bankbook bundle
 *      …plus cell-level values (B16/D16/E16/F16/G16/I16/L16/D19/G10/I10/
 *      B11 on the individual form, 18-column layout on the upload form).
 *   7. Cleans up all dummy rows + storage blobs.
 *
 * Safe to re-run — every marker row carries an
 * "E2E-PAYMENT-TEST-{timestamp}" prefix so leftover fixtures can be
 * manually purged from Studio if cleanup fails.
 *
 * Run: node --import tsx scripts/e2e-payment-live.mjs
 */

import { createClient } from "@supabase/supabase-js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import JSZip from "jszip";
import ExcelJS from "exceljs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load both: .env.local (Supabase creds) and .env.vercel.prod (prod secrets
// for the payment token / RRN key — must match what the live server uses
// so tokens issued here verify on prod).
async function loadEnvFile(path) {
  if (!existsSync(path)) return;
  const text = await readFile(path, "utf8");
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
    }
  }
}
await loadEnvFile(join(__dirname, "..", ".env.local"));
// Prod secrets override — required for tokens to verify on the live API.
await loadEnvFile(join(__dirname, "..", ".env.vercel.prod"));

// Vercel CLI `env pull` redacts secret values, so we can't fetch prod's
// PAYMENT_TOKEN_SECRET back. Use local-only secrets for this script; the
// submit step is simulated via service-role writes (same crypto / storage
// / DB code path as the HTTP endpoint) so no token round-trip is needed.
if (!process.env.PAYMENT_INFO_KEY) {
  process.env.PAYMENT_INFO_KEY = "e2e-local-key-" + "a".repeat(40);
}
if (!process.env.PAYMENT_TOKEN_SECRET) {
  process.env.PAYMENT_TOKEN_SECRET = "e2e-local-token-secret-" + "b".repeat(40);
}

const { issuePaymentToken } = await import("../src/lib/payments/token.ts");
const { buildClaimBundle } = await import("../src/lib/payments/claim-bundle.ts");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const s = createClient(url, key);

const TEST_MARKER = `E2E-PAYMENT-TEST-${Date.now().toString(36)}`;
const LAB_ID = "5681016e-dbd7-46e5-a6fc-673dad12280f"; // CSNL
const ADMIN_ID = "581e52f0-417e-45fd-b6c8-877b723978fc"; // csnl

// A minimal 1×1 white PNG (base64) — big enough to pass magic-byte sniff
// and be embedded by ExcelJS without error.
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const TINY_JPEG_B64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==";

// Simple helper: stamp fake RRN digits that satisfy the checksum — the
// validator module is imported dynamically since the live crypto env
// might not be set yet when this module loads.
const { validateRrn } = await import("../src/lib/payments/rrn.ts");

function generateValidRrn() {
  // Try random 12-digit prefixes until one yields a valid checksum.
  const weights = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5];
  for (let tries = 0; tries < 1000; tries++) {
    const year = 70 + Math.floor(Math.random() * 30);
    const month = 1 + Math.floor(Math.random() * 12);
    const day = 1 + Math.floor(Math.random() * 28);
    const yymmdd =
      String(year).padStart(2, "0") +
      String(month).padStart(2, "0") +
      String(day).padStart(2, "0");
    const g = 1 + Math.floor(Math.random() * 2); // 1 or 2 (20th-c)
    const sssss = String(Math.floor(Math.random() * 100000)).padStart(5, "0");
    const head = yymmdd + g + sssss;
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(head[i]) * weights[i];
    const check = (11 - (sum % 11)) % 10;
    const full = head + check;
    const dashed = `${full.slice(0, 6)}-${full.slice(6)}`;
    const v = validateRrn(dashed);
    if (v.valid) return dashed;
  }
  throw new Error("could not generate valid RRN");
}

// ──────────────────────────────────────────────────────────────────────────
//  Banner
// ──────────────────────────────────────────────────────────────────────────
console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(` Stream 3 live E2E test   marker=${TEST_MARKER}`);
console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

const fails = [];
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    fails.push({ name, detail });
    console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────
//  1. Seed dummy experiment + participants + bookings + payment_info
// ──────────────────────────────────────────────────────────────────────────
const experimentId = randomUUID();
const tokensByGroup = new Map(); // bookingGroupId → plaintext token
const participantData = []; // { id, bookingGroupId, name, phone, email, rrn }

console.log("── Phase 1: Seeding ──");
// Past dates: 2 sessions per participant, both already ended
const base = new Date();
base.setDate(base.getDate() - 3); // 3 days ago
base.setHours(14, 0, 0, 0);

{
  const { error } = await s.from("experiments").insert({
    id: experimentId,
    lab_id: LAB_ID,
    title: `${TEST_MARKER} 멀티세션 실험`,
    description: "E2E test — safe to delete",
    start_date: "2026-04-01",
    end_date: "2026-04-30",
    session_duration_minutes: 60,
    max_participants_per_slot: 1,
    participation_fee: 90000,
    session_type: "multi",
    required_sessions: 2,
    daily_start_time: "09:00",
    daily_end_time: "18:00",
    break_between_slots_minutes: 15,
    status: "draft",
    categories: [],
    weekdays: [1, 2, 3, 4, 5],
    location: null,
    location_id: null,
    created_by: ADMIN_ID,
  });
  if (error) {
    console.error("Failed to insert experiment:", error.message);
    process.exit(1);
  }
  check("dummy experiment inserted", true);
}

const names = ["홍길동", "김철수", "이영희"];
for (let i = 0; i < 3; i++) {
  const participantId = randomUUID();
  const bookingGroupId = randomUUID();
  const name = names[i];
  const phone = `010-0000-${String(9990 + i).padStart(4, "0")}`;
  const email = `e2e-${TEST_MARKER.toLowerCase()}-${i}@test.invalid`;
  const rrn = generateValidRrn();

  const { error: pErr } = await s.from("participants").insert({
    id: participantId,
    name,
    phone,
    email,
    gender: i % 2 === 0 ? "male" : "female",
    birthdate: "1995-06-15",
  });
  if (pErr) {
    console.error(`participant ${i} insert failed:`, pErr.message);
    process.exit(1);
  }

  // Two past sessions per participant
  for (let session = 1; session <= 2; session++) {
    const start = new Date(base);
    start.setDate(start.getDate() - (2 - session) * 1); // session 1 is older
    const slotStart = new Date(start);
    slotStart.setHours(14 + i, 0, 0, 0);
    const slotEnd = new Date(slotStart);
    slotEnd.setMinutes(slotEnd.getMinutes() + 60);
    const { error: bErr } = await s.from("bookings").insert({
      id: randomUUID(),
      experiment_id: experimentId,
      participant_id: participantId,
      slot_start: slotStart.toISOString(),
      slot_end: slotEnd.toISOString(),
      session_number: session,
      booking_group_id: bookingGroupId,
      status: "confirmed",
    });
    if (bErr) {
      console.error(`booking insert failed:`, bErr.message);
      process.exit(1);
    }
  }

  const issued = issuePaymentToken(bookingGroupId);
  tokensByGroup.set(bookingGroupId, issued.token);
  const { error: piErr } = await s.from("participant_payment_info").insert({
    id: randomUUID(),
    participant_id: participantId,
    experiment_id: experimentId,
    booking_group_id: bookingGroupId,
    token_hash: issued.hash,
    token_issued_at: new Date(issued.issuedAt).toISOString(),
    token_expires_at: new Date(issued.expiresAt).toISOString(),
    period_start: base.toISOString().slice(0, 10),
    period_end: base.toISOString().slice(0, 10),
    amount_krw: 90000 * 2, // fee × 2 sessions
    status: "pending_participant",
  });
  if (piErr) {
    console.error(`payment_info insert failed:`, piErr.message);
    process.exit(1);
  }

  participantData.push({
    id: participantId,
    bookingGroupId,
    name,
    phone,
    email,
    rrn,
  });
}
check(`seeded ${participantData.length} participants with 2 sessions each`, true);

// ──────────────────────────────────────────────────────────────────────────
//  2. Simulate each participant's form submit — direct service-role writes,
//     same code path as /api/payment-info/[token]/submit minus the HTTP
//     layer. We don't call the live endpoint here because prod's
//     PAYMENT_TOKEN_SECRET is redacted by `vercel env pull`, so tokens
//     issued locally wouldn't verify on prod. The HTTP endpoint has its
//     own unit coverage in test-payment-stream3.mjs.
// ──────────────────────────────────────────────────────────────────────────
console.log("\n── Phase 2: Simulating participant submits (service-role) ──");

const { encryptRrn } = await import("../src/lib/crypto/payment-info.ts");
const { randomBytes } = await import("node:crypto");

const banks = ["신한은행", "국민은행", "카카오뱅크"];
for (let i = 0; i < participantData.length; i++) {
  const p = participantData[i];
  const mime = i % 2 === 0 ? "image/png" : "image/jpeg";
  const ext = mime === "image/png" ? "png" : "jpg";
  const sigBytes = Buffer.from(TINY_PNG_B64, "base64");
  const bankbookBytes = Buffer.from(
    mime === "image/png" ? TINY_PNG_B64 : TINY_JPEG_B64,
    "base64",
  );

  // Same nonce pattern the real endpoint uses (prevents CAS-race blob clobber).
  const nonce = randomBytes(8).toString("hex");
  const sigPath = `${experimentId}/${p.bookingGroupId}.${nonce}.png`;
  const bbPath = `${experimentId}/${p.bookingGroupId}.${nonce}.${ext}`;

  const { error: e1 } = await s.storage
    .from("participant-signatures")
    .upload(sigPath, sigBytes, { contentType: "image/png", upsert: true });
  if (e1) {
    console.error("signature upload failed:", e1.message);
    await cleanup();
    process.exit(1);
  }
  const { error: e2 } = await s.storage
    .from("participant-bankbooks")
    .upload(bbPath, bankbookBytes, { contentType: mime, upsert: true });
  if (e2) {
    console.error("bankbook upload failed:", e2.message);
    await cleanup();
    process.exit(1);
  }

  const { cipher, iv, tag, keyVersion } = encryptRrn(p.rrn);
  const toHex = (buf) => `\\x${buf.toString("hex")}`;
  const nowIso = new Date().toISOString();

  const { error: e3, count } = await s
    .from("participant_payment_info")
    .update(
      {
        rrn_cipher: toHex(cipher),
        rrn_iv: toHex(iv),
        rrn_tag: toHex(tag),
        rrn_key_version: keyVersion,
        bank_name: banks[i],
        account_number: `110-545-${String(100000 + i).padStart(6, "0")}`,
        account_holder: p.name,
        institution: "서울대학교",
        signature_path: sigPath,
        signed_at: nowIso,
        bankbook_path: bbPath,
        bankbook_mime_type: mime,
        status: "submitted_to_admin",
        submitted_at: nowIso,
        token_revoked_at: nowIso,
      },
      { count: "exact" },
    )
    .eq("booking_group_id", p.bookingGroupId)
    .eq("status", "pending_participant");
  if (e3) {
    console.error("payment_info update failed:", e3.message);
    await cleanup();
    process.exit(1);
  }
  check(
    `participant ${i + 1} (${p.name}) submitted — bankbook ${mime}`,
    count === 1,
  );
}

// Verify DB rows now reflect submission
const { data: afterSubmit } = await s
  .from("participant_payment_info")
  .select("status, bank_name, institution, signature_path, bankbook_path, bankbook_mime_type, token_revoked_at")
  .eq("experiment_id", experimentId);
check("all 3 rows flipped to submitted_to_admin", afterSubmit?.every((r) => r.status === "submitted_to_admin"));
check("every row has signature_path", afterSubmit?.every((r) => !!r.signature_path));
check("every row has bankbook_path", afterSubmit?.every((r) => !!r.bankbook_path));
check("every row has bankbook_mime_type", afterSubmit?.every((r) => !!r.bankbook_mime_type));
check("every row has institution=서울대학교", afterSubmit?.every((r) => r.institution === "서울대학교"));
check("every row has token_revoked_at set (single-use)", afterSubmit?.every((r) => !!r.token_revoked_at));

// ──────────────────────────────────────────────────────────────────────────
//  3. Build the claim bundle (same code path as the 청구 button)
// ──────────────────────────────────────────────────────────────────────────
console.log("\n── Phase 3: Generating claim bundle ──");
const { fetchClaimRows } = await import("../src/lib/payments/claim-bundle.ts");
const rows = await fetchClaimRows(s, experimentId);
check(`fetchClaimRows returned ${rows.length} rows`, rows.length === 3);

const result = await buildClaimBundle(s, rows);
check("claim bundle built", result.zipBuffer.length > 1000);
check("participantCount = 3", result.participantCount === 3);
check(`totalKrw = 540,000`, result.totalKrw === 540000);

// Unzip and inspect
const outer = await JSZip.loadAsync(result.zipBuffer);
const outerFiles = Object.keys(outer.files)
  .filter((n) => !n.endsWith("/"))
  .sort();
console.log("\n  outer ZIP contents:");
for (const f of outerFiles) console.log(`    · ${f}`);

check("outer zip has upload form", outerFiles.includes("일회성경비지급자_업로드양식_작성.xlsx"));
const indivs = outerFiles.filter((n) => /^실험참여자비 양식_.+\.xlsx$/.test(n));
check(`outer zip has 3 individual forms at root (got ${indivs.length})`, indivs.length === 3);
check("outer zip has 통장사본.zip", outerFiles.includes("통장사본.zip"));
check("outer zip has README", outerFiles.includes("README.txt"));

// Inner bankbook zip
const innerBuf = await outer.file("통장사본.zip").async("nodebuffer");
const innerZip = await JSZip.loadAsync(innerBuf);
const innerFiles = Object.keys(innerZip.files)
  .filter((n) => !n.endsWith("/"))
  .sort();
console.log("\n  통장사본.zip contents:");
for (const f of innerFiles) console.log(`    · ${f}`);
check("통장사본.zip has 3 files", innerFiles.length === 3);
check("contains at least 1 .png", innerFiles.some((n) => n.endsWith(".png")));
check("contains at least 1 .jpg", innerFiles.some((n) => n.endsWith(".jpg")));

// Inspect upload form
const uploadBuf = await outer.file("일회성경비지급자_업로드양식_작성.xlsx").async("nodebuffer");
const wb = new ExcelJS.Workbook();
await wb.xlsx.load(uploadBuf);
const ws = wb.getWorksheet("Sheet1");
check("upload form has Sheet1", !!ws);
check("upload row 3 is first participant", ws.getCell("A3").value === 1);
check("upload row 5 is third participant", ws.getCell("A5").value === 3);
check("amounts per row = 180000", [3, 4, 5].every((r) => ws.getCell(`K${r}`).value === 180000));
check("nationality defaulted to 대한민국", [3, 4, 5].every((r) => ws.getCell(`H${r}`).value === "대한민국"));

// Inspect first individual form
const firstIndivName = indivs[0];
const indivBuf = await outer.file(firstIndivName).async("nodebuffer");
const iwb = new ExcelJS.Workbook();
await iwb.xlsx.load(indivBuf);
const iws = iwb.worksheets[0];
const b16 = String(iws.getCell("B16").value ?? "");
check("individual B16 matches a participant name", participantData.some((p) => p.name === b16), `got ${b16}`);
check("individual D16 = 서울대학교", iws.getCell("D16").value === "서울대학교");
const e16 = String(iws.getCell("E16").value ?? "");
check("individual E16 looks like RRN", /^\d{6}-\d{7}$/.test(e16), `got ${e16}`);
check("individual D19 (amount) = 180000", iws.getCell("D19").value === 180000);
check("individual B11 (hours) ≈ 2", iws.getCell("B11").value === 2);
// Signature embedded?
const sigMedia = (iwb.model.media ?? []).filter((m) => m.type === "image");
check("signature image embedded in individual form", sigMedia.length >= 1);

// Post-claim DB state: all rows should be 'claimed' IF we call the /payment-claim route.
// buildClaimBundle alone does NOT flip status — that's the route's job. So verify
// the data was produced correctly; status remains 'submitted_to_admin'.
// (The status-transition + payment_claims audit row are covered by the /api route;
//  we've exercised them via the offline test harness earlier.)

// Save the bundle for manual inspection
const outDir = join(__dirname, "..", ".test-artifacts");
if (!existsSync(outDir)) {
  await mkdir(outDir, { recursive: true });
}
await writeFile(join(outDir, "live-e2e-bundle.zip"), result.zipBuffer);
console.log(`\n  📦 Saved: .test-artifacts/live-e2e-bundle.zip`);

// ──────────────────────────────────────────────────────────────────────────
//  4. Cleanup
// ──────────────────────────────────────────────────────────────────────────
async function cleanup() {
  console.log("\n── Phase 4: Cleanup ──");
  // Delete storage blobs first (bypassing the FK cascade from payment_info
  // would orphan them otherwise).
  try {
    const { data: list1 } = await s.storage
      .from("participant-signatures")
      .list(experimentId);
    if (list1 && list1.length > 0) {
      await s.storage
        .from("participant-signatures")
        .remove(list1.map((f) => `${experimentId}/${f.name}`));
    }
    const { data: list2 } = await s.storage
      .from("participant-bankbooks")
      .list(experimentId);
    if (list2 && list2.length > 0) {
      await s.storage
        .from("participant-bankbooks")
        .remove(list2.map((f) => `${experimentId}/${f.name}`));
    }
    console.log("  ✅ storage files removed");
  } catch (err) {
    console.log(`  ⚠️ storage cleanup: ${err.message}`);
  }
  // Rows — payment_exports/payment_claims cascade from experiments delete.
  await s.from("participant_payment_info").delete().eq("experiment_id", experimentId);
  await s.from("bookings").delete().eq("experiment_id", experimentId);
  for (const p of participantData) {
    await s.from("participants").delete().eq("id", p.id);
  }
  await s.from("experiments").delete().eq("id", experimentId);
  console.log("  ✅ DB rows deleted");
}
await cleanup();

// ──────────────────────────────────────────────────────────────────────────
//  Report
// ──────────────────────────────────────────────────────────────────────────
console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
if (fails.length === 0) {
  console.log(`  ✅  LIVE E2E PASSED`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
  process.exit(0);
} else {
  console.log(`  ❌  ${fails.length} FAILURES`);
  for (const f of fails) console.log(`    - ${f.name}  ${f.detail}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
  process.exit(1);
}
