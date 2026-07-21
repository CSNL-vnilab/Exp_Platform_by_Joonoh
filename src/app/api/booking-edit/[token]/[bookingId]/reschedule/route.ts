import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod/v4";
import { normalizeToISO } from "@/lib/utils/validation";
import { requireBookingEditAccess } from "@/lib/booking-edit/access";
import { BOOKING_EDIT_CUTOFF_HOURS } from "@/lib/utils/constants";
import { buildRescheduleRequestEmail } from "@/lib/services/booking-reschedule-request-email";
import { sendEmail } from "@/lib/google/gmail";

// Participant-facing reschedule REQUEST (00083). Same NEW-slot validation
// as the admin PATCH, but this route NO LONGER applies the change: the
// participant's signed booking-edit token authorizes the submission of a
// deferred request into booking_reschedule_requests. The experimenter
// (experiments.created_by) approves/rejects from the bookings queue; only
// on approval does apply_reschedule_request run and update DB + calendar +
// reminders.
//
// The token scopes the action to a single booking_group_id, so the
// participant can only request changes to their OWN sessions.
//
// Hard limit on the NEW slot: must be ≥ EDIT_CUTOFF_HOURS out. Single
// source of truth is BOOKING_EDIT_CUTOFF_HOURS — the booking-edit page and
// the edit-link emails read the same constant so the stated and enforced
// cutoffs never drift. There is NO old-slot cutoff: a no-show/past/
// cancelled session is inherently past cutoff, and because the request is
// deferred (approved later) it is safe to submit at any time.
const EDIT_CUTOFF_HOURS = BOOKING_EDIT_CUTOFF_HOURS;

