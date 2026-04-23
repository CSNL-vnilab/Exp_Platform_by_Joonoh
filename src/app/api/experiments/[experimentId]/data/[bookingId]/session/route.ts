import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidUUID } from "@/lib/utils/validation";
import { verifyRunToken, hashToken, TokenError } from "@/lib/experiments/run-token";

// GET /api/experiments/:experimentId/data/:bookingId/session?t=<token>
//
// Called by the /run shell on load. Returns everything the shell needs to
// decide what to show before loading the researcher's JS:
//   - experiment metadata (title, entry_url + SRI, preflight spec)
//   - consent + IRB URL
//   - online screeners the participant must pass
//   - attention check spec for the shell to inject
//   - counterbalanced condition assignment (stable across reloads)
//   - blocks_submitted so the researcher's JS resumes mid-run
//
// Auth: signed run token (query ?t= or Authorization: Bearer).

function extractToken(request: NextRequest): string | null {
  const header = request.headers.get("authorization") ?? "";
  if (header.startsWith("Bearer ")) return header.slice(7).trim();
  const url = new URL(request.url);
  const t = url.searchParams.get("t");
  return t ? t.trim() : null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ experimentId: string; bookingId: string }> },
) {
  const { experimentId, bookingId } = await params;
  if (!isValidUUID(experimentId) || !isValidUUID(bookingId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  const token = extractToken(request);
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

  const supabase = createAdminClient();

  const { data: progress, error: progressErr } = await supabase
    .from("experiment_run_progress")
    .select(
      "token_hash, token_revoked_at, blocks_submitted, completion_code, completion_code_issued_at, is_pilot, condition_assignment, attention_fail_count",
    )
    .eq("booking_id", bookingId)
    .maybeSingle();

  if (progressErr || !progress) {
    return NextResponse.json({ error: "No run session" }, { status: 404 });
  }
  if (progress.token_revoked_at) {
    return NextResponse.json({ error: "Token revoked" }, { status: 401 });
  }
  if (progress.token_hash !== hashToken(token)) {
    return NextResponse.json({ error: "Token hash mismatch" }, { status: 401 });
  }

  const { data: booking } = await supabase
    .from("bookings")
    .select(
      "id, subject_number, status, experiment_id, experiments(id, title, experiment_mode, online_runtime_config, data_consent_required, irb_document_url, precautions)",
    )
    .eq("id", bookingId)
    .maybeSingle();

  if (!booking || booking.experiment_id !== experimentId) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }
  const exp = booking.experiments as unknown as {
    id: string;
    title: string;
    experiment_mode: "offline" | "online" | "hybrid";
    online_runtime_config: Record<string, unknown> | null;
    data_consent_required: boolean;
    irb_document_url: string | null;
    precautions: Array<{ question: string; required_answer: boolean }> | null;
  } | null;
  if (!exp || exp.experiment_mode === "offline") {
    return NextResponse.json(
      { error: "Experiment has no online component" },
      { status: 400 },
    );
  }

  // ── Online screeners (ordered) ────────────────────────────────────────
  // Public-readable. Participant answers via POST /screener before blocks.
  const { data: screenerRows } = await supabase
    .from("experiment_online_screeners")
    .select("id, position, kind, question, help_text, validation_config, required")
    .eq("experiment_id", experimentId)
    .order("position", { ascending: true });

  const screenerResponses = await supabase
    .from("experiment_online_screener_responses")
    .select("screener_id, passed")
    .eq("booking_id", bookingId);

  const passedIds = new Set(
    (screenerResponses.data ?? [])
      .filter((r) => r.passed)
      .map((r) => r.screener_id),
  );
  const anyFailed = (screenerResponses.data ?? []).some((r) => !r.passed);

  // ── Counterbalanced condition — deterministic, stored on first call ──
  let condition = progress.condition_assignment;
  if (!condition) {
    const { data: assigned } = await supabase.rpc("rpc_assign_condition", {
      p_booking_id: bookingId,
    });
    condition = (assigned as string | null) ?? null;
  }

  return NextResponse.json({
    experiment: {
      id: exp.id,
      title: exp.title,
      mode: exp.experiment_mode,
      runtime_config: exp.online_runtime_config ?? {},
      irb_document_url: exp.irb_document_url,
      data_consent_required: exp.data_consent_required,
    },
    booking: {
      id: booking.id,
      subject_number: booking.subject_number,
      status: booking.status,
      is_pilot: progress.is_pilot,
      condition: condition,
    },
    progress: {
      blocks_submitted: progress.blocks_submitted,
      completion_code: progress.completion_code,
      completion_code_issued_at: progress.completion_code_issued_at,
      attention_fail_count: progress.attention_fail_count,
    },
    screeners: {
      questions: (screenerRows ?? []).map((s) => ({
        id: s.id,
        position: s.position,
        kind: s.kind,
        question: s.question,
        help_text: s.help_text,
        // Only expose the *shape* of validation so the shell can render
        // inputs — don't leak accepted answers (participant shouldn't see
        // which answer is "right" before choosing).
        ui: publicScreenerUI(s.kind, s.validation_config as Record<string, unknown>),
        required: s.required,
      })),
      passed_ids: Array.from(passedIds),
      any_failed: anyFailed,
    },
  });
}

function publicScreenerUI(
  kind: "yes_no" | "numeric" | "single_choice" | "multi_choice",
  v: Record<string, unknown>,
): Record<string, unknown> {
  if (kind === "yes_no") return {};
  if (kind === "numeric")
    return {
      min: v.min ?? null,
      max: v.max ?? null,
      integer: v.integer ?? false,
    };
  if (kind === "single_choice" || kind === "multi_choice") {
    return {
      options: Array.isArray(v.options) ? v.options : [],
      min_selected: kind === "multi_choice" ? v.min_selected ?? null : null,
      max_selected: kind === "multi_choice" ? v.max_selected ?? null : null,
    };
  }
  return {};
}
