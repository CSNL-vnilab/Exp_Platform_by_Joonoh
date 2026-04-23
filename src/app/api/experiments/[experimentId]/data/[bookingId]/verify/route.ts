import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod/v4";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidUUID } from "@/lib/utils/validation";

// POST /api/experiments/:experimentId/data/:bookingId/verify
//
// Researcher-only: takes the completion code the participant claims to have
// seen and — if it matches experiment_run_progress.completion_code —
// flips booking status to 'completed' and stamps verified_at/verified_by.
// Mismatches return 409 without leaking the real code.

const verifySchema = z.object({
  completion_code: z.string().min(4).max(64),
});

export async function POST(
  request: NextRequest,
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
    .select(
      "id, status, experiment_id, experiments(id, created_by)",
    )
    .eq("id", bookingId)
    .maybeSingle();

  if (!booking || booking.experiment_id !== experimentId) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }
  const exp = booking.experiments as unknown as { id: string; created_by: string | null } | null;

  const { data: profile } = await admin
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  const isAdmin = profile?.role === "admin";
  if (!isAdmin && exp?.created_by !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const parsed = verifySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const { data: progress } = await admin
    .from("experiment_run_progress")
    .select(
      "completion_code, verified_at, verify_attempts, verify_locked_until",
    )
    .eq("booking_id", bookingId)
    .maybeSingle();

  if (!progress || !progress.completion_code) {
    return NextResponse.json(
      { error: "No completion code has been issued for this booking" },
      { status: 409 },
    );
  }

  // Brute-force lockout. Short codes (alphanumeric:4 = 20 bits) are
  // guessable with ~1M tries; cap unauthenticated attempts hard, and
  // require the researcher to wait out a 10-min window after 10 fails.
  if (
    progress.verify_locked_until &&
    new Date(progress.verify_locked_until).getTime() > Date.now()
  ) {
    return NextResponse.json(
      { error: "Too many failed attempts. Try again in 10 minutes." },
      { status: 429 },
    );
  }

  // Normalize case + whitespace to reduce friction. Codes are UUIDs or
  // [A-Z0-9]+ by construction so ASCII-only uppercase is safe.
  const got = parsed.data.completion_code.trim().toUpperCase();
  const expected = progress.completion_code.trim().toUpperCase();
  if (got !== expected) {
    const nextAttempts = (progress.verify_attempts ?? 0) + 1;
    const lockedUntil =
      nextAttempts >= 10
        ? new Date(Date.now() + 10 * 60 * 1000).toISOString()
        : null;
    await admin
      .from("experiment_run_progress")
      .update({
        verify_attempts: nextAttempts,
        verify_locked_until: lockedUntil,
      })
      .eq("booking_id", bookingId);
    return NextResponse.json(
      { error: "Completion code does not match" },
      { status: 409 },
    );
  }

  if (!progress.verified_at) {
    await admin
      .from("experiment_run_progress")
      .update({
        verified_at: new Date().toISOString(),
        verified_by: user.id,
        // Reset the counter on success so a future reissue/restart is clean.
        verify_attempts: 0,
        verify_locked_until: null,
      })
      .eq("booking_id", bookingId);
  }

  if (booking.status === "confirmed" || booking.status === "running") {
    await admin
      .from("bookings")
      .update({ status: "completed" })
      .eq("id", bookingId);
  }

  return NextResponse.json({ ok: true });
}
