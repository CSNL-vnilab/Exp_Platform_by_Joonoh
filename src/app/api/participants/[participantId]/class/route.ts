import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  classAssignmentSchema,
  isValidUUID,
} from "@/lib/utils/validation";
import type { ParticipantClassRow } from "@/types/database";
import { deleteEvent } from "@/lib/google/calendar";
import { invalidateCalendarCache } from "@/lib/google/freebusy-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Single-tenant default lab. See /api/participants/[participantId]/route.ts
// for context on multi-tenant expansion.
const DEFAULT_LAB_CODE = "CSNL";

// Manual class assignments are rate-limited per (participant, lab) to stop
// accidental double-clicks and to discourage oscillation in the audit log.
const MANUAL_COOLDOWN_MS = 60_000;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ participantId: string }> },
) {
  try {
    const { participantId } = await params;
    if (!isValidUUID(participantId)) {
      return NextResponse.json(
        { error: "Invalid participant ID" },
        { status: 400 },
      );
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
    const parsed = classAssignmentSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: parsed.error.issues[0]?.message ?? "입력값을 확인해 주세요",
          issues: parsed.error.issues,
        },
        { status: 400 },
      );
    }

    const { class: nextClass, reason, valid_until } = parsed.data;

    const admin = createAdminClient();

    // Caller profile — role gate.
    const { data: profile } = await admin
      .from("profiles")
      .select("id, role, disabled")
      .eq("id", user.id)
      .maybeSingle();
    if (!profile || profile.disabled) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const isAdmin = profile.role === "admin";
    const isResearcher = profile.role === "researcher";

    // blacklist/vip are admin-only.
    if ((nextClass === "blacklist" || nextClass === "vip") && !isAdmin) {
      return NextResponse.json(
        {
          error:
            "블랙리스트/VIP 등급은 관리자만 지정할 수 있습니다",
        },
        { status: 403 },
      );
    }

    // Researchers are only allowed newbie → royal uplift (manual correction).
    if (!isAdmin && isResearcher && nextClass !== "royal") {
      return NextResponse.json(
        { error: "연구원은 royal 등급만 수동 지정할 수 있습니다" },
        { status: 403 },
      );
    }

    // Confirm participant exists.
    const { data: participant } = await admin
      .from("participants")
      .select("id")
      .eq("id", participantId)
      .maybeSingle();
    if (!participant) {
      return NextResponse.json(
        { error: "참여자를 찾을 수 없습니다" },
        { status: 404 },
      );
    }

    // Resolve lab (default CSNL today; multi-lab will take a ?lab query
    // param once more labs exist).
    const { data: lab } = await admin
      .from("labs")
      .select("id, code")
      .eq("code", DEFAULT_LAB_CODE)
      .maybeSingle();
    if (!lab?.id) {
      return NextResponse.json(
        { error: "랩을 찾을 수 없습니다" },
        { status: 500 },
      );
    }

    // Rate-limit: one manual class change per (participant, lab) per 60s.
    // We check the latest manual row specifically — auto recomputes don't
    // count toward the limit.
    const cooldownThreshold = new Date(
      Date.now() - MANUAL_COOLDOWN_MS,
    ).toISOString();
    const { data: recentManual } = await admin
      .from("participant_classes")
      .select("id, valid_from")
      .eq("participant_id", participantId)
      .eq("lab_id", lab.id)
      .eq("assigned_kind", "manual")
      .gt("valid_from", cooldownThreshold)
      .order("valid_from", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (recentManual) {
      return NextResponse.json(
        {
          error: "너무 빨리 반복된 변경입니다. 잠시 후 다시 시도해 주세요.",
        },
        { status: 429 },
      );
    }

    // Call the DB-layer RPC (migration 00029) which:
    //   * Takes the same advisory lock as recompute_participant_class, so
    //     manual + auto writers serialize cleanly for this (participant, lab).
    //   * Inserts with clock_timestamp() for valid_from so identical-tx
    //     concurrent writes don't collide on identical microseconds.
    //   * Audit row is written by the AFTER INSERT trigger; we don't
    //     double-write here.
    const { data: inserted, error: insErr } = await admin.rpc(
      "assign_participant_class_manual",
      {
        p_participant_id: participantId,
        p_lab_id: lab.id,
        p_class: nextClass,
        p_reason: reason ?? null,
        p_valid_until: valid_until ?? null,
        p_assigned_by: user.id,
      },
    );

    if (insErr || !inserted) {
      console.error("[Participant class POST] insert failed:", insErr?.message);
      return NextResponse.json(
        { error: "등급 변경에 실패했습니다" },
        { status: 500 },
      );
    }

    // P2-3: cascade cancellation on blacklist transitions.
    // When an admin blacklists a participant, they almost always want
    // future confirmed/running bookings cancelled too — otherwise the
    // calendar and the participant dashboard still show them as active.
    // Cancellation here is best-effort: the class change has already
    // committed; we cancel what we can and surface the count to the UI
    // so the admin can manually chase anything that slipped through.
    // Email/SMS/Notion notifications are intentionally NOT sent here —
    // blacklisting is an adversarial action and we don't notify the
    // participant that their bookings were cancelled. Researchers owning
    // the affected experiments can be re-notified via a manual sweep if
    // needed (tracked in docs/next-sprints.md).
    let cascadeCancelled = 0;
    if (nextClass === "blacklist") {
      const nowIso = new Date().toISOString();
      const { data: futureBookings } = await admin
        .from("bookings")
        .select(
          "id, google_event_id, experiment_id, experiments(google_calendar_id)",
        )
        .eq("participant_id", participantId)
        .in("status", ["confirmed", "running"])
        .gt("slot_start", nowIso);

      for (const b of futureBookings ?? []) {
        const { error: cancelErr } = await admin
          .from("bookings")
          .update({ status: "cancelled" })
          .eq("id", b.id)
          // CAS: don't flip a booking that raced to 'completed' or was
          // cancelled by another admin in the gap between SELECT and UPDATE.
          .in("status", ["confirmed", "running"]);
        if (cancelErr) {
          console.error(
            "[Participant class POST] cancel booking failed:",
            b.id,
            cancelErr.message,
          );
          continue;
        }
        cascadeCancelled += 1;

        if (b.google_event_id) {
          const exp = b.experiments as unknown as {
            google_calendar_id: string | null;
          } | null;
          const calId = (
            exp?.google_calendar_id || process.env.GOOGLE_CALENDAR_ID || ""
          ).trim();
          if (calId) {
            try {
              await deleteEvent(calId, b.google_event_id);
              await admin
                .from("bookings")
                .update({ google_event_id: null })
                .eq("id", b.id);
              await invalidateCalendarCache(calId).catch(() => {});
            } catch (err) {
              console.error(
                "[Participant class POST] deleteEvent failed:",
                b.id,
                err instanceof Error ? err.message : err,
              );
            }
          }
        }
      }
    }

    return NextResponse.json(
      {
        class: inserted as unknown as ParticipantClassRow,
        cascade_cancelled_bookings: cascadeCancelled,
      },
      { status: 201 },
    );
  } catch (err) {
    console.error("[Participant class POST] failed:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
