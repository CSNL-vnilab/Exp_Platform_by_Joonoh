import crypto from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";

// Lab-scoped pseudonymous identity for a participant.
//
// Scheme: public_code = `${lab.code}-${base32(hmac-sha256(salt, key))[:6]}`
// where `key` = normalized_phone || birthdate || name_lower.
//
// The salt lives in labs.participant_id_salt (bytea). Rows in
// participant_lab_identity are only readable via service-role (RLS gates
// researchers out of identity_hmac), so we ALWAYS use createAdminClient()
// here.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // no I, L, O, U
const PUBLIC_CODE_LEN = 6;
const MAX_COLLISION_RETRIES = 5;

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

function normalizePhone(phone: string | null | undefined): string {
  if (!phone) return "";
  return phone.replace(/\D/g, "");
}

function normalizeName(name: string | null | undefined): string {
  if (!name) return "";
  // NFKC normalize + lowercase + trim. Keeps CJK characters as-is.
  return name.normalize("NFKC").trim().toLowerCase();
}

function normalizeBirthdate(birthdate: string | null | undefined): string {
  if (!birthdate) return "";
  // Accepts "YYYY-MM-DD" or any ISO-ish prefix — slice to date.
  return birthdate.slice(0, 10);
}

function buildIdentityKey(
  phone: string | null | undefined,
  birthdate: string | null | undefined,
  name: string | null | undefined,
): string {
  // Pipe separator keeps fields unambiguous across values that might contain
  // digits/spaces. Empty fields are tolerated so new participants with only
  // a partial record can still be fingerprinted.
  return [
    normalizePhone(phone),
    normalizeBirthdate(birthdate),
    normalizeName(name),
  ].join("|");
}

// ---------------------------------------------------------------------------
// Salt decoding — PostgREST surfaces bytea as `\x<hex>` by default.
// ---------------------------------------------------------------------------

function decodeSalt(raw: string): Buffer {
  if (typeof raw !== "string") {
    throw new Error("lab.participant_id_salt is not a string");
  }
  if (raw.startsWith("\\x")) {
    return Buffer.from(raw.slice(2), "hex");
  }
  // Fallbacks for tests / alternate encodings.
  if (/^[0-9a-f]+$/i.test(raw) && raw.length % 2 === 0) {
    return Buffer.from(raw, "hex");
  }
  // Last-ditch: try base64.
  return Buffer.from(raw, "base64");
}

// ---------------------------------------------------------------------------
// Base32 (Crockford) encoding of a Buffer → uppercase string.
// ---------------------------------------------------------------------------

function crockfordBase32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += CROCKFORD[(value << (5 - bits)) & 31];
  }
  return out;
}

function computeHmac(salt: Buffer, key: string, counter = 0): Buffer {
  const h = crypto.createHmac("sha256", salt);
  h.update(key);
  if (counter > 0) {
    h.update(`#${counter}`);
  }
  return h.digest();
}

function truncateToPublic(code: string, truncated: string): string {
  return `${code}-${truncated}`;
}

// ---------------------------------------------------------------------------
// Internal lookup helpers
// ---------------------------------------------------------------------------

interface LabRow {
  id: string;
  code: string;
  participant_id_salt: string;
}

interface ParticipantPiiRow {
  id: string;
  name: string;
  phone: string;
  birthdate: string;
}

async function fetchLab(
  admin: ReturnType<typeof createAdminClient>,
  labId: string,
): Promise<LabRow | null> {
  const { data } = await admin
    .from("labs")
    .select("id, code, participant_id_salt")
    .eq("id", labId)
    .maybeSingle();
  return (data as LabRow | null) ?? null;
}

