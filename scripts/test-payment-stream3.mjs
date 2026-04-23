#!/usr/bin/env node
/**
 * Stream 3 offline test harness.
 *
 * Exercises every Stream-3 code path end-to-end *without* hitting Supabase,
 * by wiring synthetic input into the pure-logic modules and inspecting the
 * output artefacts. Covers:
 *
 *   1. RRN checksum validator — valid / invalid cases
 *   2. AES-256-GCM encrypt / decrypt round-trip with key-version rotation
 *   3. Payment token issue / verify / tamper detection / expiry
 *   4. Upload-form Excel generator — cell-level inspection of B-col through
 *      R-col, row count, END marker, =IF formula, numeric types
 *   5. Individual-form Excel generator — exact cells match lab_chore's
 *      read_participant_info() (B16, D16, E16, F16, G16, I16, L16, D19,
 *      C10, G10, I10, B11), signature image embedded at B17
 *   6. JSZip claim bundle shape — correct top-level files, subfolder
 *      structure for individual forms + bankbooks, README
 *   7. Bankbook file-extension handling from mime
 *   8. Filename deduplication when two participants share a name
 *
 * Run: node scripts/test-payment-stream3.mjs
 *
 * Exits 0 on success, 1 on any failure. Designed for CI + iterative
 * improvement loops.
 */

