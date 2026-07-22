import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireExperimentAccess } from "@/lib/auth/experiment-access";
import {
  createReschedGCalEvent,
  runReschedulePipeline,
  renumberSessionsInGroup,
} from "@/lib/services/booking.service";
import {
  invalidateCalendarCache,
  excludeBookingOrphans,
} from "@/lib/google/freebusy-cache";
import { deleteEvent, getFreeBusy } from "@/lib/google/calendar";
import { intervalsOverlap } from "@/lib/utils/date";
import { buildRescheduleRejectedEmail } from "@/lib/services/booking-reschedule-email";
import { sendEmail } from "@/lib/google/gmail";
import type { createAdminClient } from "@/lib/supabase/admin";

// POST /api/experiments/[experimentId]/reschedule-requests/[requestId]
//   body: { action: "approve" | "reject", rejectedReason?: string }
//
// Experimenter (owner) OR admin decision on a participant-submitted deferred
// reschedule request (00083). The participant route only INSERTs a pending
// row; the actual DB + calendar + reminder + settlement mutation happens
// HERE, and only on approval, via the revive-capable apply_reschedule_request
// RPC + runReschedulePipeline. Modeled on the blacklist-request approval
// route (CAS on status='pending' to lose gracefully to a racing decision)
// and the old immediate-apply reschedule sequence (pre-create GCal event →
// atomic RPC → renumber → pipeline).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  action: z.enum(["approve", "reject"]),
  rejectedReason: z.string().max(500).optional(),
});

interface OwnerProfile {
  display_name: string | null;
  contact_email: string | null;
  email: string | null;
  phone: string | null;
}

