import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// AES-256-GCM symmetric encryption for short-lived secrets (e.g. pending
// researcher passwords awaiting admin approval). The key is derived from
// REGISTRATION_SECRET if set, otherwise from SUPABASE_SERVICE_ROLE_KEY, so
// the app works without additional env setup while still pinning the key
// to a server-only secret.

function getKey(): Buffer {
  const source =
    process.env.REGISTRATION_SECRET ??
    process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!source) {
    throw new Error("REGISTRATION_SECRET or SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  return createHash("sha256").update(source).digest();
}

export interface EncryptedBlob {
  cipher: Buffer;
  iv: Buffer;
  tag: Buffer;
}

export function encryptString(plaintext: string): EncryptedBlob {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { cipher: enc, iv, tag };
}

export function decryptString(blob: { cipher: Buffer; iv: Buffer; tag: Buffer }): string {
  const decipher = createDecipheriv("aes-256-gcm", getKey(), blob.iv);
  decipher.setAuthTag(blob.tag);
  const dec = Buffer.concat([decipher.update(blob.cipher), decipher.final()]);
  return dec.toString("utf8");
}