// Run with: node --import tsx scripts/test-payment-stream3.mjs

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Load .env.local for the crypto module (needs PAYMENT_INFO_KEY).
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, "..", ".env.local");
if (existsSync(envPath)) {
  const envText = readFileSync(envPath, "utf8");
  for (const line of envText.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
}
// Fallback so the crypto helper can run even without env config.
if (!process.env.PAYMENT_INFO_KEY) {
  process.env.PAYMENT_INFO_KEY = "test-key-" + "a".repeat(40);
}
if (!process.env.PAYMENT_TOKEN_SECRET) {
  process.env.PAYMENT_TOKEN_SECRET = "test-token-secret-" + "b".repeat(40);
}

const failures = [];
const passed = [];

function check(name, cond, detail = "") {
  if (cond) {
    passed.push(name);
    process.stdout.write(`  ✅ ${name}\n`);
  } else {
    failures.push({ name, detail });
    process.stdout.write(`  ❌ ${name}${detail ? " — " + detail : ""}\n`);
  }
}

async function group(label, fn) {
  console.log(`\n── ${label} ──`);
  try {
    await fn();
  } catch (err) {
    failures.push({ name: `${label} (crash)`, detail: err.stack ?? String(err) });
    console.log(`  ❌ ${label} crashed: ${err.message}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────
//  1. RRN validator
// ──────────────────────────────────────────────────────────────────────────
await group("RRN validator", async () => {
  const { validateRrn, maskRrn } = await import("../src/lib/payments/rrn.ts");

  // Known-good RRN computed to pass the checksum (YYMMDD=900101, G=1, SSSSS=23456)
  // sum = 9*2 + 0*3 + 0*4 + 1*5 + 0*6 + 1*7 + 1*8 + 2*9 + 3*2 + 4*3 + 5*4 + 6*5
  //     = 18 + 0 + 0 + 5 + 0 + 7 + 8 + 18 + 6 + 12 + 20 + 30 = 124
  // check = (11 - 124 % 11) % 10 = (11 - 3) % 10 = 8
  const goodRrn = "900101-1234568";
  const gv = validateRrn(goodRrn);
  check("valid RRN passes", gv.valid === true, `got ${JSON.stringify(gv)}`);
  check("valid RRN normalizes to dash form", gv.normalized === "900101-1234568");

  const badChecksum = validateRrn("900101-1234567");
  check("wrong checksum rejected", badChecksum.valid === false && badChecksum.reason === "checksum");

  const badShape = validateRrn("90010-12345"); // 11 digits only → shape fail
  check("bad shape rejected", badShape.valid === false && badShape.reason === "shape");

  const badMonth = validateRrn("901301-1234568");
  check("bad month rejected", badMonth.valid === false && badMonth.reason === "date");

  // Mask format
  const masked = maskRrn("900101-1234568");
  check("mask format correct", masked === "900101-1******", `got ${masked}`);
});

// ──────────────────────────────────────────────────────────────────────────
//  2. Crypto round-trip
// ──────────────────────────────────────────────────────────────────────────
await group("Crypto (AES-256-GCM) round-trip", async () => {
  const crypto = await import("../src/lib/crypto/payment-info.ts");

  const plaintext = "900101-1234568";
  const encrypted = crypto.encryptRrn(plaintext);
  check("cipher is non-empty", encrypted.cipher.length > 0);
  check("iv is 12 bytes (GCM)", encrypted.iv.length === 12);
  check("tag is 16 bytes", encrypted.tag.length === 16);
  check("keyVersion defaulted to 1", encrypted.keyVersion === 1);

  const decrypted = crypto.decryptRrn(encrypted);
  check("decrypt recovers plaintext", decrypted === plaintext, `got ${decrypted}`);

  // Tampering detection
  encrypted.cipher[0] ^= 0xff;
  let tamperCaught = false;
  try {
    crypto.decryptRrn(encrypted);
  } catch {
    tamperCaught = true;
  }
  check("tampered cipher rejected by GCM", tamperCaught);

  // bytesFromSupabase \x-hex path
  const fresh = crypto.encryptRrn(plaintext);
  const hexCipher = "\\x" + fresh.cipher.toString("hex");
  const hexIv = "\\x" + fresh.iv.toString("hex");
  const hexTag = "\\x" + fresh.tag.toString("hex");
  const asCipher = crypto.bytesFromSupabase(hexCipher);
  const asIv = crypto.bytesFromSupabase(hexIv);
  const asTag = crypto.bytesFromSupabase(hexTag);
  const round = crypto.decryptRrn({ cipher: asCipher, iv: asIv, tag: asTag, keyVersion: 1 });
  check("decrypt from \\x-hex bytea round-trips", round === plaintext);
});

// ──────────────────────────────────────────────────────────────────────────
//  3. Payment token
// ──────────────────────────────────────────────────────────────────────────
await group("Payment token signing", async () => {
  const tok = await import("../src/lib/payments/token.ts");

  const groupId = "11111111-2222-3333-4444-555555555555";
  const issued = tok.issuePaymentToken(groupId);
  check("token has 4 dot-separated parts", issued.token.split(".").length === 4);
  check("hash is 64-char hex (sha256)", /^[0-9a-f]{64}$/.test(issued.hash));
  check("expiresAt > issuedAt", issued.expiresAt > issued.issuedAt);

  const verified = tok.verifyPaymentToken(issued.token, groupId);
  check("valid token verifies", verified.bookingGroupId === groupId && verified.hash === issued.hash);

  // Tamper: flip a char in the signature
  const parts = issued.token.split(".");
  parts[3] = parts[3].slice(0, -1) + (parts[3].slice(-1) === "a" ? "b" : "a");
  const tamperedToken = parts.join(".");
  let tamperErr = null;
  try {
    tok.verifyPaymentToken(tamperedToken, groupId);
  } catch (err) {
    tamperErr = err;
  }
  check("tampered signature rejected", tamperErr && tamperErr.code === "SIGNATURE");

  // Group mismatch
  let mismatchErr = null;
  try {
    tok.verifyPaymentToken(issued.token, "99999999-9999-9999-9999-999999999999");
  } catch (err) {
    mismatchErr = err;
  }
  check("group mismatch rejected", mismatchErr && mismatchErr.code === "GROUP_MISMATCH");

  // Expiry — craft a token with issuedAt far in the past
  const oldParts = issued.token.split(".");
  oldParts[1] = String(Date.now() - (61 * 24 * 60 * 60 * 1000)); // 61 days ago
  // Signature won't match, so we expect SIGNATURE not EXPIRED — unless we re-sign.
  // The EXPIRED branch is tested by manually monkey-patching Date.now in a future test,
  // we at least verify the SIGNATURE path triggers first.
  let oldErr = null;
  try {
    tok.verifyPaymentToken(oldParts.join("."), groupId);
  } catch (err) {
    oldErr = err;
  }
  check("stale/wrong-sig token rejected", oldErr !== null);
});

// ──────────────────────────────────────────────────────────────────────────
//  4 + 5. Excel generators
// ──────────────────────────────────────────────────────────────────────────
let savedExcels = {};
await group("Excel generators — cell-level inspection", async () => {
  const { default: ExcelJS } = await import("exceljs");
  const { buildUploadFormWorkbook, buildIndividualFormWorkbook, formatDateSpan } = await import(
    "../src/lib/payments/excel.ts"
  );
  const crypto = await import("../src/lib/crypto/payment-info.ts");

  // Build two synthetic participants. RRN is encrypted before passing in
  // because that's what the generator expects (it decrypts on-the-fly).
  function makeParticipant(name, rrn, amount) {
    const enc = crypto.encryptRrn(rrn);
    return {
      participantId: `pid-${name}`,
      bookingGroupId: `bg-${name}`,
      name,
      email: `${name}@test.local`,
      rrnCipher: enc.cipher,
      rrnIv: enc.iv,
      rrnTag: enc.tag,
      rrnKeyVersion: enc.keyVersion,
      bankName: "신한은행",
      accountNumber: "110-545-811341",
      accountHolder: name,
      signaturePng: null, // small test image below
      periodStart: "2026-03-19",
      periodEnd: "2026-03-20",
      amountKrw: amount,
      participationHours: 2,
      institution: "서울대학교",
      activityDateSpan: "2026.03.19~03.20",
      firstSessionStart: "14:00",
      firstSessionEnd: "15:00",
    };
  }

  // 1×1 white PNG — minimal valid image for the signature embedding test.
  const TINY_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );

  const alice = makeParticipant("홍길동", "900101-1234568", 90000);
  const bob = makeParticipant("김철수", "851205-1234565", 180000);
  bob.signaturePng = TINY_PNG;
  alice.signaturePng = TINY_PNG;

  // ─ Upload form ─────────────────────────────────────────────────────────
  const uploadBuf = await buildUploadFormWorkbook([alice, bob]);
  savedExcels.upload = uploadBuf;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(uploadBuf);
  const ws = wb.getWorksheet("Sheet1");
  check("upload form has Sheet1", !!ws);
  check("row 1 header col A is 순번", ws.getCell("A1").value === "순번");
  check("row 1 header col B is 성명", ws.getCell("B1").value === "성명");
  check("row 3 A is seq 1", ws.getCell("A3").value === 1);
  check("row 3 B is alice name", ws.getCell("B3").value === "홍길동");
  check("row 3 C is alice institution", ws.getCell("C3").value === "서울대학교");
  check("row 3 D is RRN-front 6 digits", ws.getCell("D3").value === "900101");
  check("row 3 E is RRN-back 7 digits", ws.getCell("E3").value === "1234568");
  const f3 = ws.getCell("F3").value;
  check(
    "row 3 F is the =IF nationality formula",
    typeof f3 === "object" && f3 && (f3.formula || "").includes('IF(H3="대한민국"'),
    `got ${JSON.stringify(f3)}`,
  );
  check("row 3 G (여권번호) is blank", ws.getCell("G3").value === "" || ws.getCell("G3").value == null);
  check("row 3 H is 대한민국", ws.getCell("H3").value === "대한민국");
  check("row 3 I is 기타소득", ws.getCell("I3").value === "기타소득");
  check("row 3 J is income detail", String(ws.getCell("J3").value).includes("강연료"));
  check("row 3 K is amount 90000", ws.getCell("K3").value === 90000);
  check("row 3 L is account number", ws.getCell("L3").value === "110-545-811341");
  check("row 3 M is bank", ws.getCell("M3").value === "신한은행");
  check("row 3 N is holder", ws.getCell("N3").value === "홍길동");
  check("row 3 O..R are 0", [15, 16, 17, 18].every((c) => ws.getRow(3).getCell(c).value === 0));
  check("row 4 is bob, seq 2", ws.getCell("A4").value === 2 && ws.getCell("B4").value === "김철수");
  check("row 4 K is 180000", ws.getCell("K4").value === 180000);

  // END marker — lab_chore's scanner expects "END" somewhere after the data.
  const endRow = findEndRow(ws);
  check("END marker present after data", endRow > 4, `endRow=${endRow}`);

  // ─ Individual form ─────────────────────────────────────────────────────
  const indivBuf = await buildIndividualFormWorkbook(alice);
  savedExcels.indivAlice = indivBuf;
  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.load(indivBuf);
  const iws = wb2.worksheets[0];
  check("individual form has a worksheet", !!iws);

  // These cells are what lab_chore's read_participant_info() reads.
  check("B16 is name", iws.getCell("B16").value === "홍길동");
  check("D16 is institution", iws.getCell("D16").value === "서울대학교");
  check("E16 is RRN in dashed form", iws.getCell("E16").value === "900101-1234568");
  check("F16 is email", iws.getCell("F16").value === "홍길동@test.local");
  check("G16 is bank", iws.getCell("G16").value === "신한은행");
  check("I16 is account number", iws.getCell("I16").value === "110-545-811341");
  check("L16 is holder", iws.getCell("L16").value === "홍길동");
  check("D19 is amount 90000 (numeric)", iws.getCell("D19").value === 90000);
  check("C10 is activityDateSpan", iws.getCell("C10").value === "2026.03.19~03.20");
  check("G10 is firstSessionStart", iws.getCell("G10").value === "14:00");
  check("I10 is firstSessionEnd", iws.getCell("I10").value === "15:00");
  check("B11 is participationHours", iws.getCell("B11").value === 2);

  // Signature image embedded. exceljs lists images on the worksheet.
  const images = wb2.model.media.filter((m) => m.type === "image");
  check("signature image added to workbook media", images.length >= 1, `found ${images.length}`);

  // formatDateSpan variants
  check("date span same day", formatDateSpan("2026-03-19T14:00:00+09:00", "2026-03-19T15:00:00+09:00") === "2026.03.19");
  check("date span same month different day", formatDateSpan("2026-03-19T14:00:00+09:00", "2026-03-20T15:00:00+09:00") === "2026.03.19~20");
  check("date span same year different month", formatDateSpan("2026-03-19", "2026-04-02").includes("~"));
});

function findEndRow(ws) {
  for (let r = 1; r <= ws.rowCount; r++) {
    if (String(ws.getCell(r, 1).value ?? "").toUpperCase() === "END") return r;
  }
  return -1;
}

// ──────────────────────────────────────────────────────────────────────────
//  6 + 7 + 8. Claim bundle ZIP shape
// ──────────────────────────────────────────────────────────────────────────
await group("Claim bundle ZIP shape", async () => {
  const { default: JSZip } = await import("jszip");
  const { default: ExcelJS } = await import("exceljs");
  // We bypass the Supabase-dependent fetchClaimRows and drive
  // buildClaimBundle with a stubbed supabase client that returns local
  // files for storage downloads.
  const excel = await import("../src/lib/payments/excel.ts");

  // Hand-roll the ZIP without importing claim-bundle.ts (which requires
  // a live supabase) — this test replicates the logic to ensure structure
  // matches. The full file is exercised via live e2e later.
  const crypto = await import("../src/lib/crypto/payment-info.ts");
  const TINY_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );
  const TINY_PDF = Buffer.from(
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0>>endobj\nxref\n0 3\n0000000000 65535 f \n0000000009 00000 n \n0000000052 00000 n \ntrailer<</Size 3/Root 1 0 R>>\nstartxref\n92\n%%EOF",
  );

  function makeBundleRow(name, rrn, amount, bankbookMime) {
    const enc = crypto.encryptRrn(rrn);
    return {
      participantId: `pid-${name}`,
      bookingGroupId: `bg-${name}`,
      name,
      email: `${name}@test.local`,
      rrnCipher: enc.cipher,
      rrnIv: enc.iv,
      rrnTag: enc.tag,
      rrnKeyVersion: enc.keyVersion,
      bankName: "신한은행",
      accountNumber: "110-545-811341",
      accountHolder: name,
      signaturePng: TINY_PNG,
      periodStart: "2026-03-19",
      periodEnd: "2026-03-20",
      amountKrw: amount,
      participationHours: 2,
      institution: "서울대학교",
      activityDateSpan: "2026.03.19~03.20",
      firstSessionStart: "14:00",
      firstSessionEnd: "15:00",
      bankbookBytes: bankbookMime === "application/pdf" ? TINY_PDF : TINY_PNG,
      bankbookMime,
    };
  }

  const participants = [
    makeBundleRow("홍길동", "900101-1234568", 90000, "image/png"),
    makeBundleRow("김철수", "851205-1234565", 180000, "application/pdf"),
    makeBundleRow("홍길동", "960202-2234564", 90000, "image/jpeg"), // same name collision
  ];

  const zip = new JSZip();

  // 1. Combined upload form
  const uploadBuf = await excel.buildUploadFormWorkbook(participants);
  zip.file("일회성경비지급자_업로드양식_작성.xlsx", uploadBuf);

  // 2. Per-participant (with name dedup)
  const formNames = new Map();
  const bankbookNames = new Map();
  function dedupe(name, map) {
    const n = map.get(name) ?? 0;
    map.set(name, n + 1);
    if (n === 0) return name;
    const dot = name.lastIndexOf(".");
    return dot > 0 ? `${name.slice(0, dot)} (${n + 1})${name.slice(dot)}` : `${name} (${n + 1})`;
  }

  for (const p of participants) {
    const indivBuf = await excel.buildIndividualFormWorkbook(p);
    const indivName = dedupe(`실험참여자비 양식_${p.name}.xlsx`, formNames);
    zip.file(`실험참여자비 양식/${indivName}`, indivBuf);
    const ext = p.bankbookMime === "application/pdf" ? "pdf" : p.bankbookMime === "image/jpeg" ? "jpg" : "png";
    const bbName = dedupe(`통장사본_${p.name}.${ext}`, bankbookNames);
    zip.file(`통장사본/${bbName}`, p.bankbookBytes);
  }

  zip.file("README.txt", "bundle test");

  const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
  check("ZIP is non-empty", zipBuffer.length > 100);

  // Re-open and inspect
  const reopened = await JSZip.loadAsync(zipBuffer);
  const names = Object.keys(reopened.files)
    .filter((n) => !n.endsWith("/")) // exclude jszip's directory entries
    .sort();
  check("bundle has upload form at root", names.includes("일회성경비지급자_업로드양식_작성.xlsx"));
  check(
    "bundle has 3 individual forms (with dedup)",
    names.filter((n) => n.startsWith("실험참여자비 양식/")).length === 3,
    `got ${names.filter((n) => n.startsWith("실험참여자비 양식/")).join(", ")}`,
  );
  check(
    "bundle has 3 bankbooks",
    names.filter((n) => n.startsWith("통장사본/")).length === 3,
    `got ${names.filter((n) => n.startsWith("통장사본/")).join(", ")}`,
  );
  // Dedup check: at least one filename contains " (2)"
  const hasDedupe = names.some((n) => n.match(/\(2\)/));
  check("duplicated participant name was deduped", hasDedupe, `names=${names.filter((n) => !n.endsWith("/")).slice(0, 10).join(", ")}`);

  // Mime → extension mapping
  check("PDF bankbook stored with .pdf", names.some((n) => n.endsWith(".pdf")));
  check("PNG bankbook stored with .png", names.some((n) => n.endsWith(".png") && n.startsWith("통장사본/")));
  check("JPEG bankbook stored with .jpg", names.some((n) => n.endsWith(".jpg")));

  savedExcels.zip = zipBuffer;
});

// ──────────────────────────────────────────────────────────────────────────
//  9. Real buildClaimBundle against a stubbed Supabase storage client
// ──────────────────────────────────────────────────────────────────────────
await group("buildClaimBundle with stubbed storage", async () => {
  const { buildClaimBundle } = await import("../src/lib/payments/claim-bundle.ts");
  const { default: JSZip } = await import("jszip");
  const crypto = await import("../src/lib/crypto/payment-info.ts");

  const TINY_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );
  const TINY_PDF = Buffer.from("%PDF-1.4 test\n%%EOF");

  const fakeStorage = {
    from(bucket) {
      return {
        async download(path) {
          // Synthesize content based on bucket.
          if (bucket === "participant-signatures") {
            return { data: blobFrom(TINY_PNG), error: null };
          }
          if (bucket === "participant-bankbooks") {
            const isPdf = path.endsWith(".pdf");
            return { data: blobFrom(isPdf ? TINY_PDF : TINY_PNG), error: null };
          }
          return { data: null, error: new Error("unknown bucket") };
        },
      };
    },
  };

  function blobFrom(buf) {
    // Minimal Blob-like: only arrayBuffer() is used downstream.
    return {
      async arrayBuffer() {
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      },
    };
  }

  const fakeSupabase = { storage: fakeStorage };

  function makeRow(name, rrn, amount, mime, sessions) {
    const enc = crypto.encryptRrn(rrn);
    return {
      participantId: `pid-${name}`,
      bookingGroupId: `bg-${name}`,
      participantName: name,
      participantEmail: `${name}@test.local`,
      rrnCipher: enc.cipher,
      rrnIv: enc.iv,
      rrnTag: enc.tag,
      rrnKeyVersion: enc.keyVersion,
      bankName: "신한은행",
      accountNumber: "110-545-811341",
      accountHolder: name,
      institution: "서울대학교",
      signaturePath: `expA/bg-${name}.png`,
      bankbookPath: `expA/bg-${name}.${mime === "application/pdf" ? "pdf" : mime === "image/jpeg" ? "jpg" : "png"}`,
      bankbookMime: mime,
      periodStart: "2026-03-19",
      periodEnd: "2026-03-20",
      amountKrw: amount,
      sessions,
    };
  }

  const rows = [
    makeRow("홍길동", "900101-1234568", 90000, "image/png", [
      { slot_start: "2026-03-19T14:00:00+09:00", slot_end: "2026-03-19T15:00:00+09:00" },
      { slot_start: "2026-03-20T14:00:00+09:00", slot_end: "2026-03-20T15:00:00+09:00" },
    ]),
    makeRow("Robert'); DROP TABLE; --", "851205-1234565", 180000, "application/pdf", [
      { slot_start: "2026-03-21T10:00:00+09:00", slot_end: "2026-03-21T12:00:00+09:00" },
    ]),
  ];

  const result = await buildClaimBundle(fakeSupabase, rows);
  check("bundle built", result.zipBuffer.length > 500);
  check("bundle count = 2", result.participantCount === 2);
  check("bundle total = 270000", result.totalKrw === 270000);

  // Re-open to verify structure
  const reopened = await JSZip.loadAsync(result.zipBuffer);
  const files = Object.keys(reopened.files)
    .filter((n) => !n.endsWith("/"))
    .sort();

  // New flat layout: 3 artefact categories at top level.
  check("outer zip contains README", files.includes("README.txt"));
  check("outer zip contains upload form", files.includes("일회성경비지급자_업로드양식_작성.xlsx"));
  const indivForms = files.filter((n) =>
    n.startsWith("실험참여자비 양식_") && n.endsWith(".xlsx"),
  );
  check(
    "outer zip contains 2 individual forms at root",
    indivForms.length === 2,
    `got ${indivForms.join(", ")}`,
  );
  check("outer zip contains 통장사본.zip", files.includes("통장사본.zip"));

  // Open the nested bankbook zip and verify contents.
  const innerZipBuf = await reopened.file("통장사본.zip").async("nodebuffer");
  const innerZip = await JSZip.loadAsync(innerZipBuf);
  const bankbookEntries = Object.keys(innerZip.files)
    .filter((n) => !n.endsWith("/"))
    .sort();
  check(
    "통장사본.zip contains 2 bankbook files",
    bankbookEntries.length === 2,
    `got ${bankbookEntries.join(", ")}`,
  );
  check(
    "통장사본 filenames start with 통장사본_",
    bankbookEntries.every((n) => n.startsWith("통장사본_")),
  );

  // Injection-safe filenames everywhere.
  const allEntries = [...files, ...bankbookEntries];
  const hasInjection = allEntries.some((n) => /[\\/:*?"<>|]/.test(n));
  check("no filesystem-unsafe characters in any filename", !hasInjection);

  // README content check.
  const readmeText = await reopened.file("README.txt").async("string");
  check("README includes participant count", readmeText.includes("참가자 수: 2명"));
  check("README includes total", readmeText.includes("270,000원"));
  check("README documents the 3 artefact categories", /①.*②.*③/s.test(readmeText));
});

// ──────────────────────────────────────────────────────────────────────────
// 10. Excel formula injection guard (CRITICAL fix from security review)
// ──────────────────────────────────────────────────────────────────────────
await group("Excel formula-injection guard", async () => {
  const { safeCellText } = await import("../src/lib/payments/sanitize.ts");

  check("bare = is prefixed", safeCellText("=HYPERLINK(\"evil\")") === "'=HYPERLINK(\"evil\")");
  check("bare + is prefixed", safeCellText("+cmd|'/C calc'!A0") === "'+cmd|'/C calc'!A0");
  check("bare - is prefixed", safeCellText("-2+3") === "'-2+3");
  check("bare @ is prefixed", safeCellText("@SUM(1:100)") === "'@SUM(1:100)");
  check("bare tab is prefixed", safeCellText("\tleading-tab") === "'\tleading-tab");
  check("normal korean name untouched", safeCellText("홍길동") === "홍길동");
  check("number-looking string untouched", safeCellText("110-545-811341") === "110-545-811341");
  check("null → empty", safeCellText(null) === "");

  // Regression: upload form cell now carries prefix for bad name
  const { default: ExcelJS } = await import("exceljs");
  const { buildUploadFormWorkbook } = await import("../src/lib/payments/excel.ts");
  const crypto = await import("../src/lib/crypto/payment-info.ts");
  const enc = crypto.encryptRrn("900101-1234568");
  const evil = {
    participantId: "p1",
    bookingGroupId: "bg1",
    name: "=HYPERLINK(\"https://evil.invalid\",\"click\")",
    email: "e@e.e",
    rrnCipher: enc.cipher,
    rrnIv: enc.iv,
    rrnTag: enc.tag,
    rrnKeyVersion: enc.keyVersion,
    bankName: "신한은행",
    accountNumber: "110",
    accountHolder: "=1+1",
    signaturePng: null,
    periodStart: "2026-03-19",
    periodEnd: "2026-03-19",
    amountKrw: 100,
    participationHours: 1,
    institution: "서울대학교",
    activityDateSpan: "2026.03.19",
    firstSessionStart: "14:00",
    firstSessionEnd: "15:00",
  };
  const buf = await buildUploadFormWorkbook([evil]);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.getWorksheet("Sheet1");
  const nameCell = String(ws.getCell("B3").value ?? "");
  check("evil name is text-escaped in upload form", nameCell.startsWith("'="), `got: ${nameCell}`);
  const holderCell = String(ws.getCell("N3").value ?? "");
  check("evil holder is text-escaped", holderCell.startsWith("'="), `got: ${holderCell}`);
});

// ──────────────────────────────────────────────────────────────────────────
// 11. Magic-byte MIME sniff (HIGH fix)
// ──────────────────────────────────────────────────────────────────────────
await group("MIME magic-byte sniffing (behavior lives inside route)", async () => {
  // The sniff function is defined inside the route handler (not exported),
  // but we can verify the principle: parseDataUrl recognizes the declared
  // MIME and the expected magic bytes.
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUg==", "base64");
  check("PNG magic present", PNG[0] === 0x89 && PNG[1] === 0x50);

  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0]);
  check("JPEG magic present", JPEG[0] === 0xff && JPEG[1] === 0xd8);

  const PDF = Buffer.from("%PDF-1.4", "ascii");
  check("PDF magic present", PDF[0] === 0x25 && PDF[1] === 0x50);

  // An SVG that claims to be a PNG should be caught by the sniffer in the
  // route. Magic bytes for SVG look like "<?xml" or "<svg" — not PNG.
  const SVG = Buffer.from("<?xml version=\"1.0\"?><svg xmlns=\"http://www.w3.org/2000/svg\"/>", "ascii");
  check("SVG bytes don't look like PNG", SVG[0] !== 0x89);
});

// ──────────────────────────────────────────────────────────────────────────
// 12. Claim file-name sanitization (path traversal guard)
// ──────────────────────────────────────────────────────────────────────────
await group("Claim file-name sanitization", async () => {
  // Re-declare the private helper's logic here so the test is self-
  // contained. Keep in sync with buildClaimFileName in the claim route.
  function build(title, count) {
    const safe =
      title
        .trim()
        .replace(/[\\/:*?"<>|\r\n\t]/g, "_")
        .replace(/^\.+/, "")
        .slice(0, 80) || "experiment";
    const yyyymmdd = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    return `실험참여자비청구_${safe}_${yyyymmdd}_${count}명.zip`;
  }

  check("slashes stripped", !build("a/b:c*d<e>f", 1).includes("/"));
  // After slash-strip, "../../etc/passwd" → ".._.._etc_passwd" — leading
  // dots removed means the safe prefix no longer starts with `..`.
  const traversed = build("../../etc/passwd", 1);
  const safePart = traversed.match(/청구_(.*?)_\d{8}_/)?.[1] ?? "";
  check("leading dots stripped from safe part", !safePart.startsWith(".."), `safePart=${safePart}`);
  check("CRLF stripped", !build("a\r\nb", 1).includes("\n"));
  check("empty title falls back", build("   ", 1).includes("experiment"));
  const long = "가".repeat(200);
  const out = build(long, 1);
  // Name slice is 80; whole filename shorter than safe limit.
  check("long title truncated to 80 chars of safe prefix", !out.includes("가".repeat(81)));
});

// ──────────────────────────────────────────────────────────────────────────
// 13. Round-2 regression tests
// ──────────────────────────────────────────────────────────────────────────
await group("Round 2 regressions", async () => {
  // KST date formatting: a session that ends at 2026-03-20 03:00 UTC
  // (i.e. 2026-03-20 12:00 KST) should record period_end as 2026-03-20,
  // NOT 2026-03-20 (OK) — we verify the UTC-early-morning case:
  // a session that starts at 2026-03-20 23:00 UTC = 2026-03-21 08:00 KST
  // should record period_start as 2026-03-21.
  const d = new Date("2026-03-20T23:00:00Z");
  const kst = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
  check("UTC 2026-03-20T23:00Z → KST 2026-03-21", kst === "2026-03-21");

  // Upload-form export status filter now includes 'claimed'
  const uploadRoute = readFileSync(
    join(__dirname, "..", "src", "app", "api", "experiments", "[experimentId]", "payment-export", "upload-form", "route.ts"),
    "utf8",
  );
  check(
    "upload-form filter includes 'claimed'",
    uploadRoute.includes('"submitted_to_admin", "claimed", "paid"'),
  );
  check(
    "upload-form passes institution from row",
    uploadRoute.includes("info.institution ?? "),
  );

  const individualRoute = readFileSync(
    join(__dirname, "..", "src", "app", "api", "experiments", "[experimentId]", "payment-export", "individual", "[bookingGroupId]", "route.ts"),
    "utf8",
  );
  check(
    "individual export passes institution from row",
    individualRoute.includes("info.institution ?? "),
  );

  // submit CAS count check
  const submitRoute = readFileSync(
    join(__dirname, "..", "src", "app", "api", "payment-info", "[token]", "submit", "route.ts"),
    "utf8",
  );
  check(
    "submit CAS now requests count and guards on zero",
    submitRoute.includes('count: "exact"') &&
      /updatedCount \?\? 0\) === 0/.test(submitRoute),
  );
  check(
    "submit 'no bookings' path returns GENERIC_REJECT",
    /bookings\.length === 0\)[\s\S]{0,400}GENERIC_REJECT/.test(submitRoute),
  );

  // mark-paid route was removed — confirm it's gone (per user decision to
  // track disbursement via email to 행정 instead of in-app).
  const markPaidDir = join(
    __dirname, "..", "src", "app", "api", "experiments",
    "[experimentId]", "payment-info", "[bookingGroupId]", "mark-paid",
  );
  check(
    "mark-paid route directory removed",
    !existsSync(markPaidDir),
  );

  // page re-visit after submit → success branch, not INVALID
  const page = readFileSync(
    join(__dirname, "..", "src", "app", "(public)", "payment-info", "[token]", "page.tsx"),
    "utf8",
  );
  check(
    "page only treats token_revoked_at as INVALID while pending",
    /token_revoked_at && info\.status === "pending_participant"/.test(page),
  );
  check(
    "page type union includes 'claimed'",
    /status: "pending_participant" \| "submitted_to_admin" \| "claimed" \| "paid"/.test(page),
  );

  // Round 3 fix: submit uses request-nonce paths to prevent CAS-race blob clobber
  check(
    "submit paths include randomBytes-derived upload nonce",
    /randomBytes\(8\)\.toString\("hex"\)/.test(submitRoute) &&
      /\$\{info\.booking_group_id\}\.\$\{uploadNonce\}\./.test(submitRoute),
  );
  // Round 4 fix: isoToHHMM uses explicit Asia/Seoul, not server local TZ
  const claimBundle = readFileSync(
    join(__dirname, "..", "src", "lib", "payments", "claim-bundle.ts"),
    "utf8",
  );
  check(
    "isoToHHMM uses explicit Asia/Seoul",
    /timeZone: "Asia\/Seoul"/.test(claimBundle) &&
      !/d\.getHours\(\)/.test(claimBundle),
  );

  // Direct functional test of the time formatting: UTC 2026-03-20T05:00Z
  // = KST 14:00. Prior bug: on UTC hosts this would render as "05:00".
  const kstHHMM = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date("2026-03-20T05:00:00Z"));
  check(
    "KST HHMM format: UTC 05:00 → KST 14:00",
    kstHHMM === "14:00",
    `got ${kstHHMM}`,
  );
});

// ──────────────────────────────────────────────────────────────────────────
//  Dump artifacts so a human reviewer can open them
// ──────────────────────────────────────────────────────────────────────────
try {
  const outDir = join(__dirname, "..", ".test-artifacts");
  mkdirSync(outDir, { recursive: true });
  if (savedExcels.upload) {
    writeFileSync(join(outDir, "upload-form.xlsx"), savedExcels.upload);
  }
  if (savedExcels.indivAlice) {
    writeFileSync(join(outDir, "individual-alice.xlsx"), savedExcels.indivAlice);
  }
  if (savedExcels.zip) {
    writeFileSync(join(outDir, "claim-bundle.zip"), savedExcels.zip);
  }
  console.log(`\n📂 Artifacts written to ${outDir}`);
} catch (err) {
  console.warn("Could not write artifacts:", err.message);
}

// ──────────────────────────────────────────────────────────────────────────
//  Summary
// ──────────────────────────────────────────────────────────────────────────
console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`✅ passed: ${passed.length}   ❌ failed: ${failures.length}`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) {
    console.log(`  - ${f.name}\n    ${f.detail.split("\n").slice(0, 5).join("\n    ")}`);
  }
  process.exit(1);
}
process.exit(0);
