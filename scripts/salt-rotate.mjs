#!/usr/bin/env node
// Salt rotation for labs.participant_id_salt.
//
// Rotates the HMAC salt for one lab (by --lab-code, default CSNL) and
// recomputes identity_hmac for every row in participant_lab_identity.
// public_code is NOT rotated — it's already shipped to Notion and must
// remain stable. Only identity_hmac (the dedup key) changes.
//
// Flow:
//   1. Read current salt from labs via Management API (service-role).
//   2. Generate fresh 32 random bytes.
//   3. DRY-RUN by default: print how many rows would be updated + a few
//      preview hashes. Require --confirm to actually write.
//   4. Transactional UPDATE: move current → previous, set new salt + timestamp.
//   5. For each participant_lab_identity row, recompute identity_hmac in
//      a single SQL batch using pg_crypto's hmac() + the new salt.
//      (Avoids round-tripping every row via Node; the input bytes are
//      already on the DB since we store normalized_phone/birthdate/name
//      as participants columns.)
//
// Runbook: docs/salt-rotation.md.
// Pre-req migration: 00033 (adds participant_id_salt_previous + salt_rotated_at).
//
// Usage:
//   node scripts/salt-rotate.mjs              # dry-run
//   node scripts/salt-rotate.mjs --confirm    # actually rotate
//   node scripts/salt-rotate.mjs --lab-code=CSNL --confirm

import crypto from "node:crypto";
import { readFile } from "node:fs/promises";

const envText = await readFile(".env.local", "utf8");
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
}
const token = process.env.SUPABASE_ACCESS_TOKEN;
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
if (!token || !url) {
  console.error("Missing SUPABASE_ACCESS_TOKEN or NEXT_PUBLIC_SUPABASE_URL");
  process.exit(1);
}
const ref = url.match(/https?:\/\/([a-z0-9]+)\.supabase\.co/i)[1];

const args = process.argv.slice(2);
const confirm = args.includes("--confirm");
const labArg = args.find((a) => a.startsWith("--lab-code="));
const labCode = labArg ? labArg.split("=")[1] : "CSNL";

async function sql(q) {
  const r = await fetch(
    `https://api.supabase.com/v1/projects/${ref}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: q }),
    },
  );
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`sql ${r.status}: ${body.slice(0, 300)}`);
  }
  return r.json();
}

function sqlBytea(buf) {
  // Postgres hex bytea literal: '\xABCD…'
  return `'\\x${buf.toString("hex")}'`;
}

function sqlString(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

console.log(`Salt rotation · lab=${labCode} · mode=${confirm ? "EXECUTE" : "DRY-RUN"}`);
console.log("─".repeat(70));

// Step 1: look up lab + count of identity rows.
const labRow = (
  await sql(
    `SELECT id, code, salt_rotated_at FROM labs WHERE code=${sqlString(labCode)}`,
  )
)[0];
if (!labRow) {
  console.error(`Lab '${labCode}' not found`);
  process.exit(1);
}
console.log(`Lab id=${labRow.id}  last rotated=${labRow.salt_rotated_at ?? "(never)"}`);

const countRow = (
  await sql(
    `SELECT COUNT(*)::int AS n FROM participant_lab_identity WHERE lab_id=${sqlString(labRow.id)}`,
  )
)[0];
console.log(`Identity rows to rehash: ${countRow.n}`);

// Step 2: generate salt.
const newSalt = crypto.randomBytes(32);
console.log(`New salt: \\x${newSalt.toString("hex").slice(0, 16)}… (32 bytes)`);

// Step 3: dry-run preview — show HMACs for 3 sample identities using both
// old and new salt so the operator can verify the rehash logic before
// committing.
const samples = await sql(
  `SELECT pli.identity_hmac::text AS old_hmac, p.phone, p.birthdate, lower(p.name) AS name_lc
   FROM participant_lab_identity pli
   JOIN participants p ON p.id = pli.participant_id
   WHERE pli.lab_id=${sqlString(labRow.id)}
   LIMIT 3`,
);
if (samples.length > 0) {
  console.log("Sample rehash preview (old → new):");
  for (const s of samples) {
    const input = `${(s.phone ?? "").replace(/\D/g, "")}|${s.birthdate ?? ""}|${(s.name_lc ?? "")}`;
    const newHash = crypto
      .createHmac("sha256", newSalt)
      .update(input)
      .digest("hex");
    console.log(`  ${s.old_hmac.slice(0, 20)}… → ${newHash.slice(0, 20)}…`);
  }
}

if (!confirm) {
  console.log("\n(dry-run — pass --confirm to execute)");
  process.exit(0);
}

// Step 4 + 5: transactional rotation + HMAC rebuild. All in one SQL block.
// The HMAC recompute uses pgcrypto.hmac() — available on Supabase by default.
// HMAC input must match src/lib/participants/identity.ts:buildIdentityKey.
// Current app formula (verified against identity.ts):
//   key = normalized_phone + '|' + birthdate + '|' + lower(NFKC(name))
// SQL can't do NFKC normalization natively. For latin/ascii names this is
// a no-op; for Korean names with composed Hangul this is already NFKC.
// If any participant.name was stored in NFD form, it would produce a
// different HMAC than identity.ts on next lookup — flag for manual review.
const rotateSql = `
BEGIN;

UPDATE labs
SET participant_id_salt_previous = participant_id_salt,
    participant_id_salt = ${sqlBytea(newSalt)},
    salt_rotated_at = now()
WHERE id = ${sqlString(labRow.id)};

-- Recompute identity_hmac for every row in this lab. Using pgcrypto so
-- we don't have to stream every participant back to Node.
UPDATE participant_lab_identity pli
SET identity_hmac = extensions.hmac(
  (
    regexp_replace(p.phone, '[^0-9]', '', 'g')
    || '|' || p.birthdate::text
    || '|' || lower(p.name)
  ),
  ${sqlBytea(newSalt)},
  'sha256'
)
FROM participants p
WHERE p.id = pli.participant_id
  AND pli.lab_id = ${sqlString(labRow.id)};

COMMIT;
`;

console.log("\nExecuting rotation transaction…");
await sql(rotateSql);

// Verify.
const [{ rotated, after_count }] = await sql(
  `SELECT (SELECT salt_rotated_at FROM labs WHERE id=${sqlString(labRow.id)}) AS rotated,
          (SELECT COUNT(*)::int FROM participant_lab_identity WHERE lab_id=${sqlString(labRow.id)}) AS after_count`,
);

console.log(`\n✅ Rotation complete`);
console.log(`   salt_rotated_at = ${rotated}`);
console.log(`   rows in lab     = ${after_count}`);
console.log(`\nReminder: participant_id_salt_previous stays populated for 30d`);
console.log(`as a grace window. Null it out in a follow-up rotation or via`);
console.log(`  UPDATE labs SET participant_id_salt_previous=NULL WHERE id=…;`);
