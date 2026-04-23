import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidUUID } from "@/lib/utils/validation";

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
  if (!isValidUUID(experimentId))
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: exp } = await admin
    .from("experiments")
    .select("created_by, experiment_mode, title, project_name")
    .eq("id", experimentId)
    .maybeSingle();
  if (!exp) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { data: profile } = await admin
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  const isAdmin = profile?.role === "admin";
  if (!isAdmin && exp.created_by !== user.id)
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  if (exp.experiment_mode === "offline") {
    return NextResponse.json(
      { error: "Offline experiment; no runtime trial data" },
      { status: 400 },
    );
  }

  const includePilot = new URL(request.url).searchParams.get("include_pilot") === "1";

  // Enumerate subject folders + pilot folder if requested
  const topFolders: string[] = [];
  const { data: rootList } = await admin.storage
    .from("experiment-data")
    .list(experimentId, { limit: 1000 });
  for (const entry of rootList ?? []) {
    if (!entry.name) continue;
    if (entry.name === "_pilot" && !includePilot) continue;
    topFolders.push(entry.name);
  }

  // Collect all block JSONs
  const blockPaths: string[] = [];
  for (const f of topFolders) {
    if (f === "_pilot") {
      // recurse one level into _pilot/{sbj}/block_*.json
      const { data: pilotSubs } = await admin.storage
        .from("experiment-data")
        .list(`${experimentId}/_pilot`, { limit: 1000 });
      for (const ps of pilotSubs ?? []) {
        const { data: files } = await admin.storage
          .from("experiment-data")
          .list(`${experimentId}/_pilot/${ps.name}`, { limit: 1000 });
        for (const blk of files ?? []) {
          if (blk.name.endsWith(".json"))
            blockPaths.push(`${experimentId}/_pilot/${ps.name}/${blk.name}`);
        }
      }
    } else {
      const { data: files } = await admin.storage
        .from("experiment-data")
        .list(`${experimentId}/${f}`, { limit: 1000 });
      for (const blk of files ?? []) {
        if (blk.name.endsWith(".json"))
          blockPaths.push(`${experimentId}/${f}/${blk.name}`);
      }
    }
  }

  // Download + parse each
  interface Block {
    block_index: number;
    trials: Array<Record<string, unknown>>;
    block_metadata?: Record<string, unknown>;
    submitted_at: string;
    subject_number: number | null;
    is_pilot?: boolean;
    condition_assignment?: string | null;
  }
  const blocks: Block[] = [];
  for (const p of blockPaths) {
    const { data, error } = await admin.storage.from("experiment-data").download(p);
    if (error || !data) continue;
    try {
      blocks.push(JSON.parse(await data.text()) as Block);
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

  const lines: string[] = [header.map(csvEscape).join(",")];
  for (const b of blocks) {
    for (const t of b.trials ?? []) {
      const row: Record<string, unknown> = {
        subject_number: b.subject_number,
        block_index: b.block_index,
        trial_index: (t as { trial_index?: unknown }).trial_index ?? "",
        condition: b.condition_assignment ?? "",
        is_pilot: b.is_pilot ? 1 : 0,
        submitted_at: b.submitted_at,
      };
      for (const k of ordered) row[k] = (t as Record<string, unknown>)[k] ?? "";
      lines.push(header.map((k) => csvEscape(row[k])).join(","));
    }
  }

  // UTF-8 BOM so Excel reads Korean/unicode columns correctly.
  const body = "﻿" + lines.join("\n") + "\n";
  const safeName = (exp.project_name ?? exp.title ?? "experiment").replace(
    /[\\/:*?"<>|]/g,
    "_",
  );
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${safeName}_trials.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
