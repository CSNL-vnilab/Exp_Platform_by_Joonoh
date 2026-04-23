import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod/v4";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidUUID } from "@/lib/utils/validation";

// POST /api/experiments/:id/pilot-toggle
// Body: { booking_id: uuid, is_pilot: boolean }
//
// Researcher marks a specific booking as pilot (or un-marks it). Affects
// storage path prefix + excludes from subject_number normalization. Only
// callable before any blocks are submitted — changing mid-run corrupts
// the existing storage objects' path.

const schema = z.object({
  booking_id: z.string().uuid(),
  is_pilot: z.boolean(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ experimentId: string }> },
) {
  const { experimentId } = await params;
  if (!isValidUUID(experimentId))
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: exp } = await admin
    .from("experiments")
    .select("created_by")
    .eq("id", experimentId)
    .maybeSingle();
  if (!exp) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { data: profile } = await admin
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  const isAdmin = profile?.role === "admin";
  if (!isAdmin && exp.created_by !== user.id)
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

  const { data: prog } = await admin
    .from("experiment_run_progress")
    .select("blocks_submitted, booking_id, bookings(experiment_id)")
    .eq("booking_id", parsed.data.booking_id)
    .maybeSingle();

  if (!prog)
    return NextResponse.json(
      { error: "Booking has no run session" },
      { status: 404 },
    );
  const bookingExp = (prog.bookings as unknown as { experiment_id: string })?.experiment_id;
  if (bookingExp !== experimentId)
    return NextResponse.json({ error: "Experiment mismatch" }, { status: 400 });
  if (prog.blocks_submitted > 0) {
    return NextResponse.json(
      { error: "Cannot toggle pilot after blocks submitted" },
      { status: 409 },
    );
  }

  const { error } = await admin
    .from("experiment_run_progress")
    .update({ is_pilot: parsed.data.is_pilot })
    .eq("booking_id", parsed.data.booking_id);
  if (error)
    return NextResponse.json(
      { error: "Update failed", detail: error.message },
      { status: 500 },
    );
  return NextResponse.json({ ok: true, is_pilot: parsed.data.is_pilot });
}
