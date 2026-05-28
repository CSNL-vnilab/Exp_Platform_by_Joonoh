import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidUUID } from "@/lib/utils/validation";
import { deleteEvent } from "@/lib/google/calendar";
import { invalidateCalendarCache } from "@/lib/google/freebusy-cache";
import { notifyBookingStatusChange } from "@/lib/services/booking-status-notify.service";
import {
  verifyBookingEditToken,
  BookingEditTokenError,
} from "@/lib/booking-edit/token";
import {
  readVerifySession,
  BOOKING_EDIT_SESSION_COOKIE,
} from "@/lib/booking-edit/session";

// Participant-facing cancellation. Mirrors admin PUT
// /api/bookings/[bookingId] {status:'cancelled'} but the auth gate is
// the signed booking-edit token. The token scopes to a single
// booking_group_id so a participant can't cancel someone else's row.
//
// Same EDIT_CUTOFF_HOURS guard as the reschedule path.
const EDIT_CUTOFF_HOURS = 24;

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string; bookingId: string }> },
) {
  const { token, bookingId } = await params;

  if (!isValidUUID(bookingId)) {
    return NextResponse.json({ error: "잘못된 예약 ID입니다" }, { status: 400 });
  }

  let verified;
  try {
    verified = verifyBookingEditToken(token);
  } catch (err) {
    if (err instanceof BookingEditTokenError && err.code === "EXPIRED") {
      return NextResponse.json({ error: "링크가 만료되었습니다" }, { status: 401 });
    }
    return NextResponse.json({ error: "링크가 유효하지 않습니다" }, { status: 401 });
  }

  // Identity gate: require a fresh name+phone verification cookie scoped
  // to this booking_group. Mirrors the reschedule route.
  const cookieJar = await cookies();
  const sessionRaw = cookieJar.get(BOOKING_EDIT_SESSION_COOKIE)?.value;
  const session = readVerifySession(sessionRaw, verified.bookingGroupId);
  if (!session) {
    return NextResponse.json(
      { error: "본인 확인이 필요합니다. 페이지를 새로고침해 주세요." },
      { status: 401 },
    );
  }

  const admin = createAdminClient();

  const { data: booking, error: fetchErr } = await admin
    .from("bookings")
    .select(
      "id, status, google_event_id, slot_start, booking_group_id, experiments(google_calendar_id)",
    )
    .eq("id", bookingId)
    .single();

  if (fetchErr || !booking) {
    return NextResponse.json({ error: "예약을 찾을 수 없습니다" }, { status: 404 });
  }

  if (booking.booking_group_id !== verified.bookingGroupId) {
    return NextResponse.json({ error: "권한이 없습니다" }, { status: 403 });
  }

  if (booking.status !== "confirmed") {
    return NextResponse.json(
      { error: "이미 다른 상태로 처리된 예약입니다" },
      { status: 400 },
    );
  }

  // 24h cutoff — same as reschedule.
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
          last_error: `participant cancel deleteEvent failed for ${booking.google_event_id}: ${msg.slice(0, 500)}`,
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

  return NextResponse.json({ ok: true, calendar_sync_warning: calendarSyncWarning });
}
