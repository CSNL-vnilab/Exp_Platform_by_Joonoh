import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifyPaymentToken, PaymentTokenError } from "@/lib/payments/token";
import { validateRrn } from "@/lib/payments/rrn";
import { encryptRrn } from "@/lib/crypto/payment-info";

// POST /api/payment-info/:token/submit
//
// Participant submits encrypted RRN + bank + signature + bankbook scan.
//
// Flow:
//   1. Stateless-verify the token (HMAC check).
//   2. Look up the payment_info row by token_hash; reject if revoked /
//      already-submitted / status mismatch.
//   3. Verify all bookings in the group have slot_end <= now. Multi-
//      session experiments cannot be settled until every session is done.
//   4. Validate RRN (shape + checksum + birthdate sanity).
//   5. Parse signature PNG data URL; parse bankbook data URL; magic-byte
//      verify both; upload to their respective Storage buckets.
//   6. Encrypt RRN, update the payment_info row (compare-and-swap on
//      status), flip status to 'submitted_to_admin', revoke the token.
//
// Security notes:
//   - All user-facing errors for "cannot submit" collapse to a single
//     generic "링크가 유효하지 않거나 이미 제출되었습니다" so a caller
//     can't enumerate token lifecycle state.
//   - Token is revoked on successful submission (token_revoked_at set) so
//     a captured URL can't be replayed even within TTL.
//   - MIME types are sniffed from magic bytes, not trusted from the
//     client-supplied data URL.
//   - Error messages from Supabase updates touching RRN columns are
//     truncated to the status code; never the full .message (which can
//     echo row values in constraint violations).

interface BankbookInput {
  dataUrl?: unknown;
  fileName?: unknown;
  mimeType?: unknown;
}

interface SubmitBody {
  rrn?: unknown;
  bankName?: unknown;
  accountNumber?: unknown;
  accountHolder?: unknown;
  institution?: unknown;
  signaturePng?: unknown;
  bankbook?: BankbookInput;
}

const MAX_SIGNATURE_BYTES = 400 * 1024; // 400 KiB (signature PNGs are small)
const MAX_BANKBOOK_BYTES = 5 * 1024 * 1024; // 5 MiB
// Base64 encodes roughly 4 bytes per 3 input → 1.35x blowup. Caps below
// bound request body size *before* we call Buffer.from.
const MAX_SIGNATURE_B64 = Math.ceil((MAX_SIGNATURE_BYTES * 4) / 3) + 64;
const MAX_BANKBOOK_B64 = Math.ceil((MAX_BANKBOOK_BYTES * 4) / 3) + 64;

const ALLOWED_BANKBOOK_MIME = new Set([
  "image/png",
  "image/jpeg",
  "application/pdf",
]);
const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "application/pdf": "pdf",
};

// Single error string for every "cannot submit" outcome so lifecycle
// state can't be probed by an attacker with a guessed/stolen token.
const GENERIC_REJECT = "링크가 유효하지 않거나 이미 제출되었습니다.";

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function jsonError(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

function parseDataUrl(
  input: string,
  allowedMime: ReadonlySet<string>,
  maxBase64Length: number,
): { mime: string; bytes: Buffer } | null {
  // Bound *encoded* length first — avoids decoding 50 MiB into a Buffer
  // just to reject it after.
  if (input.length > maxBase64Length + 64) return null;
  const m = input.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return null;
  const mime = m[1].toLowerCase();
  if (!allowedMime.has(mime)) return null;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(m[2], "base64");
  } catch {
    return null;
  }
  if (bytes.length === 0) return null;
  return { mime, bytes };
}