async function fetchParticipant(
  admin: ReturnType<typeof createAdminClient>,
  participantId: string,
): Promise<ParticipantPiiRow | null> {
  const { data } = await admin
    .from("participants")
    .select("id, name, phone, birthdate")
    .eq("id", participantId)
    .maybeSingle();
  return (data as ParticipantPiiRow | null) ?? null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface EnsureIdentityResult {
  publicCode: string;
}

/**
 * Idempotently ensures a (participant, lab) row in participant_lab_identity
 * exists, returning its public_code. Safe to call repeatedly from the
 * post-booking pipeline.
 */
export async function ensureParticipantLabIdentity(
  participantId: string,
  labId: string,
): Promise<EnsureIdentityResult> {
  const admin = createAdminClient();

  // Fast path — row already exists.
  const { data: existing } = await admin
    .from("participant_lab_identity")
    .select("public_code")
    .eq("participant_id", participantId)
    .eq("lab_id", labId)
    .maybeSingle();

  if (existing?.public_code) {
    return { publicCode: existing.public_code };
  }

  const [lab, participant] = await Promise.all([
    fetchLab(admin, labId),
    fetchParticipant(admin, participantId),
  ]);

  if (!lab) throw new Error(`Lab ${labId} not found`);
  if (!participant) throw new Error(`Participant ${participantId} not found`);

  const salt = decodeSalt(lab.participant_id_salt);
  const key = buildIdentityKey(
    participant.phone,
    participant.birthdate,
    participant.name,
  );

  // Try: base code → rehash with counter on collision.
  let lastErrorMessage = "";
  for (let attempt = 0; attempt <= MAX_COLLISION_RETRIES; attempt++) {
    const hmac = computeHmac(salt, key, attempt);
    const b32 = crockfordBase32(hmac);
    const truncated = b32.slice(0, PUBLIC_CODE_LEN);
    const publicCode = truncateToPublic(lab.code, truncated);
    // identity_hmac is the full HMAC for this (participant, lab) regardless
    // of counter — but we only ever dedupe on public_code, so a counter-bumped
    // HMAC is what actually lands.
    const identityHmacHex = `\\x${hmac.toString("hex")}`;

    const { error } = await admin.from("participant_lab_identity").insert({
      participant_id: participantId,
      lab_id: labId,
      public_code: publicCode,
      identity_hmac: identityHmacHex,
    });

    if (!error) {
      return { publicCode };
    }

    lastErrorMessage = error.message ?? "";
    // Postgres unique-violation code is 23505. The error shape from
    // supabase-js exposes `code` on PostgrestError; we also fall back to
    // substring matching for extra safety.
    const isUnique =
      (error as { code?: string }).code === "23505" ||
      /duplicate key|unique/i.test(lastErrorMessage);

    if (!isUnique) {
      throw new Error(
        `Failed to insert participant_lab_identity: ${lastErrorMessage}`,
      );
    }

    // Unique violation could also be a concurrent insert winning the race —
    // re-read and return if the row now exists for THIS participant.
    const { data: raced } = await admin
      .from("participant_lab_identity")
      .select("public_code")
      .eq("participant_id", participantId)
      .eq("lab_id", labId)
      .maybeSingle();
    if (raced?.public_code) {
      return { publicCode: raced.public_code };
    }
    // Otherwise the collision was on lab_id+public_code or lab_id+identity_hmac
    // against a DIFFERENT participant — bump counter and try again.
  }

  throw new Error(
    `Could not allocate a unique public_code after ${MAX_COLLISION_RETRIES} retries: ${lastErrorMessage}`,
  );
}

/**
 * Reverse lookup — given a lab code + public_code, return the participant id
 * (or null if no match). Used by Stream C's Notion survey mirror.
 */
export async function getParticipantByPublicCode(
  labCode: string,
  publicCode: string,
): Promise<{ participantId: string } | null> {
  const admin = createAdminClient();

  const { data: lab } = await admin
    .from("labs")
    .select("id")
    .eq("code", labCode)
    .maybeSingle();
  if (!lab?.id) return null;

  const { data } = await admin
    .from("participant_lab_identity")
    .select("participant_id")
    .eq("lab_id", lab.id)
    .eq("public_code", publicCode)
    .maybeSingle();

  if (!data?.participant_id) return null;
  return { participantId: data.participant_id };
}
