import type { createAdminClient } from "@/lib/supabase/admin";

type AdminClient = ReturnType<typeof createAdminClient>;

// Shared traversal for the participant runtime-data layout in the
// `experiment-data` bucket. Both the JSON export (data-export/route.ts) and
// the CSV export (data-export-csv/route.ts) read these block files; keeping
// the walk in one place stops the two exports from drifting when the storage
// layout changes (e.g. multi-session sub-folders).
//
// Layout (see data/{bookingId}/block/route.ts):
//   experiment-data/{experimentId}/{subjectFolder}/block_{N}.json
//   experiment-data/{experimentId}/{subjectFolder}/session_{S}/block_{N}.json   (rounds 2+)
//   experiment-data/{experimentId}/_pilot/{subjectFolder}/...                    (pilot runs)
//
// The session is derived from the path: a `session_{N}` segment ⇒ session N,
// otherwise session 1 (legacy / single-session / round 1) — older block JSONs
// don't carry the session in their body.

const SESSION_DIR = /^session_(\d+)$/;

export interface ExperimentBlockEntry {
  path: string;
  session: number;
  size_bytes: number | null;
  last_modified: string | null;
}

function entryMeta(entry: {
  metadata?: { size?: unknown } | null;
  updated_at?: string | null;
}): Pick<ExperimentBlockEntry, "size_bytes" | "last_modified"> {
  return {
    size_bytes:
      typeof entry.metadata?.size === "number" ? entry.metadata.size : null,
    last_modified: entry.updated_at ?? null,
  };
}

// Supabase Storage `.list` caps each page at `limit` (max 1000) and silently
// returns only the first page — any directory with >1000 entries loses the
// tail with no error. This helper pages through with an offset loop until a
// short page arrives, so every level (root subject folders, blocks under a
// subject, blocks under session_{N}/, _pilot sub-folders) sees its full
// contents. Returns the accumulated entries with the same element shape as a
// single `.list` call.
type StorageListEntry = {
  name: string;
  metadata?: { size?: unknown } | null;
  updated_at?: string | null;
};

const LIST_PAGE = 1000;

async function listAll(
  admin: AdminClient,
  dir: string,
): Promise<StorageListEntry[]> {
  const all: StorageListEntry[] = [];
  for (let offset = 0; ; offset += LIST_PAGE) {
    const { data: page } = await admin.storage
      .from("experiment-data")
      .list(dir, { limit: LIST_PAGE, offset });
    const batch = (page ?? []) as StorageListEntry[];
    all.push(...batch);
    // A short (or empty) page means we've reached the end. An exact-multiple
    // dataset triggers one extra empty fetch, which is the correct terminator.
    if (batch.length < LIST_PAGE) break;
  }
  return all;
}

// Lists every block JSON directly under `dir` plus those nested under any
// `session_{N}/` sub-folder, returning one entry per block file.
async function listSubjectBlocks(
  admin: AdminClient,
  dir: string,
): Promise<ExperimentBlockEntry[]> {
  const out: ExperimentBlockEntry[] = [];
  const entries = await listAll(admin, dir);
  for (const e of entries) {
    if (!e.name) continue;
    if (e.name.endsWith(".json")) {
      // Bare block file ⇒ session 1 (legacy / single-session / round 1).
      out.push({ path: `${dir}/${e.name}`, session: 1, ...entryMeta(e) });
      continue;
    }
    const m = SESSION_DIR.exec(e.name);
    if (m) {
      const session = parseInt(m[1], 10);
      const files = await listAll(admin, `${dir}/${e.name}`);
      for (const blk of files) {
        if (blk.name?.endsWith(".json"))
          out.push({
            path: `${dir}/${e.name}/${blk.name}`,
            session,
            ...entryMeta(blk),
          });
      }
    }
  }
  return out;
}

// Enumerates every block JSON for an experiment, descending through subject
// folders, multi-session `session_{N}/` sub-folders, and (optionally) the
// `_pilot/{subject}` tree. Returns {path, session} for each block file.
export async function listExperimentBlocks(
  admin: AdminClient,
  experimentId: string,
  { includePilot = false }: { includePilot?: boolean } = {},
): Promise<ExperimentBlockEntry[]> {
  const rootList = await listAll(admin, experimentId);

  const blocks: ExperimentBlockEntry[] = [];
  for (const entry of rootList) {
    if (!entry.name) continue;
    if (entry.name === "_pilot") {
      if (!includePilot) continue;
      // recurse one level into _pilot/{sbj}, then session-aware below it
      const pilotSubs = await listAll(admin, `${experimentId}/_pilot`);
      for (const ps of pilotSubs) {
        if (!ps.name) continue;
        blocks.push(
          ...(await listSubjectBlocks(admin, `${experimentId}/_pilot/${ps.name}`)),
        );
      }
    } else {
      blocks.push(...(await listSubjectBlocks(admin, `${experimentId}/${entry.name}`)));
    }
  }
  return blocks;
}
