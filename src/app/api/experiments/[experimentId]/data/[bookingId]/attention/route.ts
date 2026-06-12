import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod/v4";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidUUID } from "@/lib/utils/validation";
import { verifyRunToken, hashToken, TokenError } from "@/lib/experiments/run-token";

// POST /api/experiments/:id/data/:bookingId/attention
//
// Shell reports an attention-check answer, a (legacy) pre-graded failure, or a
// behavior-signals delta. All bump counters server-side so researchers have an
// integrity audit trail. Payloads:
//   { kind: "attention_response", check_index: number, answer: string|boolean }
//   { kind: "attention_failure",  delta?: number }   (legacy / direct miss)
//   { kind: "behavior",           delta: { [key]: number | string } }
//
// SECURITY (P0-2): attention_response is the canonical path. The client never
// sees correct_answer (stripped by sanitizeOnlineRuntimeConfig on the /run SSR
// page); the SERVER loads attention_checks from the experiment's stored
// online_runtime_config, grades the submitted answer against the real
// correct_answer here, and only on a miss increments attention_fail_count.
// Grading on the client (the old run-shell path) leaked the answer via devtools
// and could be no-op'd — that compare logic is removed from the shell.
//
// Policy (user-delegated default): record-only. A miss bumps the counter for
// post-hoc export filtering; it never blocks the run or withholds the
// completion code.

const schema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("attention_response"),
    // Index into online_runtime_config.attention_checks (stable: the shell
    // renders the same array order it received, minus correct_answer).
    check_index: z.number().int().min(0).max(999),
    // yes_no checks submit a boolean; single_choice submit the chosen option.
    answer: z.union([z.string(), z.boolean()]),
  }),
  z.object({
    kind: z.literal("attention_failure"),
    delta: z.number().int().positive().max(10).optional(),
  }),
  z.object({
    kind: z.literal("behavior"),
    delta: z.record(
      z.string(),
      z.union([z.number(), z.string()]),
    ),
  }),
]);

// Server-side grade: normalize both sides the same way the (now-removed)
// client compare did, so behaviour is identical except the answer never
// leaves the server. yes_no stores correct_answer as "yes"/"no"; the shell
// submits a boolean. single_choice compares the chosen option string.
function gradeAttention(
  check: { kind: string; correct_answer?: unknown },
  answer: string | boolean,
): boolean {
  const expected = String(check.correct_answer ?? "").trim().toLowerCase();
  if (check.kind === "yes_no") {
    const submitted =
      typeof answer === "boolean"
        ? answer
          ? "yes"
          : "no"
        : String(answer).trim().toLowerCase();
    return submitted === expected;
  }
  // single_choice (or any string-option kind): exact, case-insensitive match.
  return String(answer).trim().toLowerCase() === expected;
}

type StoredAttentionCheck = {
  question: string;
  kind: string;
  options?: string[];
  correct_answer: string;
  position: string;
};

function extractToken(request: NextRequest, body: unknown): string | null {
  const h = request.headers.get("authorization") ?? "";
  if (h.startsWith("Bearer ")) return h.slice(7).trim();
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
  if (!token) return NextResponse.json({ error: "Missing token" }, { status: 401 });
  try {
    verifyRunToken(token, bookingId);
  } catch (err) {
    const code = err instanceof TokenError ? err.code : "SHAPE";
    return NextResponse.json({ error: "Invalid token", code }, { status: 401 });
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid payload", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const admin = createAdminClient();
  const { data: progress } = await admin
    .from("experiment_run_progress")
    .select("token_hash, token_revoked_at, completion_code")
    .eq("booking_id", bookingId)
    .maybeSingle();
  if (!progress) {
    return NextResponse.json({ error: "No run session" }, { status: 404 });
  }
  if (progress.token_hash !== hashToken(token)) {
    return NextResponse.json({ error: "Token hash mismatch" }, { status: 401 });
  }
  // Reject post-completion / revoked tokens so the integrity counters
  // don't accept forever-running increments from a stale link (review H4).
  if (progress.token_revoked_at) {
    return NextResponse.json({ error: "Token revoked" }, { status: 401 });
  }
  if (progress.completion_code) {
    return NextResponse.json({ error: "Run already completed" }, { status: 409 });
  }

  // Verify the URL's experimentId matches the booking's — BEFORE any
  // counter mutation, so a wrong URL can't leave residue (review H2/H3).
  // Pull the experiment's stored config in the same query so server-side
  // attention grading reads the unsanitized correct_answer (never the client).
  const { data: booking } = await admin
    .from("bookings")
    .select("experiment_id, experiments(online_runtime_config)")
    .eq("id", bookingId)
    .maybeSingle();
  if (!booking || booking.experiment_id !== experimentId) {
    return NextResponse.json({ error: "Experiment mismatch" }, { status: 400 });
  }

  if (parsed.data.kind === "attention_response") {
    // Load the authoritative attention_checks from the stored config and grade
    // server-side. The client only sent {check_index, answer} — it never had
    // the correct_answer (stripped on the SSR page).
    // supabase-js types a to-one embed as object, but some generated typings
    // surface it as a one-element array — accept either shape defensively.
    const expEmbed = booking.experiments as
      | { online_runtime_config: unknown }
      | { online_runtime_config: unknown }[]
      | null;
    const expRow = Array.isArray(expEmbed) ? expEmbed[0] : expEmbed;
    const cfg = expRow?.online_runtime_config as
      | { attention_checks?: StoredAttentionCheck[] }
      | null
      | undefined;
    const checks = Array.isArray(cfg?.attention_checks)
      ? cfg.attention_checks
      : [];
    const check = checks[parsed.data.check_index];
    if (!check) {
      // No such check (config changed mid-run, or a forged index). Reject
      // rather than silently scoring — keeps the audit trail honest.
      return NextResponse.json(
        { error: "Unknown attention check" },
        { status: 400 },
      );
    }

    const correct = gradeAttention(check, parsed.data.answer);
    if (correct) {
      // Record-only policy: a pass touches no counter, never gates the run.
      return NextResponse.json({ correct: true, attention_fail_count: null });
    }

    const { data: newCount, error } = await admin.rpc(
      "rpc_record_attention_failure",
      { p_booking_id: bookingId, p_delta: 1 },
    );
    if (error) {
      return NextResponse.json(
        { error: "RPC failed", detail: error.message },
        { status: 500 },
      );
    }
    return NextResponse.json({ correct: false, attention_fail_count: newCount });
  }

  if (parsed.data.kind === "attention_failure") {
    const { data: newCount, error } = await admin.rpc(
      "rpc_record_attention_failure",
      { p_booking_id: bookingId, p_delta: parsed.data.delta ?? 1 },
    );
    if (error) {
      return NextResponse.json(
        { error: "RPC failed", detail: error.message },
        { status: 500 },
      );
    }
    return NextResponse.json({ attention_fail_count: newCount });
  }

  // behavior
  const { data: merged, error } = await admin.rpc(
    "rpc_merge_behavior_signals",
    { p_booking_id: bookingId, p_delta: parsed.data.delta },
  );
  if (error) {
    return NextResponse.json(
      { error: "RPC failed", detail: error.message },
      { status: 500 },
    );
  }
  return NextResponse.json({ behavior_signals: merged });
}
