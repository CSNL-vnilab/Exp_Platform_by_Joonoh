import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidUUID } from "@/lib/utils/validation";
import { verifyRunToken, hashToken, TokenError } from "@/lib/experiments/run-token";

// GET /api/experiments/:experimentId/data/:bookingId/session?t=<token>
//
// Called by the /run shell on load. Returns the minimum context the shell
// needs to render + load the researcher's JS:
//   - experiment metadata (title, entry_url, runtime config)
//   - current blocks_submitted (so the shell can tell the researcher JS
//     where to resume)
//   - consent + IRB URL if required
//   - subject_number (the only identifier the runtime sees)
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
      "token_hash, token_revoked_at, blocks_submitted, completion_code, completion_code_issued_at",
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
    },
    progress: {
      blocks_submitted: progress.blocks_submitted,
      completion_code: progress.completion_code,
      completion_code_issued_at: progress.completion_code_issued_at,
    },
  });
}
