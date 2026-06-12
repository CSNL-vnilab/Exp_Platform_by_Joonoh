import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod/v4";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidUUID } from "@/lib/utils/validation";
import { verifyRunToken, hashToken, TokenError } from "@/lib/experiments/run-token";

// POST /api/experiments/:experimentId/data/:bookingId/block
//
// Called by the /run shell after each block finishes. Auth is a one-time
// signed token issued at booking time (Authorization: Bearer <token> or
// body.token). Rate-limited at the DB level by rpc_ingest_block which
// enforces 1 req/sec burst + 100 req/min sustained AND monotonic block
// ordering (block_index must equal blocks_submitted).
//
// The block body is stored append-only in Supabase Storage under
//   experiment-data/{experiment_id}/{subject_number}/block_{N}.json
//   (single-session / session 1 — legacy-compatible bare path), or
//   experiment-data/{experiment_id}/{subject_number}/session_{S}/block_{N}.json
//   (multi-session rounds 2+, keyed by the booking's session_number)
// with service-role credentials (researcher-readable via RLS policy).
// The session segment prevents multi-session groups (which share one
// subject_number) from colliding day-over-day at the same object path.
//
// No PII is accepted — payloads reference the participant by subject_number
// only. The route strips any top-level fields matching a blocklist as
// defence in depth before writing.

const blockSchema = z.object({
  block_index: z.number().int().min(0).max(999),
  trials: z.array(z.record(z.string(), z.unknown())).max(10000),
  block_metadata: z.record(z.string(), z.unknown()).optional(),
  completed_at: z.string().datetime().optional(),
  // If present, signals this is the last block; triggers completion-code
  // minting after a successful upload.
  is_last: z.boolean().optional(),
});

// Unambiguous PII keys. Historical list included "name" but researchers
// legitimately encode stimulus / condition names in trial metadata
// (stim.name, condition_name, …) — stripping there corrupts data.
// "name" is no longer in the strip list; the researcher owns the contract.
const PII_KEYS = new Set([
  "email",
  "phone",
  "birthdate",
  "birthday",
  "address",
  "ssn",
  "rrn", // KR resident registration number
]);

// Recursively strip PII keys from a JSON-like value. Limited recursion
// depth so a malicious payload can't DoS us with deeply nested objects.
function stripPii(value: unknown, depth = 0): unknown {
  if (depth > 8) return value;
  if (Array.isArray(value)) {
    return value.map((v) => stripPii(v, depth + 1));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (PII_KEYS.has(k.toLowerCase())) continue;
      out[k] = stripPii(v, depth + 1);
    }
    return out;
  }
  return value;
}

function generateCompletionCode(format?: string): string {
  if (!format || format === "uuid") return crypto.randomUUID();
  const m = /^alphanumeric:(\d+)$/.exec(format);
  if (m) {
    const len = Math.min(Math.max(parseInt(m[1], 10), 6), 32);
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const bytes = new Uint8Array(len);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => chars[b % chars.length]).join("");
  }
  return crypto.randomUUID();
}

