import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireExperimentAccess } from "@/lib/auth/experiment-access";
import { listExperimentBlocks } from "@/lib/storage/experiment-blocks";

// GET /api/experiments/:id/data-export-csv?include_pilot=1
//
// Researcher-only. Walks every block_*.json uploaded by participants of
// this experiment, flattens trials into rows, and emits UTF-8 BOM CSV.
// Keyed on `subject_number, session, block_index, trial_index`. Every trial
// key that appears across the dataset becomes a column; nested object/array
// values are emitted as JSON-string cells (not "[object Object]"). Header
// always contains: subject_number, session, block_index, trial_index,
// condition, is_pilot, attention_fail_count, screener_passed, submitted_at,
// block_metadata, plus a dynamic set of trial-level keys. attention_fail_count
// and screener_passed are joined from the booking that owns each
// (subject_number, session) pair (blank for legacy data with no match).
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
  // Participant-attribute joins (denormalised per row from the booking that
  // owns this subject_number+session). Blank when no matching booking row
  // exists (legacy data uploaded before run-progress/screener tracking).
  "attention_fail_count",
  "screener_passed",
  "submitted_at",
  // block_metadata is the block-level config snapshot (calibration / seed /
  // session schedule). Emitted as a single JSON-string cell so nested objects
  // survive instead of collapsing to "[object Object]".
  "block_metadata",
] as const;

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// Render a trial-level cell value. Primitives pass through (String()); nested
// objects/arrays are JSON-stringified so a structured value (e.g. a response
// vector) becomes a readable JSON cell instead of "[object Object]".
function cellValue(v: unknown): unknown {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return v;
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
    // Immutable booking identity (added 2026-06-12). Primary join key for the
    // participant-attribute columns. Absent on legacy blocks ⇒ (subject,session)
    // fallback.
    booking_id?: string;
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

  // Participant-attribute join. attention/screener state lives on the booking,
  // resolved to:
  //   attention_fail_count — experiment_run_progress.attention_fail_count
  //   screener_passed       — true iff every *required* screener for this
  //                           experiment has a passed=true response for the
  //                           booking (no required screeners ⇒ true).
  // Primary join key is the immutable booking_id embedded in each block body.
  // We do NOT key on (subject_number, session_number): session_number is
  // rewritten by renumberSessionsInGroup whenever a sibling in a multi-session
  // group is rescheduled, while the already-written block keeps its original
  // session_{N}/ storage path — so a (subject_number, session) key would
  // silently blank or misattribute these columns for rescheduled participants.
  // The (subject_number, session) map is retained ONLY as a fallback for legacy
  // blocks written before booking_id was embedded in the body.
  // Read-only; uses the service-role admin client (no RLS) since access was
  // already gated by requireExperimentAccess. Missing matches ⇒ blank cells.
  type Attr = { attention_fail_count: number | null; screener_passed: boolean | null };
  const subjSessKey = (subject: number, session: number) => `${subject}::${session}`;
  const attrBySubjSess = new Map<string, Attr>();
  const attrByBookingId = new Map<string, Attr>();
  {
    const { data: bookingRows } = await admin
      .from("bookings")
      .select("id, subject_number, session_number")
      .eq("experiment_id", experimentId);
    const bookings = (bookingRows ?? []) as Array<{
      id: string;
      subject_number: number | null;
      session_number: number;
    }>;
    if (bookings.length > 0) {
      const bookingIds = bookings.map((b) => b.id);

      // Which screeners are required for this experiment? screener_passed is
      // only meaningful relative to the required set.
      const { data: screenerRows } = await admin
        .from("experiment_online_screeners")
        .select("id, required")
        .eq("experiment_id", experimentId);
      const requiredScreenerIds = new Set(
        ((screenerRows ?? []) as Array<{ id: string; required: boolean }>)
          .filter((s) => s.required)
          .map((s) => s.id),
      );

      // attention_fail_count per booking.
      const { data: progressRows } = await admin
        .from("experiment_run_progress")
        .select("booking_id, attention_fail_count")
        .in("booking_id", bookingIds);
      const failByBooking = new Map(
        ((progressRows ?? []) as Array<{
          booking_id: string;
          attention_fail_count: number | null;
        }>).map((p) => [p.booking_id, p.attention_fail_count ?? 0]),
      );

      // Required-screener pass state per booking. Only fetch responses to
      // required screeners; a booking passes iff it has a passed=true response
      // for *every* required screener. A booking with no required screeners
      // (empty set) trivially passes.
      const passByBooking = new Map<string, boolean>();
      if (requiredScreenerIds.size > 0) {
        const { data: respRows } = await admin
          .from("experiment_online_screener_responses")
          .select("booking_id, screener_id, passed")
          .in("booking_id", bookingIds)
          .in("screener_id", Array.from(requiredScreenerIds));
        const passedSetByBooking = new Map<string, Set<string>>();
        for (const r of (respRows ?? []) as Array<{
          booking_id: string;
          screener_id: string;
          passed: boolean;
        }>) {
          if (!r.passed) continue;
          const set = passedSetByBooking.get(r.booking_id) ?? new Set<string>();
          set.add(r.screener_id);
          passedSetByBooking.set(r.booking_id, set);
        }
        for (const id of bookingIds) {
          const passed = passedSetByBooking.get(id) ?? new Set<string>();
          let all = true;
          for (const sid of requiredScreenerIds)
            if (!passed.has(sid)) {
              all = false;
              break;
            }
          passByBooking.set(id, all);
        }
      } else {
        for (const id of bookingIds) passByBooking.set(id, true);
      }

      for (const b of bookings) {
        const attr: Attr = {
          attention_fail_count: failByBooking.get(b.id) ?? null,
          screener_passed: passByBooking.get(b.id) ?? null,
        };
        // Primary key: immutable booking_id (works even for null subject_number).
        attrByBookingId.set(b.id, attr);
        // Fallback key for legacy blocks that predate body booking_id.
        if (b.subject_number != null)
          attrBySubjSess.set(subjSessKey(b.subject_number, b.session_number), attr);
      }
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
        const session = b.session ?? 1;
        // Prefer the immutable booking_id join; fall back to (subject, session)
        // only for legacy blocks written before booking_id was embedded.
        const attr =
          (b.booking_id != null ? attrByBookingId.get(b.booking_id) : undefined) ??
          (b.subject_number != null
            ? attrBySubjSess.get(subjSessKey(b.subject_number, session))
            : undefined);
        // block_metadata rendered once per block as a JSON-string cell.
        const blockMetaCell =
          b.block_metadata != null ? cellValue(b.block_metadata) : "";
        for (const t of b.trials ?? []) {
          // Preserve a researcher-supplied trial_index exactly — including a
          // legitimate 0 (?? only blanks null/undefined, never 0/"").
          const rawTrialIndex = (t as { trial_index?: unknown }).trial_index;
          const row: Record<string, unknown> = {
            subject_number: b.subject_number,
            session,
            block_index: b.block_index,
            trial_index: rawTrialIndex ?? "",
            condition: b.condition_assignment ?? "",
            is_pilot: b.is_pilot ? 1 : 0,
            attention_fail_count: attr?.attention_fail_count ?? "",
            screener_passed:
              attr?.screener_passed == null ? "" : attr.screener_passed ? 1 : 0,
            submitted_at: b.submitted_at,
            block_metadata: blockMetaCell,
          };
          // Dynamic trial keys: nested objects/arrays become JSON cells
          // (cellValue) instead of "[object Object]".
          for (const k of ordered)
            row[k] = cellValue((t as Record<string, unknown>)[k]);
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
