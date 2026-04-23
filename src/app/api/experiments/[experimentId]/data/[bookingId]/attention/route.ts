import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod/v4";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidUUID } from "@/lib/utils/validation";
import { verifyRunToken, hashToken, TokenError } from "@/lib/experiments/run-token";

// POST /api/experiments/:id/data/:bookingId/attention
//
// Shell reports either an attention-check failure or a behavior-signals
// delta. Both routes bump counters server-side so researchers have an
// integrity audit trail. Payloads:
//   { kind: "attention_failure", delta?: number }
//   { kind: "behavior",          delta: { [key]: number | string } }

const schema = z.discriminatedUnion("kind", [
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
    .select("token_hash")
    .eq("booking_id", bookingId)
    .maybeSingle();
  if (!progress) {
    return NextResponse.json({ error: "No run session" }, { status: 404 });
  }
  if (progress.token_hash !== hashToken(token)) {
    return NextResponse.json({ error: "Token hash mismatch" }, { status: 401 });
  }

  // Verify the URL's experimentId matches the booking's — BEFORE any
  // counter mutation, so a wrong URL can't leave residue (review H2/H3).
  const { data: booking } = await admin
    .from("bookings")
    .select("experiment_id")
    .eq("id", bookingId)
    .maybeSingle();
  if (!booking || booking.experiment_id !== experimentId) {
    return NextResponse.json({ error: "Experiment mismatch" }, { status: 400 });
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
