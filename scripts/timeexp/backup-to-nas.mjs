#!/usr/bin/env node
// Mirror TimeExpOnline data from Supabase Storage to a mounted NAS path,
// preserving the {experiment_id}/{subject}/block_{N}.json layout.
//
// Designed to run from a host that has the lab NAS mounted at
// $NAS_MOUNT_PATH (defaults to /Volumes/CSNL_new/people/JOP/Magnitude/
// Experiment/results/TimeExpOnline1_demo). Idempotent — files already on
// disk with matching size are skipped. Per Q8 the canonical data store
// stays Supabase; this script is a periodic snapshot for offline
// analysis + disaster recovery.
//
// Usage:
//   NAS_MOUNT_PATH=/Volumes/CSNL_new/.../TimeExpOnline1_demo \
//   EXPERIMENT_ID=<uuid of TimeExpOnline1_demo experiment> \
//     node scripts/timeexp/backup-to-nas.mjs
//
// Requires SUPABASE_SERVICE_ROLE_KEY + NEXT_PUBLIC_SUPABASE_URL in env
// (same as scripts/apply-migration-mgmt.mjs). When run from GH Actions
// against an unmounted runner, point NAS_MOUNT_PATH at a writable dir
// and rsync to the real NAS in a second step.
//
// Exit code 0 = at least one new file mirrored; 1 = error; 2 = no
// experiment id supplied / nothing to do.

import { createClient } from "@supabase/supabase-js";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadEnv() {
  const text = await readFile(join(__dirname, "..", "..", ".env.local"), "utf8").catch(
    () => "",
  );
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    if (!process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
    }
  }
}
await loadEnv();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const expId = process.env.EXPERIMENT_ID;
if (!expId) {
  console.error("EXPERIMENT_ID env var (target experiment uuid) is required");
  console.error(
    "  hint: query `SELECT id FROM experiments WHERE title ILIKE 'TimeExpOnline1_demo%'` in Supabase",
  );
  process.exit(2);
}
const nasRoot =
  process.env.NAS_MOUNT_PATH ||
  "/Volumes/CSNL_new/people/JOP/Magnitude/Experiment/results/TimeExpOnline1_demo";

const supa = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function listAll(prefix) {
  // supabase-js list() paginates; iterate until no more.
  const out = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supa.storage
      .from("experiment-data")
      .list(prefix, { limit: 1000, offset });
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const item of data) out.push({ ...item, prefix });
    if (data.length < 1000) break;
    offset += data.length;
  }
  return out;
}

async function listSubjects(expRoot) {
  // First level: subject-number directories.
  const top = await supa.storage.from("experiment-data").list(expRoot, { limit: 1000 });
  if (top.error) throw top.error;
  return (top.data || []).filter((d) => !d.id); // directory entries have null id
}

async function ensureNasReachable(path) {
  try {
    await mkdir(path, { recursive: true });
  } catch (err) {
    throw new Error(`NAS_MOUNT_PATH not writable at ${path}: ${err.message}`);
  }
}

async function downloadIfChanged(remoteKey, localPath, expectedBytes) {
  // Skip if size matches; cheaper than re-downloading.
  try {
    const s = await stat(localPath);
    if (typeof expectedBytes === "number" && s.size === expectedBytes) return false;
  } catch {
    /* doesn't exist yet */
  }
  const { data, error } = await supa.storage.from("experiment-data").download(remoteKey);
  if (error) throw error;
  const buf = Buffer.from(await data.arrayBuffer());
  await mkdir(dirname(localPath), { recursive: true });
  await writeFile(localPath, buf);
  return true;
}

async function main() {
  await ensureNasReachable(nasRoot);
  const expRoot = expId;
  const subjects = await listSubjects(expRoot);
  console.log(
    `[backup-to-nas] experiment=${expId} subjects=${subjects.length} → ${nasRoot}`,
  );
  let mirrored = 0;
  let skipped = 0;
  let failed = 0;

  for (const subj of subjects) {
    const subjPrefix = `${expRoot}/${subj.name}`;
    // The subject directory may contain block_N.json files at top level
    // (live runs) and a `_pilot/` sub-prefix (pilot runs, kept on the
    // backup just in case the analyst wants to compare).
    for (const sub of [
      subjPrefix,
      `${subjPrefix}/_pilot/${subj.name}`, // legacy pilot path used by the platform
    ]) {
      let entries;
      try {
        entries = await listAll(sub);
      } catch (err) {
        console.error(`  ${sub}: list error ${err.message}`);
        failed++;
        continue;
      }
      for (const e of entries) {
        if (e.name.endsWith("/")) continue;
        const remoteKey = `${sub}/${e.name}`;
        const localPath = join(nasRoot, subj.name, sub.includes("_pilot") ? "_pilot" : "", e.name);
        try {
          const wrote = await downloadIfChanged(
            remoteKey,
            localPath,
            e.metadata && e.metadata.size,
          );
          if (wrote) mirrored++;
          else skipped++;
        } catch (err) {
          console.error(`  ${remoteKey}: download error ${err.message}`);
          failed++;
        }
      }
    }
  }

  console.log(
    `[backup-to-nas] done — mirrored=${mirrored} skipped=${skipped} failed=${failed}`,
  );
  if (failed > 0) process.exit(1);
  if (mirrored === 0 && skipped === 0) process.exit(2);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
