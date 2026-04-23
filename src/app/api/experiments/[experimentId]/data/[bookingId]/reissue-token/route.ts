import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidUUID } from "@/lib/utils/validation";
import { issueRunToken } from "@/lib/experiments/run-token";

// POST /api/experiments/:experimentId/data/:bookingId/reissue-token
//
// Researcher-only. Generates a fresh signed run token for an existing
// booking (e.g. participant lost the email link). The previous token_hash
// is overwritten so old links stop working immediately. Returns the new
// `run_url` so the researcher can forward it to the participant manually;
// the platform does not automatically re-email it (the researcher knows
// which channel is appropriate).

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ experimentId: string; bookingId: string }> },
) {
  const { experimentId, bookingId } = await params;
  if (!isValidUUID(experimentId) || !isValidUUID(bookingId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const { data: booking } = await admin
    .from("bookings")
    .select("id, experiment_id, experiments(created_by, experiment_mode)")
    .eq("id", bookingId)
    .maybeSingle();
  if (!booking || booking.experiment_id !== experimentId) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }
  const exp = booking.experiments as unknown as {
    created_by: string | null;
    experiment_mode: "offline" | "online" | "hybrid";
  } | null;

  const { data: profile } = await admin
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  const isAdmin = profile?.role === "admin";
  if (!isAdmin && exp?.created_by !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!exp || exp.experiment_mode === "offline") {
    return NextResponse.json(
      { error: "Experiment has no online runtime" },
      { status: 400 },
    );
  }

  const issued = issueRunToken(bookingId);
  const { error: upsertErr } = await admin
    .from("experiment_run_progress")
    .upsert(
      {
        booking_id: bookingId,
        token_hash: issued.hash,
        token_issued_at: new Date(issued.issuedAt).toISOString(),
        token_revoked_at: null,
      },
      { onConflict: "booking_id" },
    );
  if (upsertErr) {
    return NextResponse.json(
      { error: "Failed to reissue", detail: upsertErr.message },
      { status: 500 },
    );
  }

  const origin =
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ||
    (process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`.replace(/\/$/, "")
      : "");
  const run_url = `${origin}/run/${bookingId}?t=${encodeURIComponent(issued.token)}`;

  return NextResponse.json({
    run_url,
    token_issued_at: new Date(issued.issuedAt).toISOString(),
  });
}