function extractToken(request: NextRequest, body: unknown): string | null {
  const header = request.headers.get("authorization") ?? "";
  if (header.startsWith("Bearer ")) return header.slice(7).trim();
  if (body && typeof body === "object" && "token" in body) {
    const t = (body as { token?: unknown }).token;
    if (typeof t === "string") return t;
  }
  return null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ experimentId: string; bookingId: string }> },
) {
  const { experimentId, bookingId } = await params;
  if (!isValidUUID(experimentId) || !isValidUUID(bookingId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const token = extractToken(request, body);
  if (!token) {
    return NextResponse.json({ error: "Missing token" }, { status: 401 });
  }

  try {
    verifyRunToken(token, bookingId);
  } catch (err) {
    if (err instanceof TokenError) {
      return NextResponse.json(
        { error: "Invalid token", code: err.code },
        { status: 401 },
      );
    }
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  const parsed = blockSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid payload", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const supabase = createAdminClient();

  // Second gate: token_hash must match the row we issued this booking.
  // This lets researchers revoke the token (null out token_hash or set
  // token_revoked_at) without invalidating the HMAC key. Also pull is_pilot
  // so pilot runs land under a distinct storage prefix and don't pollute
  // the real dataset.
  const { data: progress, error: progressErr } = await supabase
    .from("experiment_run_progress")
    .select(
      "token_hash, token_revoked_at, blocks_submitted, completion_code, is_pilot, condition_assignment",
    )
    .eq("booking_id", bookingId)
    .maybeSingle();

  if (progressErr || !progress) {
    return NextResponse.json({ error: "No run session for booking" }, { status: 404 });
  }
  if (progress.token_revoked_at) {
    return NextResponse.json({ error: "Token revoked" }, { status: 401 });
  }
  if (progress.completion_code) {
    return NextResponse.json(
      { error: "Run already completed" },
      { status: 409 },
    );
  }
  if (progress.token_hash !== hashToken(token)) {
    return NextResponse.json({ error: "Token hash mismatch" }, { status: 401 });
  }

  // Fetch booking + experiment for storage path + config. This must happen
  // BEFORE the ingest RPC so the experiment_id binding is verified before
  // counters move.
  const { data: booking, error: bookingErr } = await supabase
    .from("bookings")
    .select(
      "id, experiment_id, participant_id, subject_number, session_number, experiments(id, experiment_mode, online_runtime_config)",
    )
    .eq("id", bookingId)
    .maybeSingle();
  if (bookingErr || !booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }
  if (booking.experiment_id !== experimentId) {
    return NextResponse.json({ error: "Experiment mismatch" }, { status: 400 });
  }
  const exp = booking.experiments as unknown as {
    id: string;
    experiment_mode: "offline" | "online" | "hybrid";
    online_runtime_config: {
      completion_token_format?: string;
      block_count?: number;
      exclude_experiment_ids?: string[];
    } | null;
  } | null;
  if (!exp || exp.experiment_mode === "offline") {
    return NextResponse.json({ error: "Experiment is not online" }, { status: 400 });
  }
  // Enforce researcher-declared block count if set. block_index is 0-based
  // so the valid range is [0, block_count).
  if (
    typeof exp.online_runtime_config?.block_count === "number" &&
    parsed.data.block_index >= exp.online_runtime_config.block_count
  ) {
    return NextResponse.json(
      { error: "BLOCK_INDEX_OUT_OF_RANGE" },
      { status: 409 },
    );
  }

  // ── Eligibility gate (P0-3) ───────────────────────────────────────────────
  // The /run shell runs the screener as a client-side phase machine; a valid
  // token + curl can therefore skip it entirely and curl block_0 straight into
  // the dataset (and mint a completion code). Screening must be an INGEST-side
  // guarantee, not a UX nudge. We gate ONLY the first block (block_index === 0):
  // later blocks are already-past this point (monotonic ordering means
  // block_index>0 implies block_0 was accepted, which means the gate passed),
  // and re-running the queries on every block would be wasted work. The gate
  // sits BEFORE rpc_ingest_block so no counter/rate-limit slot moves for an
  // ineligible participant.
  if (parsed.data.block_index === 0) {
    // (1) Required-screener gate. Every screener marked required=true must have
    //     a server-graded passed=true response row for THIS booking. Optional
    //     (required=false) screeners are not gated (lab policy: required
    //     screeners are the eligibility contract; optional ones are advisory).
    const { data: requiredScreeners, error: screenerErr } = await supabase
      .from("experiment_online_screeners")
      .select("id")
      .eq("experiment_id", exp.id)
      .eq("required", true);
    if (screenerErr) {
      return NextResponse.json(
        { error: "ELIGIBILITY_CHECK_FAILED" },
        { status: 500 },
      );
    }
    if (requiredScreeners && requiredScreeners.length > 0) {
      const requiredIds = requiredScreeners.map((s) => s.id);
      // Only count rows that this booking actually PASSED. A missing row or a
      // passed=false row both fail the gate.
      const { data: passedRows, error: respErr } = await supabase
        .from("experiment_online_screener_responses")
        .select("screener_id")
        .eq("booking_id", bookingId)
        .eq("passed", true)
        .in("screener_id", requiredIds);
      if (respErr) {
        return NextResponse.json(
          { error: "ELIGIBILITY_CHECK_FAILED" },
          { status: 500 },
        );
      }
      const passedSet = new Set((passedRows ?? []).map((r) => r.screener_id));
      const allPassed = requiredIds.every((id) => passedSet.has(id));
      if (!allPassed) {
        return NextResponse.json(
          { error: "SCREENER_NOT_PASSED" },
          { status: 403 },
        );
      }
    }

    // (2) Cross-study exclusion re-check. exclude_experiment_ids is enforced at
    //     booking time (book_slot / bookings POST), but the booking could have
    //     been created before the exclusion was configured, or the participant
    //     could have enrolled in an excluded study AFTER booking. Re-checking
    //     here closes the booking-time-only window. This MUST mirror the
    //     authoritative booking-time enforcement exactly: book_slot
    //     (00045:158) matches participant_id against FOUR statuses —
    //     ('confirmed','running','completed','no_show'). no_show is included
    //     deliberately (00045:132-135): a participant who intended to take part
    //     but didn't appear is still "already engaged" for cross-study
    //     exclusion. Dropping no_show here would fail open precisely on the
    //     no_show population this re-check exists to catch.
    const rawExclude = exp.online_runtime_config?.exclude_experiment_ids;
    const excludeIds = Array.isArray(rawExclude)
      ? rawExclude.filter((id) => typeof id === "string" && isValidUUID(id))
      : [];
    // Never let a participant's OWN current experiment exclude itself.
    const otherExcludeIds = excludeIds.filter((id) => id !== exp.id);
    if (otherExcludeIds.length > 0) {
      // participant_id is NOT NULL in schema and book_slot always inserts it;
      // a missing value here means corruption. Fail closed rather than
      // silently skipping the exclusion, keeping a uniform fail-closed stance
      // with the screener gate and DB-error paths above.
      if (!booking.participant_id) {
        return NextResponse.json(
          { error: "ELIGIBILITY_CHECK_FAILED" },
          { status: 500 },
        );
      }
      const { data: priorBookings, error: priorErr } = await supabase
        .from("bookings")
        .select("id")
        .eq("participant_id", booking.participant_id)
        .in("experiment_id", otherExcludeIds)
        .in("status", ["confirmed", "running", "completed", "no_show"])
        .limit(1);
      if (priorErr) {
        return NextResponse.json(
          { error: "ELIGIBILITY_CHECK_FAILED" },
          { status: 500 },
        );
      }
      if (priorBookings && priorBookings.length > 0) {
        return NextResponse.json(
          { error: "EXPERIMENT_EXCLUDED" },
          { status: 403 },
        );
      }
    }
  }

  // Atomic bump: enforces rate limits + monotonic block order.
  const { data: ingestRes, error: ingestErr } = await supabase.rpc("rpc_ingest_block", {
    p_booking_id: bookingId,
    p_block_index: parsed.data.block_index,
  });

  if (ingestErr) {
    // Prefer parsing the custom MESSAGE we pass to RAISE EXCEPTION (first
    // line of `ingestErr.message`) over string-searching; fall back to
    // substring match on the PG error message for older client versions.
    const msg = ingestErr.message || "";
    const firstLine = msg.split("\n")[0] ?? "";
    const known = new Set([
      "RATE_LIMIT_BURST",
      "RATE_LIMIT_MINUTE",
      "BLOCK_INDEX_MISMATCH",
      "RUN_ALREADY_COMPLETED",
      "TOKEN_REVOKED",
      "NO_PROGRESS_ROW",
    ]);
    let code = "INGEST_ERROR";
    for (const k of known) {
      if (firstLine === k || msg.includes(k)) {
        code = k;
        break;
      }
    }
    const status =
      code === "RATE_LIMIT_BURST" || code === "RATE_LIMIT_MINUTE" ? 429
      : code === "BLOCK_INDEX_MISMATCH" ? 409
      : code === "RUN_ALREADY_COMPLETED" ? 409
      : code === "TOKEN_REVOKED" ? 401
      : code === "NO_PROGRESS_ROW" ? 404
      : 500;
    return NextResponse.json({ error: code }, { status });
  }

  const ingest = ingestRes as { blocks_submitted: number; accepted_at: string };

  // Serialize + write the block JSON. Strip PII recursively.
  const scrubbedTrials = stripPii(parsed.data.trials) as unknown[];
  const scrubbedMeta = parsed.data.block_metadata
    ? (stripPii(parsed.data.block_metadata) as Record<string, unknown>)
    : undefined;

  // Honeypot detection: if the researcher-facing iframe embedded the
  // hidden trap instruction (via our LLM honeypot component) and the
  // participant's response included the trap word, flag the session.
  // Word is the same as in run-shell.tsx.
  const HONEYPOT = "hazelnut-97f3";
  const serialized = JSON.stringify([scrubbedTrials, scrubbedMeta ?? null]);
  if (serialized.toLowerCase().includes(HONEYPOT)) {
    try {
      await supabase.rpc("rpc_record_attention_failure", {
        p_booking_id: bookingId,
        p_delta: 5,
      });
    } catch {}
  }

  const blockPayload = {
    block_index: parsed.data.block_index,
    trials: scrubbedTrials,
    block_metadata: scrubbedMeta,
    submitted_at: ingest.accepted_at,
    completed_at: parsed.data.completed_at ?? null,
    subject_number: booking.subject_number,
    // Immutable booking identity. The CSV export joins per-participant
    // attributes (attention_fail_count / screener_passed) on this rather than
    // on (subject_number, session_number): session_number is mutated by
    // renumberSessionsInGroup when any sibling in a multi-session group is
    // rescheduled, which would otherwise desync the path-derived session from
    // the booking row and silently blank/misattribute those columns.
    booking_id: bookingId,
    is_pilot: progress.is_pilot,
    condition_assignment: progress.condition_assignment,
  };

  // Folder uses subject_number when present, else the bookingId so two
  // bookings with a null subject_number don't collide at the same path.
  // Pilot runs live under a separate `_pilot/` prefix so researchers can
  // drop it wholesale before final analysis.
  const sbjFolder =
    typeof booking.subject_number === "number"
      ? String(booking.subject_number)
      : `booking-${bookingId}`;
  const pilotPrefix = progress.is_pilot ? "_pilot/" : "";
  // Multi-session paradigms (e.g. TimeExpOnline1's 5-day run) put every
  // session of a booking_group under the SAME subject_number. Without a
  // session segment, day-2 block_0 would target the same object path as
  // day-1 block_0; upsert:false then rejects it and the whole run rolls
  // back — the group can never complete. session_number (authoritative,
  // from the booking row) disambiguates the sessions.
  //
  // Legacy compatibility: single-session data was written WITHOUT a session
  // segment. Only insert `session_{N}/` when session_number is a real number
  // (>1, i.e. an actual multi-session round) so single-session bookings —
  // including any already-collected data at the old path — keep their
  // existing layout untouched. session 1 is the implicit/legacy session and
  // stays at the bare `{sbjFolder}/block_N.json` path.
  const sessionSegment =
    typeof booking.session_number === "number" && booking.session_number > 1
      ? `session_${booking.session_number}/`
      : "";
  const path = `${exp.id}/${pilotPrefix}${sbjFolder}/${sessionSegment}block_${parsed.data.block_index}.json`;
  const bytes = new TextEncoder().encode(JSON.stringify(blockPayload));

  // upsert=false so a participant cannot overwrite an already-accepted
  // block. Since rpc_ingest_block only accepts block_index === prior count,
  // a collision here is a genuine duplicate and we reject.
  const { error: uploadErr } = await supabase.storage
    .from("experiment-data")
    .upload(path, bytes, {
      contentType: "application/json",
      upsert: false,
    });
  if (uploadErr) {
    // Rollback the counter + rate-limit slots through the dedicated RPC so
    // the decrement is atomic with the row lock (and matches whatever
    // counters the ingest bumped). Guarded by expected_blocks so a
    // concurrent successful submit doesn't get clobbered.
    const { error: rollbackErr } = await supabase.rpc("rpc_rollback_block", {
      p_booking_id: bookingId,
      p_expected_blocks: ingest.blocks_submitted,
    });
    if (rollbackErr) {
      console.error("[BlockIngest] rollback RPC failed:", rollbackErr.message);
    }
    return NextResponse.json(
      { error: "Storage write failed", detail: uploadErr.message },
      { status: 500 },
    );
  }

  // First block moves the booking from confirmed → running so the admin
  // list shows it as in-flight during the whole run (not just during the
  // sliver between mint and verify).
  if (parsed.data.block_index === 0) {
    await supabase
      .from("bookings")
      .update({ status: "running" })
      .eq("id", bookingId)
      .eq("status", "confirmed");
  }

  // Last block? Mint completion code. The DB UNIQUE constraint on
  // completion_code can collide (astronomically unlikely for UUIDs, but
  // non-trivial for alphanumeric:4). Retry up to 3x with fresh codes
  // before giving up and warning the participant.
  let completionCode: string | null = null;
  if (parsed.data.is_last) {
    const format = exp.online_runtime_config?.completion_token_format;
    let mintErr: { message?: string; code?: string } | null = null;
    for (let attempt = 0; attempt < 3 && !completionCode; attempt++) {
      const code = generateCompletionCode(format);
      const { data: mintRes, error } = await supabase.rpc(
        "rpc_mint_completion_code",
        { p_booking_id: bookingId, p_code: code },
      );
      if (!error) {
        completionCode = (mintRes as { completion_code: string }).completion_code;
        mintErr = null;
        break;
      }
      mintErr = error;
      // '23505' is unique_violation — retry with a fresh code. Anything
      // else is terminal (the row is gone, constraint check failed, etc).
      if (error.code !== "23505") break;
    }
    if (!completionCode) {
      console.error(
        "[BlockIngest] mint completion failed:",
        mintErr?.message ?? "unknown",
      );
      return NextResponse.json(
        {
          blocks_submitted: ingest.blocks_submitted,
          completion_code: null,
          warning: "Completion mint failed; please contact researcher.",
        },
        { status: 200 },
      );
    }
  }

  return NextResponse.json(
    {
      blocks_submitted: ingest.blocks_submitted,
      completion_code: completionCode,
    },
    { status: 200 },
  );
}
