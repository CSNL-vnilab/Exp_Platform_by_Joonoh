import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireExperimentAccess } from "@/lib/auth/experiment-access";
import { listExperimentBlocks } from "@/lib/storage/experiment-blocks";

// GET /api/experiments/:id/data-export-csv?include_pilot=1
//
// Researcher-only. Walks every block_*.json uploaded by participants of
// this experiment, flattens trials into rows, and emits UTF-8 BOM CSV.
// Keyed on `subject_number, block_index, trial_index`. Every trial key that
// appears across the dataset becomes a column; missing values blank. Header
// always contains: subject_number, block_index, trial_index, condition,
// is_pilot, submitted_at, plus a dynamic set of trial-level keys.
//
// Pilot rows are excluded by default; pass `?include_pilot=1` to keep them.
// Header stays stable across runs of the same experiment (alphabetical order
// after the fixed leading columns) so R/Python pipelines can `read_csv` idempotently.

const FIXED_COLS = [
  "subject_number",
  "session",
  "block_index",
  "trial_index",
  "condition",
  "is_pilot",
  "submitted_at",
] as const;

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ experimentId: string }> },
) {
  const { experimentId } = await params;

  const access = await requireExperimentAccess(experimentId, {
    extraColumns: "experiment_mode, title, project_name",
  });
  if (access instanceof NextResponse) return access;
  const { admin } = access;
  const exp = access.experiment as unknown as {
    id: string;
    created_by: string | null;
    experiment_mode: string | null;
    title: string | null;
    project_name: string | null;
  };

  if (exp.experiment_mode === "offline") {
    return NextResponse.json(
      { error: "Offline experiment; no runtime trial data" },
      { status: 400 },
    );
  }

  const includePilot = new URL(request.url).searchParams.get("include_pilot") === "1";

  // Enumerate every block JSON, descending into multi-session `session_{N}/`
  // sub-folders and (when requested) the `_pilot` tree. Shared with the JSON
  // export via listExperimentBlocks so the two exports can't drift on
  // storage-layout changes. The session is derived from the path: a
  // `session_{N}` segment ⇒ session N, otherwise session 1.
  const blockEntries = await listExperimentBlocks(admin, experimentId, {
    includePilot,
  });

  // Download + parse each
  interface Block {
    block_index: number;
    trials: Array<Record<string, unknown>>;
    block_metadata?: Record<string, unknown>;
    submitted_at: string;
    subject_number: number | null;
    is_pilot?: boolean;
    condition_assignment?: string | null;
    // Session is derived from the storage path (see listSubjectBlocks), not
    // the block body — older block JSONs don't carry it.
    session?: number;
  }
  const blocks: Block[] = [];
  for (const { path: p, session } of blockEntries) {
    const { data, error } = await admin.storage.from("experiment-data").download(p);
    if (error || !data) continue;
    try {
      const parsedBlock = JSON.parse(await data.text()) as Block;
      parsedBlock.session = session;
      blocks.push(parsedBlock);
    } catch {
      // malformed — skip silently; researcher can re-check via JSON export
    }
  }

  // Collect dynamic trial-level keys (union across all trials)
  const dynamicKeys = new Set<string>();
  for (const b of blocks)
    for (const t of b.trials ?? [])
      for (const k of Object.keys(t))
        dynamicKeys.add(k);
  // exclude keys that would collide with fixed columns
  for (const k of FIXED_COLS) dynamicKeys.delete(k);
  const ordered = Array.from(dynamicKeys).sort();
  const header = [...FIXED_COLS, ...ordered];

  // Stream the output rows instead of materialising `lines: string[]` and
  // then `lines.join("\n")` — for a 200-participant × 100-trial dataset the
  // join creates a single ~20 MB string twice (once in the array, once in
  // the joined body). Streaming keeps peak memory to O(1) per row.
  // The blocks[] array is still fully in memory; true input-side streaming
  // would require re-downloading block files in a second pass.
  const encoder = new TextEncoder();
  const safeName = (exp.project_name ?? exp.title ?? "experiment").replace(
    /[\\/:*?"<>|]/g,
    "_",
  );

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // UTF-8 BOM so Excel reads Korean/unicode columns correctly.
      controller.enqueue(encoder.encode("﻿"));
      controller.enqueue(encoder.encode(header.map(csvEscape).join(",") + "\n"));
      for (const b of blocks) {
        for (const t of b.trials ?? []) {
          const row: Record<string, unknown> = {
            subject_number: b.subject_number,
            session: b.session ?? 1,
            block_index: b.block_index,
            trial_index: (t as { trial_index?: unknown }).trial_index ?? "",
            condition: b.condition_assignment ?? "",
            is_pilot: b.is_pilot ? 1 : 0,
            submitted_at: b.submitted_at,
          };
          for (const k of ordered) row[k] = (t as Record<string, unknown>)[k] ?? "";
          controller.enqueue(
            encoder.encode(header.map((k) => csvEscape(row[k])).join(",") + "\n"),
          );
        }
      }
      controller.close();
    },
  });

  return new NextResponse(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${safeName}_trials.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
