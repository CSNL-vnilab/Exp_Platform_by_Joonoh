// Per-booking researcher observation endpoints.
//
//   GET  /api/bookings/:bookingId/observation  → current row or null
//   PUT  /api/bookings/:bookingId/observation  → upsert via
//         submit_booking_observation() RPC, then sync to Notion.
//
// Auth / ownership is gated two ways:
//   1. We require an authenticated session; otherwise 401.
//   2. Reads/writes go through the user-scoped server client so RLS on
//      booking_observations (see 00026) enforces "researchers manage own
//      experiment observations". We still do an explicit experiment.created_by
//      equality check before touching anything, both as defence-in-depth and
//      to return a clean 403 rather than an RLS-empty result.
//
// The PUT blocks observation submissions for sessions that haven't started
// yet (slot_start + 10min must be <= now). The client can pass ?backfill=true
// to explicitly record an observation ahead of time — kept as an escape hatch
// rather than exposed in the default UI so the "log as you go" flow stays the
// happy path.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { isValidUUID, observationSchema } from "@/lib/utils/validation";
import { syncObservationToNotion } from "@/lib/services/observation.service";

// Observations get locked out of the future path until the session actually
// starts; we give a 10-minute grace window so a researcher who opens the
// tab right before the slot can still record the pre-survey step.
const FUTURE_GUARD_GRACE_MS = 10 * 60 * 1000;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ bookingId: string }> },
) {
  const { bookingId } = await params;
  if (!isValidUUID(bookingId)) {
    return NextResponse.json({ error: "Invalid booking ID" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Ownership check (defence-in-depth; RLS would filter the observation
  // row away anyway).
  const { data: booking, error: bookingErr } = await supabase
    .from("bookings")
    .select("id, experiments(created_by)")
    .eq("id", bookingId)
    .maybeSingle();
  if (bookingErr || !booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }
  const experiment = booking.experiments as { created_by: string | null } | null;
  if (!experiment || experiment.created_by !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: observation } = await supabase
    .from("booking_observations")
    .select(
      "booking_id, pre_survey_done, pre_survey_info, post_survey_done, post_survey_info, notable_observations, entered_at, updated_at, notion_page_id, notion_synced_at",
    )
    .eq("booking_id", bookingId)
    .maybeSingle();

  return NextResponse.json({ observation: observation ?? null });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ bookingId: string }> },
) {
  const { bookingId } = await params;
  if (!isValidUUID(bookingId)) {
    return NextResponse.json({ error: "Invalid booking ID" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = observationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  // Ownership + time-guard lookup in one shot.
  const { data: booking, error: bookingErr } = await supabase
    .from("bookings")
    .select("id, slot_start, experiments(created_by)")
    .eq("id", bookingId)
    .maybeSingle();
  if (bookingErr || !booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }
  const experiment = booking.experiments as { created_by: string | null } | null;
  if (!experiment || experiment.created_by !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Time guard — observation may only be recorded once the session has
  // actually started (slot_start + 10min ≤ now). A ?backfill=true query
  // param bypasses this; it's intended for research assistants catching up
  // on an old session, not for the default flow.
  const url = new URL(request.url);
  const backfill = url.searchParams.get("backfill") === "true";
  const slotStartMs = new Date(booking.slot_start).getTime();
  if (!backfill && slotStartMs + FUTURE_GUARD_GRACE_MS > Date.now()) {
    return NextResponse.json(
      {
        error:
          "실험 시작 시간 이전에는 사후 관찰을 기록할 수 없습니다.",
      },
      { status: 409 },
    );
  }

  // Delegate the upsert to the RPC — it handles ownership (SECURITY DEFINER),
  // the auto-complete transition, and the class-recompute trigger hop.
  const { data: rpcResult, error: rpcErr } = await supabase.rpc(
    "submit_booking_observation",
    {
      p_booking_id: bookingId,
      p_observation: {
        pre_survey_done: parsed.data.pre_survey_done,
        pre_survey_info: parsed.data.pre_survey_info ?? null,
        post_survey_done: parsed.data.post_survey_done,
        post_survey_info: parsed.data.post_survey_info ?? null,
        notable_observations: parsed.data.notable_observations ?? null,
      },
    },
  );

  if (rpcErr) {
    return NextResponse.json(
      { error: "관찰 기록 저장 중 오류가 발생했습니다" },
      { status: 500 },
    );
  }

  // The RPC returns a JSON envelope (jsonb_build_object) for its own
  // error codes (UNAUTHENTICATED / BOOKING_NOT_FOUND / FORBIDDEN).
  const envelope = rpcResult as { success?: boolean; error?: string; auto_completed?: boolean } | null;
  if (envelope && envelope.success === false) {
    const code = envelope.error ?? "UNKNOWN";
    if (code === "FORBIDDEN") {
      return NextResponse.json({ error: "권한이 없습니다" }, { status: 403 });
    }
    if (code === "BOOKING_NOT_FOUND") {
      return NextResponse.json({ error: "Booking not found" }, { status: 404 });
    }
    if (code === "UNAUTHENTICATED") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json(
      { error: "관찰 기록 저장에 실패했습니다" },
      { status: 500 },
    );
  }

  // Notion sync. On Vercel we can't truly fire-and-forget (the Serverless
  // function is killed at response return), so we await with a short-lived
  // try/catch and always persist the result into booking_integrations.
  // Errors degrade to a 'failed' outbox row, never to a 5xx for the client.
  let notionPageId: string | undefined;
  try {
    const syncResult = await syncObservationToNotion(bookingId);
    notionPageId = syncResult.notionPageId;
  } catch (err) {
    // syncObservationToNotion catches internally, but be defensive.
    console.error(
      "[Observation] notion sync crashed:",
      err instanceof Error ? err.message : err,
    );
  }

  return NextResponse.json({
    ok: true,
    auto_completed: envelope?.auto_completed ?? false,
    notion_page_id: notionPageId ?? null,
  });
}

