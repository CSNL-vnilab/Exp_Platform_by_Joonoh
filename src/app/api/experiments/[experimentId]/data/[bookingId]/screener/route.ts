import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod/v4";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidUUID } from "@/lib/utils/validation";
import { verifyRunToken, hashToken, TokenError } from "@/lib/experiments/run-token";
import type {
  OnlineScreenerKind,
  OnlineScreenerValidation,
} from "@/types/database";

// POST /api/experiments/:id/data/:bookingId/screener
//
// Participant submits one screener response (called per question). Server
// applies the `validation_config` to decide pass/fail and persists both the
// answer and the verdict. Accepted answers are NEVER returned to the
// participant — they see only pass/fail so they can retry or stop.
//
// Body: { screener_id, answer: JSON }

const reqSchema = z.object({
  screener_id: z.string().uuid(),
  answer: z.union([
    z.boolean(),
    z.number(),
    z.string(),
    z.array(z.string()),
  ]),
});

function extractToken(request: NextRequest, body: unknown): string | null {
  const h = request.headers.get("authorization") ?? "";
  if (h.startsWith("Bearer ")) return h.slice(7).trim();
  if (body && typeof body === "object" && "token" in body) {
    const t = (body as { token?: unknown }).token;
    if (typeof t === "string") return t;
  }
  return null;
}

function evaluate(
  kind: OnlineScreenerKind,
  rule: OnlineScreenerValidation,
  answer: unknown,
): boolean {
  if (kind === "yes_no") {
    if (typeof answer !== "boolean") return false;
    return rule.required_answer === undefined
      ? true
      : answer === rule.required_answer;
  }
  if (kind === "numeric") {
    if (typeof answer !== "number" || !Number.isFinite(answer)) return false;
    if (rule.integer && !Number.isInteger(answer)) return false;
    if (typeof rule.min === "number" && answer < rule.min) return false;
    if (typeof rule.max === "number" && answer > rule.max) return false;
    return true;
  }
  if (kind === "single_choice") {
    if (typeof answer !== "string") return false;
    const opts = rule.options ?? [];
    if (!opts.includes(answer)) return false;
    if (rule.accepted && !rule.accepted.includes(answer)) return false;
    return true;
  }
  if (kind === "multi_choice") {
    if (!Array.isArray(answer) || !answer.every((a) => typeof a === "string"))
      return false;
    const opts = rule.options ?? [];
    if (!answer.every((a) => opts.includes(a as string))) return false;
    if (rule.min_selected !== undefined && answer.length < rule.min_selected)
      return false;
    if (rule.max_selected !== undefined && answer.length > rule.max_selected)
      return false;
    if (rule.accepted && !rule.accepted.every((a) => answer.includes(a)))
      return false;
    if (
      rule.accepted_all &&
      !(answer as string[]).some((a) => rule.accepted_all!.includes(a))
    )
      return false;
    return true;
  }
  return false;
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

  const parsed = reqSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid payload", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const admin = createAdminClient();

  // Second gate: token hash must match row.
  const { data: progress } = await admin
    .from("experiment_run_progress")
    .select("token_hash, blocks_submitted")
    .eq("booking_id", bookingId)
    .maybeSingle();
  if (!progress) {
    return NextResponse.json({ error: "No run session" }, { status: 404 });
  }
  if (progress.token_hash !== hashToken(token)) {
    return NextResponse.json({ error: "Token hash mismatch" }, { status: 401 });
  }
  if (progress.blocks_submitted > 0) {
    return NextResponse.json(
      { error: "Screeners locked once blocks have started" },
      { status: 409 },
    );
  }

  const { data: screener } = await admin
    .from("experiment_online_screeners")
    .select("id, kind, validation_config, experiment_id")
    .eq("id", parsed.data.screener_id)
    .maybeSingle();
  if (!screener || screener.experiment_id !== experimentId) {
    return NextResponse.json({ error: "Screener not found" }, { status: 404 });
  }

  const passed = evaluate(
    screener.kind as OnlineScreenerKind,
    (screener.validation_config as OnlineScreenerValidation) ?? {},
    parsed.data.answer,
  );

  // Honeypot detection (2026 benchmark 1a): if the participant's answer
  // contains the hidden trap word that only LLM agents scraping full
  // HTML would surface, bump attention_fail_count. Word is hardcoded in
  // the RunShell and never displayed visibly.
  const HONEYPOT = "hazelnut-97f3";
  const flatAnswer = Array.isArray(parsed.data.answer)
    ? parsed.data.answer.join(" ")
    : String(parsed.data.answer);
  if (flatAnswer.toLowerCase().includes(HONEYPOT)) {
    try {
      await admin.rpc("rpc_record_attention_failure", {
        p_booking_id: bookingId,
        p_delta: 5, // heavier weight than a human-style attention-fail
      });
    } catch {
      // non-fatal: honeypot flag is advisory, screener call still succeeds
    }
  }

  // Upsert — researcher may let participant retry; we overwrite their prior
  // attempt so the final record reflects their last answer.
  // Cast answer (unions of primitives / string[]) through unknown → Json.
  const { error: upsertErr } = await admin
    .from("experiment_online_screener_responses")
    .upsert(
      {
        booking_id: bookingId,
        screener_id: screener.id,
        answer: parsed.data.answer as unknown as import("@/types/database").Json,
        passed,
      },
      { onConflict: "booking_id,screener_id" },
    );
  if (upsertErr) {
    return NextResponse.json(
      { error: "Failed to persist", detail: upsertErr.message },
      { status: 500 },
    );
  }

  return NextResponse.json({ passed });
}