const rescheduleSchema = z.object({
  slot_start: z.string().datetime(),
  slot_end: z.string().datetime(),
  // Optional free-text reason surfaced to the experimenter in the notify
  // email + stored on the request row for the approval queue.
  reason: z.string().max(500).optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ token: string; bookingId: string }> },
) {
  const { token, bookingId } = await params;

  const access = await requireBookingEditAccess(token, bookingId, {
    extraBookingColumns:
      "status, experiment_id, booking_group_id, participant_id, slot_start, slot_end, session_number",
    extraExperimentColumns:
      "created_by, title, weekdays, max_participants_per_slot, status",
  });
  if (access instanceof NextResponse) return access;
  const { admin } = access;
  const booking = access.booking as unknown as {
    id: string;
    booking_group_id: string | null;
    status: string;
    experiment_id: string;
    participant_id: string | null;
    slot_start: string;
    slot_end: string;
    session_number: number;
    experiments: {
      created_by: string | null;
      title: string;
      weekdays: number[];
      max_participants_per_slot: number;
      status: string;
    } | null;
  };

  // Relaxed status gate (00083): a participant may request rescheduling a
  // confirmed session (advance notice), a no-showed session (missed it),
  // or a cancelled session (re-book). Only completed/running sessions —
  // real or in-flight — are refused; the request is deferred, so a past
  // slot is fine.
  if (
    booking.status !== "confirmed" &&
    booking.status !== "no_show" &&
    booking.status !== "cancelled"
  ) {
    return NextResponse.json(
      { error: "완료/진행 중인 회차는 변경할 수 없습니다" },
      { status: 400 },
    );
  }

  const exp = booking.experiments as unknown as {
    created_by: string | null;
    title: string;
    weekdays: number[];
    max_participants_per_slot: number;
    status: string;
  } | null;
  if (!exp) {
    return NextResponse.json(
      { error: "실험 정보를 찾을 수 없습니다" },
      { status: 404 },
    );
  }

  const parsed = rescheduleSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "잘못된 요청입니다" },
      { status: 400 },
    );
  }

  const newStart = new Date(parsed.data.slot_start);
  const newEnd = new Date(parsed.data.slot_end);
  const reason = parsed.data.reason?.trim() || null;

  // NEW-slot validation (unchanged from immediate-apply): future, ordered,
  // ≥ cutoff out. The OLD-slot cutoff is intentionally gone — see header.
  if (newStart <= new Date()) {
    return NextResponse.json(
      { error: "이미 지난 시간으로는 변경할 수 없습니다" },
      { status: 400 },
    );
  }
  if (newEnd <= newStart) {
    return NextResponse.json(
      { error: "종료 시간이 시작 시간보다 이후여야 합니다" },
      { status: 400 },
    );
  }
  if (newStart.getTime() - Date.now() < EDIT_CUTOFF_HOURS * 60 * 60 * 1000) {
    return NextResponse.json(
      {
        error: `${EDIT_CUTOFF_HOURS}시간 이후의 시간을 선택해 주세요.`,
      },
      { status: 400 },
    );
  }

  // Weekday check (KST) — mirrors admin PATCH.
  const kstParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(newStart);
  const kstDateStr = `${kstParts.find((p) => p.type === "year")!.value}-${kstParts.find((p) => p.type === "month")!.value}-${kstParts.find((p) => p.type === "day")!.value}`;
  const kstDow = new Date(`${kstDateStr}T09:00:00+09:00`).getDay();
  if (!exp.weekdays.includes(kstDow)) {
    return NextResponse.json(
      { error: "실험 운영 요일이 아닙니다" },
      { status: 400 },
    );
  }

  // Best-effort capacity SELECT — an early UX 409 before the participant
  // waits on experimenter approval only to be rejected for a full slot.
  // NOT authoritative: the AUTHORITY is apply_reschedule_request (00083),
  // which re-counts confirmed overlaps under the book_slot advisory lock at
  // approval time. This SELECT runs outside that lock and can race.
  const { data: conflicts } = await admin
    .from("bookings")
    .select("id")
    .eq("experiment_id", booking.experiment_id)
    .eq("status", "confirmed")
    // Time-overlap (00069), not exact-match.
    .lt("slot_start", newEnd.toISOString())
    .gt("slot_end", newStart.toISOString())
    .neq("id", bookingId);

  if ((conflicts?.length ?? 0) >= exp.max_participants_per_slot) {
    return NextResponse.json(
      { error: "선택한 시간대가 이미 예약되었습니다" },
      { status: 409 },
    );
  }

  const normalizedStart = normalizeToISO(newStart.toISOString());
  const normalizedEnd = normalizeToISO(newEnd.toISOString());

  // Server-side identifiers — NEVER from the request body. The participant
  // can only touch the booking their token scopes to, and these come off
  // the loaded row.
  const experimentId = booking.experiment_id;
  const bookingGroupId = booking.booking_group_id;
  const participantId = booking.participant_id;

  // Insert the deferred request. The partial UNIQUE index
  // (uniq_pending_reschedule_req_per_booking) guarantees at most one OPEN
  // request per booking; a second submission while one is pending raises
  // 23505, which we translate to a friendly 409.
  const { data: inserted, error: insertErr } = await admin
    .from("booking_reschedule_requests")
    .insert({
      booking_id: bookingId,
      booking_group_id: bookingGroupId,
      experiment_id: experimentId,
      participant_id: participantId,
      requested_slot_start: normalizedStart,
      requested_slot_end: normalizedEnd,
      current_slot_start: booking.slot_start,
      current_slot_end: booking.slot_end,
      current_status: booking.status,
      reason,
      status: "pending",
    })
    .select("id")
    .single();

  if (insertErr) {
    if (insertErr.code === "23505") {
      return NextResponse.json(
        {
          error:
            "이미 처리 대기 중인 변경 요청이 있습니다. 실험자 승인을 기다려 주세요.",
        },
        { status: 409 },
      );
    }
    console.error(
      "[ParticipantRescheduleRequest] insert failed:",
      insertErr.message,
    );
    return NextResponse.json(
      { error: "변경 요청 접수에 실패했습니다. 잠시 후 다시 시도해 주세요." },
      { status: 500 },
    );
  }

  const requestId = inserted.id;

  // Fire-and-forget experimenter notification. Resolve the recipient from
  // the experiment owner's profile (contact_email preferred, falling back
  // to the login email). The request is already persisted — a mail failure
  // must NOT fail the response (the researcher also sees it in the queue),
  // so we stamp last_email_error and still return success.
  void (async () => {
    try {
      const ownerId = exp.created_by;
      if (!ownerId) return;

      const { data: owner } = await admin
        .from("profiles")
        .select("display_name, contact_email, email")
        .eq("id", ownerId)
        .maybeSingle();

      const recipient = (owner?.contact_email || owner?.email || "").trim();
      if (!recipient) return;

      // Participant name for the email diff. participant_id is null on some
      // legacy rows; fall back to a generic label the builder tolerates.
      let participantName = "참여자";
      if (participantId) {
        const { data: p } = await admin
          .from("participants")
          .select("name")
          .eq("id", participantId)
          .maybeSingle();
        if (p?.name) participantName = p.name;
      }

      const origin =
        process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ||
        new URL(request.url).origin;

      const mail = buildRescheduleRequestEmail({
        to: recipient,
        participant: { name: participantName },
        experiment: { title: exp.title },
        sessionNumber: booking.session_number,
        oldSlotStart: booking.slot_start,
        oldSlotEnd: booking.slot_end,
        newSlotStart: normalizedStart,
        newSlotEnd: normalizedEnd,
        reason,
        approveUrl: `${origin}/experiments/${experimentId}/bookings`,
      });

      const sent = await sendEmail(mail);
      if (sent.success) {
        await admin
          .from("booking_reschedule_requests")
          .update({ request_email_sent_at: new Date().toISOString() })
          .eq("id", requestId);
      } else {
        await admin
          .from("booking_reschedule_requests")
          .update({ last_email_error: sent.error ?? "send failed" })
          .eq("id", requestId);
      }
    } catch (err) {
      console.error(
        "[ParticipantRescheduleRequest] notify failed:",
        err instanceof Error ? err.message : err,
      );
      await admin
        .from("booking_reschedule_requests")
        .update({
          last_email_error:
            err instanceof Error ? err.message : "notify failed",
        })
        .eq("id", requestId)
        .then(() => {}, () => {});
    }
  })();

  return NextResponse.json({
    ok: true,
    requested: true,
    message:
      "일정 변경 요청이 접수되었습니다. 실험자 승인 후 반영되며, 확정되면 안내 메일이 발송됩니다.",
  });
}
