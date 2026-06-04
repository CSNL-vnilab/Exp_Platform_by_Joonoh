import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { deleteEvent } from "@/lib/google/calendar";
import { invalidateCalendarCache } from "@/lib/google/freebusy-cache";
import { notifyBookingStatusChange } from "@/lib/services/booking-status-notify.service";
import { notifyPaymentInfoIfReady } from "@/lib/services/payment-info-notify.service";
import { scrubPii } from "@/lib/observability/pii";
import { requireBookingEditAccess } from "@/lib/booking-edit/access";
import { BOOKING_EDIT_CUTOFF_HOURS } from "@/lib/utils/constants";

// Participant-facing cancellation. Mirrors admin PUT
// /api/bookings/[bookingId] {status:'cancelled'} but the auth gate is
// the signed booking-edit token. The token scopes to a single
// booking_group_id so a participant can't cancel someone else's row.
//
// Same edit cutoff as the reschedule path (BOOKING_EDIT_CUTOFF_HOURS).
const EDIT_CUTOFF_HOURS = BOOKING_EDIT_CUTOFF_HOURS;

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string; bookingId: string }> },
) {
  const { token, bookingId } = await params;

  const access = await requireBookingEditAccess(token, bookingId, {
    extraBookingColumns: "status, google_event_id, slot_start",
    extraExperimentColumns: "google_calendar_id",
  });
  if (access instanceof NextResponse) return access;
  const { verified, admin } = access;
  const booking = access.booking as unknown as {
    id: string;
    booking_group_id: string;
    status: string;
    google_event_id: string | null;
    slot_start: string;
    experiments: { google_calendar_id: string | null } | null;
  };

  if (booking.status !== "confirmed") {
    return NextResponse.json(
      { error: "이미 다른 상태로 처리된 예약입니다" },
      { status: 400 },
    );
  }

  // Edit cutoff — same as reschedule.
  const oldStartMs = new Date(booking.slot_start).getTime();
  if (oldStartMs - Date.now() < EDIT_CUTOFF_HOURS * 60 * 60 * 1000) {
    return NextResponse.json(
      {
        error: `회차 시작 ${EDIT_CUTOFF_HOURS}시간 이내에는 자가 취소가 불가능합니다. 담당 연구원에게 연락해 주세요.`,
      },
      { status: 400 },
    );
  }

  // Flip status.
  const { error: updateErr } = await admin
    .from("bookings")
    .update({ status: "cancelled" })
    .eq("id", bookingId);
  if (updateErr) {
    return NextResponse.json(
      { error: "취소 처리 중 오류가 발생했습니다" },
      { status: 500 },
    );
  }

  // Clean up GCal event (best-effort — never roll back the cancel for a
  // calendar hiccup; researcher cleans up via admin UI if needed).
  // Failure surfaces in the response so the participant knows the lab
  // calendar may still show their slot until manually reconciled.
  const experiment = booking.experiments as
    | { google_calendar_id: string | null }
    | null;
  const calendarId = (
    experiment?.google_calendar_id || process.env.GOOGLE_CALENDAR_ID || ""
  ).trim();
  let calendarSyncWarning: string | null = null;
  if (booking.google_event_id && calendarId) {
    try {
      await deleteEvent(calendarId, booking.google_event_id);
      await admin
        .from("bookings")
        .update({ google_event_id: null })
        .eq("id", bookingId);
      await invalidateCalendarCache(calendarId).catch(() => {});
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[ParticipantCancel] deleteEvent failed for ${booking.google_event_id} on ${calendarId}:`,
        msg,
      );
      calendarSyncWarning =
        "취소가 접수되었으나 Google 캘린더에서 일정을 삭제하지 못했습니다. 담당 연구원에게 알려주시면 직접 정리해 드립니다.";
      await admin
        .from("booking_integrations")
        .update({
          status: "failed",
          last_error: scrubPii(
            `participant cancel deleteEvent failed for ${booking.google_event_id}: ${msg}`,
          ).slice(0, 500),
          processed_at: new Date().toISOString(),
        })
        .eq("booking_id", bookingId)
        .eq("integration_type", "gcal");
      await invalidateCalendarCache(calendarId).catch(() => {});
    }
  } else if (booking.google_event_id && !calendarId) {
    calendarSyncWarning =
      "취소가 접수되었으나 이 실험에 연결된 Google 캘린더 설정이 없어 일정 삭제가 건너뛰어졌습니다.";
    console.warn(
      `[ParticipantCancel] no calendar configured but booking ${bookingId} has google_event_id ${booking.google_event_id}`,
    );
  }

  // Notify researcher (and re-send participant a cancellation confirmation).
  // Same notify hook the admin PUT uses.
  try {
    const result = await notifyBookingStatusChange(admin, bookingId, "cancelled");
    if (result.outcome === "send_failed") {
      console.warn(
        `[ParticipantCancel] status-notify failed for ${bookingId}: ${result.detail}`,
      );
    }
  } catch (err) {
    console.error(
      "[ParticipantCancel] notifyBookingStatusChange crashed:",
      err instanceof Error ? err.message : err,
    );
  }

  // Fire payment-info dispatch as well — the helper's gate now treats
  // cancelled bookings as terminal-non-blocking (A2 / hidden-couplings
  // #25), so cancelling one session in a multi-session group lets the
  // remaining completed sessions dispatch immediately. If every session
  // ended up cancelled, the helper transitions payment_info.status to
  // 'cancelled' so the row stops blocking the pending queue.
  try {
    await notifyPaymentInfoIfReady(admin, verified.bookingGroupId);
  } catch (err) {
    console.error(
      "[ParticipantCancel] notifyPaymentInfoIfReady crashed:",
      err instanceof Error ? err.message : err,
    );
  }

  return NextResponse.json({ ok: true, calendar_sync_warning: calendarSyncWarning });
}
