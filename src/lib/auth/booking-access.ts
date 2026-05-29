// requireBookingAccess — sibling helper to requireExperimentAccess for
// routes that operate on a single booking.
//
// Why this exists (refactor-roadmap B4-medium, 2026-05-29):
//
// Three routes — bookings/[id]/route.ts (GET / PUT / PATCH) and
// bookings/[id]/observation/route.ts (multiple methods) — each
// duplicated the same admin/owner gate but keyed on a bookingId rather
// than an experimentId. They all do:
//
//     const { data: { user } } = await supabase.auth.getUser();
//     if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
//     const { data: booking } = await supabase
//       .from("bookings")
//       .select("..., experiments(created_by, ...)")
//       .eq("id", bookingId).single();
//     if (!booking) return 404;
//     const experiment = booking.experiments as { created_by: ... } | null;
//     if (!experiment || experiment.created_by !== user.id) return 403;
//
// The shape closely mirrors `requireExperimentAccess` but with a
// pre-joined `experiments` row resolved through the booking. We keep
// the two helpers separate (rather than overloading
// requireExperimentAccess) because:
//
//   1. The booking variant needs two `extra*` knobs (booking columns
//      AND experiment columns) instead of one.
//   2. The booking variant's failure modes include "invalid booking
//      id" / "booking not found" / "booking row has null
//      experiment_id" which are unique to it.
//   3. Keeping the helpers symmetrical (each owns one resource kind)
//      makes the route-side `if (access instanceof NextResponse)`
//      pattern transparent without polymorphism.

import { NextResponse } from "next/server";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidUUID } from "@/lib/utils/validation";

type ServerClient = Awaited<ReturnType<typeof createClient>>;
type AdminClient = ReturnType<typeof createAdminClient>;

export interface BookingAccessContext {
  /** Authenticated Supabase user. */
  user: User;
  /**
   * Booking row — id + experiment_id are always present; additional
   * columns appear when `extraBookingColumns` is set.
   */
  booking: { id: string; experiment_id: string };
  /**
   * Experiment row joined through bookings — id + created_by always
   * present; additional columns appear when `extraExperimentColumns`
   * is set.
   */
  experiment: { id: string; created_by: string | null };
  /** True iff the authenticated user created the booking's experiment. */
  isOwner: boolean;
  /** True iff the authenticated user has profiles.role='admin'. */
  isAdmin: boolean;
  /** User-scoped Supabase client (RLS sees auth.uid()). */
  supabase: ServerClient;
  /** Service-role Supabase client (bypasses RLS). */
  admin: AdminClient;
}

export interface BookingAccessOptions {
  /**
   * Extra booking columns to include in the select. The required
   * `id, experiment_id` are always included.
   *
   * Example: `extraBookingColumns: "status, slot_start, google_event_id"`.
   */
  extraBookingColumns?: string;
  /**
   * Extra experiment columns to include in the joined select. The
   * required `created_by` is always included.
   *
   * Example: `extraExperimentColumns: "google_calendar_id, weekdays"`.
   */
  extraExperimentColumns?: string;
  /**
   * When true, reject admins who aren't also the experiment owner.
   * Default false — admins get access alongside owners. Most booking
   * routes used owner-only before the helper landed (matches the GET /
   * PUT / observation paths); the PATCH /reschedule path historically
   * allowed admins. Set this per-route to preserve the route's
   * original semantics.
   */
  ownerOnly?: boolean;
}

/**
 * Returns either a `BookingAccessContext` (auth succeeded — caller
 * proceeds) or a `NextResponse` (auth failed — caller returns it).
 *
 * Usage:
 *
 *     const access = await requireBookingAccess(bookingId, {
 *       extraBookingColumns: "status, google_event_id",
 *       extraExperimentColumns: "google_calendar_id",
 *       ownerOnly: true,
 *     });
 *     if (access instanceof NextResponse) return access;
 *     const { admin, supabase, user, booking, experiment } = access;
 */
export async function requireBookingAccess(
  bookingId: string,
  opts: BookingAccessOptions = {},
): Promise<BookingAccessContext | NextResponse> {
  if (!isValidUUID(bookingId)) {
    return NextResponse.json(
      { error: "Invalid booking ID" },
      { status: 400 },
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();

  // Accept "*" as shorthand for "all booking columns" — otherwise
  // prepend the required id + experiment_id.
  const bookingCols =
    opts.extraBookingColumns === "*"
      ? "*"
      : opts.extraBookingColumns
        ? `id, experiment_id, ${opts.extraBookingColumns}`
        : "id, experiment_id";
  const experimentCols = opts.extraExperimentColumns
    ? `created_by, ${opts.extraExperimentColumns}`
    : "created_by";
  const selectExpr = `${bookingCols}, experiments(${experimentCols})`;

  const { data: bookingRow } = await admin
    .from("bookings")
    .select(selectExpr)
    .eq("id", bookingId)
    .maybeSingle();

  if (!bookingRow) {
    return NextResponse.json(
      { error: "Booking not found" },
      { status: 404 },
    );
  }

  // Supabase types the joined relation as object-or-array depending on
  // RLS config; defend at runtime.
  const rawExperiment = (
    bookingRow as unknown as { experiments: unknown }
  ).experiments;
  const experimentObj = Array.isArray(rawExperiment)
    ? (rawExperiment[0] ?? null)
    : (rawExperiment ?? null);
  if (!experimentObj) {
    // Orphan booking — experiment_id points at a deleted row. Treat
    // as 404 because we can't gate against a missing experiment.
    return NextResponse.json(
      { error: "Booking's experiment not found" },
      { status: 404 },
    );
  }

  const { data: profile } = await admin
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  const bookingRowTyped = bookingRow as unknown as {
    id: string;
    experiment_id: string;
  };
  const experimentRow = experimentObj as { created_by: string | null };
  const isOwner = experimentRow.created_by === user.id;
  const isAdmin =
    (profile as unknown as { role: string | null } | null)?.role === "admin";
  if (opts.ownerOnly) {
    if (!isOwner) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  } else if (!isOwner && !isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return {
    user,
    booking: bookingRowTyped,
    experiment: {
      id: bookingRowTyped.experiment_id,
      created_by: experimentRow.created_by,
    },
    isOwner,
    isAdmin,
    supabase,
    admin,
  };
}