// Magic-byte sniff — don't trust the client's Content-Type. A malicious
// upload could claim image/png while containing SVG / HTML / an ELF.
function sniffMime(bytes: Buffer): "image/png" | "image/jpeg" | "application/pdf" | null {
  if (bytes.length < 8) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  ) {
    return "application/pdf";
  }
  return null;
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params;
  if (!token) return jsonError(400, "잘못된 요청입니다.");

  let verified;
  try {
    verified = verifyPaymentToken(token);
  } catch (err) {
    if (err instanceof PaymentTokenError) {
      return jsonError(401, GENERIC_REJECT);
    }
    return jsonError(500, "서버 오류가 발생했습니다.");
  }

  let body: SubmitBody;
  try {
    body = (await req.json()) as SubmitBody;
  } catch {
    return jsonError(400, "요청 형식이 잘못되었습니다.");
  }

  const {
    rrn,
    bankName,
    accountNumber,
    accountHolder,
    institution,
    signaturePng,
    bankbook,
  } = body;

  if (!isNonEmptyString(rrn)) return jsonError(400, "주민등록번호를 입력해 주세요.");
  if (!isNonEmptyString(institution)) return jsonError(400, "소속을 입력해 주세요.");
  if (!isNonEmptyString(bankName)) return jsonError(400, "은행을 선택해 주세요.");
  if (!isNonEmptyString(accountNumber))
    return jsonError(400, "계좌번호를 입력해 주세요.");
  if (!isNonEmptyString(signaturePng))
    return jsonError(400, "전자서명을 입력해 주세요.");
  if (!bankbook || typeof bankbook !== "object")
    return jsonError(400, "통장 사본을 첨부해 주세요.");
  if (!isNonEmptyString(bankbook.dataUrl))
    return jsonError(400, "통장 사본을 첨부해 주세요.");

  const rrnCheck = validateRrn(rrn);
  if (!rrnCheck.valid || !rrnCheck.normalized) {
    // Single error for any shape/checksum/date failure — prevents an
    // attacker from brute-probing valid RRNs through the endpoint.
    return jsonError(400, "주민등록번호가 올바르지 않습니다.");
  }

  // Signature: PNG only, magic-byte verified.
  const sig = parseDataUrl(signaturePng, new Set(["image/png"]), MAX_SIGNATURE_B64);
  if (!sig) return jsonError(400, "전자서명 형식이 올바르지 않습니다.");
  if (sig.bytes.length > MAX_SIGNATURE_BYTES)
    return jsonError(400, "전자서명 파일이 너무 큽니다.");
  if (sniffMime(sig.bytes) !== "image/png")
    return jsonError(400, "전자서명 파일이 손상되었거나 PNG가 아닙니다.");

  // Bankbook: PDF/PNG/JPEG, magic-byte verified.
  const bb = parseDataUrl(bankbook.dataUrl, ALLOWED_BANKBOOK_MIME, MAX_BANKBOOK_B64);
  if (!bb) return jsonError(400, "통장 사본 형식이 올바르지 않습니다.");
  if (bb.bytes.length > MAX_BANKBOOK_BYTES)
    return jsonError(400, "통장 사본 파일이 너무 큽니다 (최대 5MB).");
  const sniffed = sniffMime(bb.bytes);
  if (!sniffed || sniffed !== bb.mime) {
    return jsonError(400, "통장 사본 파일이 손상되었거나 형식이 일치하지 않습니다.");
  }

  const supabase = createAdminClient();

  const { data: info } = await supabase
    .from("participant_payment_info")
    .select(
      "id, experiment_id, booking_group_id, status, token_hash, token_revoked_at",
    )
    .eq("booking_group_id", verified.bookingGroupId)
    .maybeSingle();

  // All "can't proceed" states return the same generic message — no
  // probing (not-found / bad-hash / revoked / already-submitted).
  if (!info) return jsonError(401, GENERIC_REJECT);
  if (info.token_hash !== verified.hash) return jsonError(401, GENERIC_REJECT);
  if (info.token_revoked_at) return jsonError(401, GENERIC_REJECT);
  if (info.status !== "pending_participant") {
    return jsonError(401, GENERIC_REJECT);
  }

  // Multi-session completion gate: every booking in this group must have
  // ended. No partial settlements.
  const { data: bookings } = await supabase
    .from("bookings")
    .select("slot_end, status")
    .eq("booking_group_id", info.booking_group_id);
  if (!bookings || bookings.length === 0) {
    // payment_info exists but bookings were cascade-deleted — this is an
    // abnormal state (researcher deleted the experiment). Collapse to
    // the same generic reject so state can't be probed.
    return jsonError(401, GENERIC_REJECT);
  }
  const now = Date.now();
  const pending = bookings.filter(
    (b) => b.status === "confirmed" && new Date(b.slot_end).getTime() > now,
  );
  if (pending.length > 0) {
    return jsonError(409, "모든 실험 세션이 종료된 후에 제출할 수 있습니다.");
  }

  // Storage paths scoped by experiment_id folder (for researcher RLS via
  // folder prefix) AND by a per-request nonce so two concurrent submit
  // attempts for the same booking_group_id don't clobber each other's
  // signature/bankbook blobs. Only the CAS winner's path makes it into
  // the DB row; the loser's upload becomes an orphan (harmless, a later
  // cron can purge paths not referenced by any row).
  const uploadNonce = randomBytes(8).toString("hex");
  const signaturePath = `${info.experiment_id}/${info.booking_group_id}.${uploadNonce}.png`;
  const bankbookExt = MIME_TO_EXT[bb.mime];
  const bankbookPath = `${info.experiment_id}/${info.booking_group_id}.${uploadNonce}.${bankbookExt}`;

  const { error: sigUploadErr } = await supabase.storage
    .from("participant-signatures")
    .upload(signaturePath, sig.bytes, {
      contentType: "image/png",
      upsert: true,
    });
  if (sigUploadErr) {
    // Bucket errors don't echo row data but stay generic anyway.
    console.error("[PaymentInfo] signature upload failed");
    return jsonError(500, "서명 업로드에 실패했습니다.");
  }

  const { error: bbUploadErr } = await supabase.storage
    .from("participant-bankbooks")
    .upload(bankbookPath, bb.bytes, {
      contentType: bb.mime,
      upsert: true,
    });
  if (bbUploadErr) {
    console.error("[PaymentInfo] bankbook upload failed");
    return jsonError(500, "통장 사본 업로드에 실패했습니다.");
  }

  const { cipher, iv, tag, keyVersion } = encryptRrn(rrnCheck.normalized);
  const toHex = (buf: Buffer) => `\\x${buf.toString("hex")}`;

  const nowIso = new Date().toISOString();
  const { error: updateErr, count: updatedCount } = await supabase
    .from("participant_payment_info")
    .update(
      {
        rrn_cipher: toHex(cipher),
        rrn_iv: toHex(iv),
        rrn_tag: toHex(tag),
        rrn_key_version: keyVersion,
        bank_name: bankName.trim(),
        account_number: accountNumber.trim().replace(/\s+/g, ""),
        account_holder: isNonEmptyString(accountHolder)
          ? accountHolder.trim()
          : null,
        institution: institution.trim(),
        signature_path: signaturePath,
        signed_at: nowIso,
        bankbook_path: bankbookPath,
        bankbook_mime_type: bb.mime,
        status: "submitted_to_admin",
        submitted_at: nowIso,
        // Revoke the token so a stolen URL can't be replayed — even
        // within the 60-day TTL, the server-side hash check further
        // guards against this.
        token_revoked_at: nowIso,
      },
      { count: "exact" },
    )
    .eq("id", info.id)
    .eq("status", "pending_participant"); // compare-and-swap
  if (updateErr) {
    // Never log the raw message — Supabase constraint errors can echo
    // column values including hex-encoded rrn_cipher. Status code only.
    console.error(
      "[PaymentInfo] update failed; code=",
      (updateErr as { code?: string }).code ?? "unknown",
    );
    return jsonError(500, "저장에 실패했습니다.");
  }
  // Concurrent submit race: another request flipped the status between
  // our SELECT and UPDATE. Return the generic reject so we don't silently
  // claim success for writes that didn't land.
  if ((updatedCount ?? 0) === 0) {
    return jsonError(401, GENERIC_REJECT);
  }

  return NextResponse.json({ ok: true });
}
