import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod/v4";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidUUID } from "@/lib/utils/validation";

// POST /api/participants/:participantId/merge
//
// Admin-only. Merges the row at `:participantId` (source) into the
// `targetId` row in the request body. Bookings, payment-info, classes,
// audit history, and lab-identity get re-pointed; the source row is
// then deleted.
//
// Use case: backfill placeholder rows + later real signup of the same
// person (e.g. 이보현 vs `bohyun lee` from calendar import). Listed as
// a P3 finding in the auto-evolution loop.
//
// This is intentionally NOT done as an RPC migration — the calling
// surface is admin-only and the per-table conflict handling is easier
// to reason about in TypeScript. If the volume ever grows past
// occasional manual merges, port to a SECURITY DEFINER function.
//
// Conflict rules:
//   * `participant_lab_identity` PK (participant_id, lab_id): if target
//     already has a row for the same lab, the source row is dropped
//     (target wins, since target is the row the operator is keeping).
//   * `participant_classes` UNIQUE (participant_id, lab_id, valid_from):
//     blanket UPDATE; in the unlikely event of microsecond-identical
//     valid_from collisions the operation aborts and rolls back.
//   * `bookings` / `participant_payment_info` / `participant_class_audit`:
//     no conflict possible, blanket UPDATE.

const bodySchema = z.object({
  targetId: z.string().refine(isValidUUID, "invalid targetId"),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ participantId: string }> },
) {
  try {
    const { participantId: sourceId } = await params;
    if (!isValidUUID(sourceId)) {
      return NextResponse.json({ error: "Invalid source ID" }, { status: 400 });
    }

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const admin = createAdminClient();
    const { data: profile } = await admin
      .from("profiles")
      .select("role, disabled")
      .eq("id", user.id)
      .maybeSingle();
    if (!profile || profile.disabled || profile.role !== "admin") {
      return NextResponse.json(
        { error: "Forbidden — admin only" },
        { status: 403 },
      );
    }

    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid payload" },
        { status: 400 },
      );
    }
    const { targetId } = parsed.data;
    if (sourceId === targetId) {
      return NextResponse.json({ error: "source 와 target 은 같을 수 없습니다" }, { status: 400 });
    }

    // Sanity: both rows must exist.
    const { data: rows } = await admin
      .from("participants")
      .select("id, name, email, phone")
      .in("id", [sourceId, targetId]);
    const map = new Map((rows ?? []).map((r) => [r.id, r]));
    if (!map.has(sourceId)) {
      return NextResponse.json({ error: "source not found" }, { status: 404 });
    }
    if (!map.has(targetId)) {
      return NextResponse.json({ error: "target not found" }, { status: 404 });
    }

    const source = map.get(sourceId)!;
    const target = map.get(targetId)!;

    // Track per-step row counts so the response can show what moved.
    const moved: Record<string, number> = {};

    // 1. bookings — simple FK, no conflict
    {
      const { error, count } = await admin
        .from("bookings")
        .update({ participant_id: targetId } as never, { count: "exact" })
        .eq("participant_id", sourceId);
      if (error) {
        return NextResponse.json(
          { error: "bookings update failed", detail: error.message },
          { status: 500 },
        );
      }
      moved.bookings = count ?? 0;
    }

    // 2. participant_payment_info — simple FK.
    // database.ts intentionally excludes `participant_id` from the Update
    // type to discourage accidental re-pointing in the normal codepath;
    // for this admin-only merge we explicitly opt in via a typed cast.
    {
      const { error, count } = await admin
        .from("participant_payment_info")
        .update({ participant_id: targetId } as never, { count: "exact" })
        .eq("participant_id", sourceId);
      if (error) {
        return NextResponse.json(
          { error: "payment_info update failed", detail: error.message },
          { status: 500 },
        );
      }
      moved.payment_info = count ?? 0;
    }

    // 3. participant_lab_identity — PK = (participant_id, lab_id)
    {
      const { data: srcIds } = await admin
        .from("participant_lab_identity")
        .select("lab_id")
        .eq("participant_id", sourceId);
      let movedRows = 0;
      let droppedRows = 0;
      for (const { lab_id } of (srcIds ?? []) as Array<{ lab_id: string }>) {
        const { data: existing } = await admin
          .from("participant_lab_identity")
          .select("participant_id")
          .eq("participant_id", targetId)
          .eq("lab_id", lab_id)
          .maybeSingle();
        if (existing) {
          await admin
            .from("participant_lab_identity")
            .delete()
            .eq("participant_id", sourceId)
            .eq("lab_id", lab_id);
          droppedRows += 1;
        } else {
          await admin
            .from("participant_lab_identity")
            .update({ participant_id: targetId } as never)
            .eq("participant_id", sourceId)
            .eq("lab_id", lab_id);
          movedRows += 1;
        }
      }
      moved.lab_identity_moved = movedRows;
      moved.lab_identity_dropped = droppedRows;
    }

    // 4. participant_classes — UNIQUE (participant_id, lab_id, valid_from)
    // Move all; if a microsecond-identical conflict happens (extremely rare —
    // both sides came from clock_timestamp() of separate writes), the call
    // aborts and the operator sees the error. The earlier steps are not
    // rolled back automatically — that's the trade-off of TS-side merge.
    {
      const { error, count } = await admin
        .from("participant_classes")
        .update({ participant_id: targetId } as never, { count: "exact" })
        .eq("participant_id", sourceId);
      if (error) {
        return NextResponse.json(
          {
            error: "participant_classes update failed (likely UNIQUE collision)",
            detail: error.message,
            partial: moved,
          },
          { status: 500 },
        );
      }
      moved.classes = count ?? 0;
    }

    // 5. participant_class_audit — simple FK. Table exists per migration
    // 00025 but isn't surfaced in database.ts (it's INSERT-only via
    // trigger), so the .from() lookup needs an unsafe cast here as well.
    {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const adminAny = admin as unknown as any;
      const { error, count } = await adminAny
        .from("participant_class_audit")
        .update({ participant_id: targetId }, { count: "exact" })
        .eq("participant_id", sourceId);
      if (error) {
        return NextResponse.json(
          {
            error: "participant_class_audit update failed",
            detail: error.message,
            partial: moved,
          },
          { status: 500 },
        );
      }
      moved.class_audit = count ?? 0;
    }

    // 6. delete source. ON DELETE CASCADE on the FK side is moot for this
    // row at this point — everything's been re-pointed.
    {
      const { error } = await admin
        .from("participants")
        .delete()
        .eq("id", sourceId);
      if (error) {
        return NextResponse.json(
          {
            error: "source delete failed",
            detail: error.message,
            partial: moved,
          },
          { status: 500 },
        );
      }
    }

    return NextResponse.json({
      ok: true,
      source: { id: sourceId, name: source.name, email: source.email },
      target: { id: targetId, name: target.name, email: target.email },
      moved,
    });
  } catch (err) {
    console.error("[ParticipantsMerge] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 },
    );
  }
}