async function resolveOwnerProfile(
  admin: ReturnType<typeof createAdminClient>,
  ownerId: string | null,
): Promise<OwnerProfile | null> {
  if (!ownerId) return null;
  const { data } = await admin
    .from("profiles")
    .select("display_name, contact_email, email, phone")
    .eq("id", ownerId)
    .maybeSingle();
  return (data as OwnerProfile | null) ?? null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ experimentId: string; requestId: string }> },
) {
  try {
    const { experimentId, requestId } = await params;

    // Owner-OR-admin gate (NOT ownerOnly — an admin can approve on behalf of
    // the researcher). Returns 400/401/404/403 directly on failure.
    const access = await requireExperimentAccess(experimentId);
    if (access instanceof NextResponse) return access;
    const { user, admin } = access;

    const parsed = bodySchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "잘못된 요청입니다" },
        { status: 400 },
      );
    }
    const body = parsed.data;

    // 1. Load the request row (service-role — participants are unauthed and
    //    the row is scoped to the experiment we just authorized).
    const { data: reqRaw } = await admin
      .from("booking_reschedule_requests")
      .select(
        "id, booking_id, experiment_id, participant_id, requested_slot_start, requested_slot_end, status",
      )
      .eq("id", requestId)
      .maybeSingle();
    const req = reqRaw as unknown as {
      id: string;
      booking_id: string;
      experiment_id: string;
      participant_id: string | null;
      requested_slot_start: string;
      requested_slot_end: string;
      status: string;
    } | null;

    if (!req || req.experiment_id !== experimentId) {
      return NextResponse.json(
        { error: "요청을 찾을 수 없습니다" },
        { status: 404 },
      );
    }
    if (req.status !== "pending") {
      return NextResponse.json(
        { error: "이미 처리된 요청입니다" },
        { status: 409 },
      );
    }

    // 2. Load the booking fresh — the authoritative old slot / event id, read
    //    live so a concurrent admin move (or a status flip) is respected.
    const { data: bookingRaw } = await admin
      .from("bookings")
      .select(
        "id, booking_group_id, status, slot_start, slot_end, google_event_id, experiment_id, session_number, participant_id, experiments(title, created_by, weekdays, max_participants_per_slot, google_calendar_id)",
      )
      .eq("id", req.booking_id)
      .maybeSingle();
    const booking = bookingRaw as unknown as {
      id: string;
      booking_group_id: string | null;
      status: string;
      slot_start: string;
      slot_end: string;
      google_event_id: string | null;
      experiment_id: string;
      session_number: number;
      participant_id: string | null;
      experiments: {
        title: string;
        created_by: string | null;
        weekdays: number[];
        max_participants_per_slot: number;
        google_calendar_id: string | null;
      } | null;
    } | null;

    if (!booking) {
      return NextResponse.json(
        { error: "예약을 찾을 수 없습니다" },
        { status: 409 },
      );
    }
    const exp = booking.experiments;
    const now = () => new Date().toISOString();

    // ── REJECT ───────────────────────────────────────────────────────────
    if (body.action === "reject") {
      // CAS: only the decider that flips pending→rejected wins. An empty
      // returned array means another decision (approve/reject) raced ahead.
      const { data: casRows } = await admin
        .from("booking_reschedule_requests")
        .update({
          status: "rejected",
          decided_by: user.id,
          decided_at: now(),
          rejected_reason: body.rejectedReason ?? null,
        })
        .eq("id", requestId)
        .eq("status", "pending")
        .select("id");
      if (!casRows || casRows.length === 0) {
        return NextResponse.json(
          { error: "이미 처리된 요청입니다" },
          { status: 409 },
        );
      }

      // Fire-and-forget participant notification. The decision is already
      // persisted — a mail failure must not fail the response.
      void (async () => {
        try {
          let participantName = "참여자";
          let participantEmail = "";
          if (booking.participant_id) {
            const { data: p } = await admin
              .from("participants")
              .select("name, email")
              .eq("id", booking.participant_id)
              .maybeSingle();
            const pp = p as { name: string | null; email: string | null } | null;
            if (pp?.name) participantName = pp.name;
            if (pp?.email) participantEmail = pp.email.trim();
          }
          if (!participantEmail) return;

          const owner = await resolveOwnerProfile(admin, exp?.created_by ?? null);

          const mail = buildRescheduleRejectedEmail({
            participant: { name: participantName, email: participantEmail },
            experiment: { title: exp?.title ?? "실험" },
            sessionNumber: booking.session_number,
            oldSlotStart: booking.slot_start,
            oldSlotEnd: booking.slot_end,
            reason: body.rejectedReason,
            researcher: owner,
          });

          const sent = await sendEmail(mail);
          if (sent.success) {
            await admin
              .from("booking_reschedule_requests")
              .update({ decision_email_sent_at: now() })
              .eq("id", requestId)
              .then(() => {}, () => {});
          } else {
            await admin
              .from("booking_reschedule_requests")
              .update({ last_email_error: sent.error ?? "send failed" })
              .eq("id", requestId)
              .then(() => {}, () => {});
          }
        } catch (err) {
          console.error(
            "[RescheduleApproval reject] notify failed:",
            err instanceof Error ? err.message : err,
          );
        }
      })();

      return NextResponse.json({ ok: true, action: "rejected" });
    }

    // ── APPROVE ──────────────────────────────────────────────────────────

    // 1. PAYMENT GUARD — refuse if the group's settlement has advanced past
    //    the point where a slot move is safe. A claimed/submitted/paid row
    //    means the participant's compensation is already in motion.
    const { data: payRaw } = await admin
      .from("participant_payment_info")
      .select("status, claimed_at")
      .eq("booking_group_id", booking.booking_group_id ?? "")
      .maybeSingle();
    const payInfo = payRaw as { status: string; claimed_at: string | null } | null;
    if (
      payInfo &&
      ["claimed", "submitted_to_admin", "paid", "paid_offline"].includes(
        payInfo.status,
      )
    ) {
      return NextResponse.json(
        {
          error:
            "정산이 진행된 예약은 일정 변경 승인이 불가합니다. 담당자에게 문의해 주세요.",
        },
        { status: 409 },
      );
    }

    // 2. Re-validate the requested slot: future + operating weekday (KST).
    const newStart = new Date(req.requested_slot_start);
    if (newStart <= new Date()) {
      return NextResponse.json(
        { error: "이미 지난 시간으로는 변경할 수 없습니다" },
        { status: 400 },
      );
    }
    const kstParts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(newStart);
    const kstDateStr = `${kstParts.find((p) => p.type === "year")!.value}-${kstParts.find((p) => p.type === "month")!.value}-${kstParts.find((p) => p.type === "day")!.value}`;
    const kstDow = new Date(`${kstDateStr}T09:00:00+09:00`).getDay();
    if (!(exp?.weekdays ?? []).includes(kstDow)) {
      return NextResponse.json(
        { error: "실험 운영 요일이 아닙니다" },
        { status: 400 },
      );
    }

    // 3. Capture OLD values from the FRESH booking BEFORE the RPC mutates it.
    const oldSlotStart = booking.slot_start;
    const oldSlotEnd = booking.slot_end;
    const oldEventId = booking.google_event_id;
    const wasRevive =
      booking.status === "no_show" || booking.status === "cancelled";

    const calendarId =
      (exp?.google_calendar_id || process.env.GOOGLE_CALENDAR_ID || "").trim() ||
      null;

    // 3.5. GCal busy overlap check for the REQUESTED slot (best-effort). An
    //   approved reschedule must never land on top of an existing calendar
    //   event. Mirrors the researcher PATCH reschedule (bookings/[bookingId]):
    //   skip any busy interval that coincides with THIS booking's own current
    //   event (within 60s of the fresh slot_start/slot_end) — the participant
    //   may be moving within a window near their own event, and re-approving
    //   the same slot must not self-conflict. A fetch FAILURE is treated as
    //   best-effort (log + proceed) so a transient Google outage never blocks
    //   an otherwise-valid approval.
    const newEnd = new Date(req.requested_slot_end);
    if (calendarId) {
      try {
        const busy = await excludeBookingOrphans(
          await getFreeBusy(calendarId, newStart, newEnd),
        );
        const conflict = busy.some((b) => {
          if (
            Math.abs(b.start.getTime() - new Date(booking.slot_start).getTime()) <
              60_000 &&
            Math.abs(b.end.getTime() - new Date(booking.slot_end).getTime()) <
              60_000
          ) {
            return false;
          }
          return intervalsOverlap({ start: newStart, end: newEnd }, b);
        });
        if (conflict) {
          return NextResponse.json(
            {
              error:
                "요청하신 시간이 캘린더의 기존 일정과 겹칩니다. 다른 시간으로 다시 요청받거나 반려해 주세요.",
            },
            { status: 409 },
          );
        }
      } catch (err) {
        console.error(
          "[RescheduleApproval approve] freebusy pre-check failed (best-effort, proceeding):",
          err instanceof Error ? err.message : err,
        );
      }
    }

    // 4. Pre-create the new GCal event so the DB update lands the id atomically.
    let newEventId: string | null = null;
    try {
      const created = await createReschedGCalEvent(
        booking.id,
        req.requested_slot_start,
        req.requested_slot_end,
      );
      newEventId = created.eventId;
    } catch (err) {
      console.error(
        "[RescheduleApproval approve] createReschedGCalEvent threw:",
        err instanceof Error ? err.message : err,
      );
      return NextResponse.json(
        { error: "캘린더 업데이트 실패" },
        { status: 502 },
      );
    }

    // 5. Atomic apply under the book_slot advisory lock (capacity re-check +
    //    revive-capable CAS).
    const { data: rpcData, error: rpcError } = await admin.rpc(
      "apply_reschedule_request",
      {
        p_booking_id: booking.id,
        p_new_start: req.requested_slot_start,
        p_new_end: req.requested_slot_end,
        p_new_event_id: newEventId,
      },
    );
    const r = rpcData as { success?: boolean; error?: string } | null;
    if (rpcError || !r?.success) {
      // Clean up the orphaned GCal event we just created — the request stays
      // pending so the experimenter can retry or reject.
      if (newEventId && calendarId) {
        await deleteEvent(calendarId, newEventId).catch(() => {});
      }
      switch (r?.error) {
        case "SLOT_ALREADY_TAKEN":
          return NextResponse.json(
            {
              error:
                "승인 실패: 해당 시간이 이미 찼습니다. 참여자에게 재요청을 안내하거나 반려해 주세요.",
            },
            { status: 409 },
          );
        case "STATUS_CHANGED":
          return NextResponse.json(
            { error: "승인 실패: 예약 상태가 변경되었습니다." },
            { status: 409 },
          );
        case "SLOT_CONTENTION_RETRY":
          return NextResponse.json(
            { error: "잠시 후 다시 시도해 주세요." },
            { status: 503 },
          );
        default:
          console.error(
            "[RescheduleApproval approve] apply_reschedule_request failed:",
            rpcError?.message ?? r?.error ?? "unknown",
          );
          return NextResponse.json(
            { error: "승인 처리에 실패했습니다." },
            { status: 500 },
          );
      }
    }

    // 6. REVIVE payment reset — a no_show/cancelled session that just came
    //    back to life needs its settlement row re-armed. propagate_payment_period
    //    (run later in the pipeline) only touches pending rows, so if the row
    //    had been swept to 'cancelled' it would stay stuck. Best-effort.
    if (wasRevive && payInfo && payInfo.status === "cancelled") {
      const { error: payErr } = await admin
        .from("participant_payment_info")
        .update({ status: "pending_participant" })
        .eq("booking_group_id", booking.booking_group_id ?? "")
        .eq("status", "cancelled");
      if (payErr) {
        console.error(
          "[RescheduleApproval approve] payment revive reset failed:",
          payErr.message,
        );
      }
    }

    // 7. Renumber live sessions in the group (a revived/moved session may
    //    reorder relative to siblings). Best-effort.
    if (booking.booking_group_id) {
      try {
        await renumberSessionsInGroup(booking.booking_group_id);
      } catch (err) {
        console.error(
          "[RescheduleApproval approve] renumberSessionsInGroup failed:",
          err instanceof Error ? err.message : err,
        );
      }
    }

    // 8. Run the reschedule pipeline: reminders + payment period + Notion +
    //    old-event delete + participant confirmation email. Await so the
    //    email is sent before we return, but never fail the approval on it.
    try {
      await runReschedulePipeline({
        bookingId: booking.id,
        oldSlotStart,
        oldSlotEnd,
        oldEventId,
        newEventId,
      });
    } catch (err) {
      console.error(
        "[RescheduleApproval approve] runReschedulePipeline failed:",
        err instanceof Error ? err.message : err,
      );
    }
    await invalidateCalendarCache(calendarId).catch(() => {});

    // 9. CAS finalize the request row. The apply already committed, so an
    //    empty result here (a racing decision touched the row) is logged,
    //    not fatal.
    const { data: finRows } = await admin
      .from("booking_reschedule_requests")
      .update({
        status: "approved",
        decided_by: user.id,
        decided_at: now(),
      })
      .eq("id", requestId)
      .eq("status", "pending")
      .select("id");
    if (!finRows || finRows.length === 0) {
      console.warn(
        `[RescheduleApproval approve] finalize CAS matched 0 rows for request ${requestId} (apply already committed)`,
      );
    }

    return NextResponse.json({ ok: true, action: "approved" });
  } catch (err) {
    console.error(
      "[RescheduleApproval] unhandled error:",
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
