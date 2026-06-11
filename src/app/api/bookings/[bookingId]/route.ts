import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod/v4";
import { normalizeToISO } from "@/lib/utils/validation";
import { getFreeBusy, deleteEvent } from "@/lib/google/calendar";
import {
  invalidateCalendarCache,
  excludeBookingOrphans,
} from "@/lib/google/freebusy-cache";
import { intervalsOverlap } from "@/lib/utils/date";
import {
  createReschedGCalEvent,
  renumberSessionsInGroup,
  runReschedulePipeline,
} from "@/lib/services/booking.service";
import {
  notifyPaymentInfoIfReady,
  sweepStalePastSiblings,
} from "@/lib/services/payment-info-notify.service";
import { notifyBookingStatusChange } from "@/lib/services/booking-status-notify.service";
import { scrubPii } from "@/lib/observability/pii";
import { requireBookingAccess } from "@/lib/auth/booking-access";
import { VALID_TRANSITIONS, type BookingStatus } from "@/lib/bookings/status";

// VALID_TRANSITIONS moved to the bookings/status SSOT module (2026-06-10
// blind review): the transition table is the canonical "what can flip to
// what" rule and was previously defined inline here only.

const bookingStatusSchema = z.object({
  status: z.enum(["confirmed", "cancelled", "completed", "no_show", "running"]),
});

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ bookingId: string }> }
) {
  try {
    const { bookingId } = await params;

    // ownerOnly preserves pre-helper semantics — admins cannot read
    // arbitrary bookings via this route.
    const access = await requireBookingAccess(bookingId, {
      extraBookingColumns: "*",
      ownerOnly: true,
    });
    if (access instanceof NextResponse) return access;

    return NextResponse.json({ booking: access.booking });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ bookingId: string }> }
) {
  try {
    const { bookingId } = await params;

    // ownerOnly — admins cannot flip arbitrary bookings via PUT. The
    // helper join pulls status/google_event_id/booking_group_id off
    // the booking and google_calendar_id off the experiment (needed
    // for the cancel→GCal-delete path below).
    const access = await requireBookingAccess(bookingId, {
      extraBookingColumns: "status, google_event_id, booking_group_id",
      extraExperimentColumns: "google_calendar_id",
      ownerOnly: true,
    });
    if (access instanceof NextResponse) return access;
    const { supabase, admin } = access;
    const booking = access.booking as unknown as {
      id: string;
      experiment_id: string;
      status: string;
      google_event_id: string | null;
      booking_group_id: string | null;
    };
    const experiment = access.experiment as unknown as {
      id: string;
      created_by: string | null;
      google_calendar_id: string | null;
    };

    const body = await request.json();
    const result = bookingStatusSchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        { error: "Validation failed", issues: result.error.issues },
        { status: 400 }
      );
    }

    const { status } = result.data;

    // Validate status transition
    const allowed = VALID_TRANSITIONS[booking.status as BookingStatus] ?? [];
    if (!allowed.includes(status)) {
      return NextResponse.json(
        { error: `상태를 '${booking.status}'에서 '${status}'(으)로 변경할 수 없습니다` },
        { status: 400 }
      );
    }

    const { data: updated, error: updateError } = await supabase
      .from("bookings")
      .update({ status })
      .eq("id", bookingId)
      .select()
      .single();

    if (updateError) {
      return NextResponse.json({ error: "상태 업데이트 중 오류가 발생했습니다" }, { status: 500 });
    }

    // When a booking is cancelled, delete the Google Calendar event (if any)
    // so participants don't see a stale invite; also invalidate freebusy cache.
    //
    // Failure mode handled explicitly: a SLAB calendar can refuse the
    // delete (permissions / transient 5xx). Previously we swallowed the
    // error silently and left google_event_id set, which produced
    // "phantom" calendar events the researcher kept seeing after a
    // successful cancel. Now we surface the failure to the caller via
    // calendar_sync_warning and write it to booking_integrations so a
    // reconcile job (or operator) can find it.
    let calendarSyncWarning: string | null = null;
    if (status === "cancelled" && booking.google_event_id) {
      const calId = (
        experiment.google_calendar_id || process.env.GOOGLE_CALENDAR_ID || ""
      ).trim();
      if (calId) {
        try {
          await deleteEvent(calId, booking.google_event_id);
          await supabase
            .from("bookings")
            .update({ google_event_id: null })
            .eq("id", bookingId);
          await invalidateCalendarCache(calId).catch(() => {});
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(
            `[CancelBooking] deleteEvent failed for ${booking.google_event_id} on ${calId}:`,
            msg,
          );
          calendarSyncWarning = `Google 캘린더에서 일정 삭제에 실패했습니다 (${msg.slice(0, 200)}). 캘린더에서 직접 확인해 주세요.`;
          // Record on the booking_integrations audit row so the failure
          // is searchable later. We DON'T clear google_event_id here —
          // keeping it lets a future retry know which event to target.
          // (admin client reused from requireBookingAccess above.)
          await admin
            .from("booking_integrations")
            .update({
              status: "failed",
              last_error: scrubPii(
                `cancel deleteEvent failed for ${booking.google_event_id}: ${msg}`,
              ).slice(0, 500),
              processed_at: new Date().toISOString(),
            })
            .eq("booking_id", bookingId)
            .eq("integration_type", "gcal");
          // Invalidate the cache anyway so stale busy intervals don't
          // mislead the next booking attempt.
          await invalidateCalendarCache(calId).catch(() => {});
        }
      } else if (booking.google_event_id) {
        // No calendar configured but a booking holds an event id — likely
        // mis-configured experiment. Surface as a warning so the operator
        // notices.
        calendarSyncWarning = `이 실험에 연결된 Google 캘린더가 없어 일정 삭제가 건너뛰어졌습니다. 캘린더 설정을 확인해 주세요.`;
        console.warn(
          `[CancelBooking] no calendar configured but booking ${bookingId} has google_event_id ${booking.google_event_id}`,
        );
      }
    }

    // Pending reminders are already guarded at send time: reminder.service skips
    // bookings with status='cancelled' and marks them 'sent', so no update needed.

    // Notify the participant when their booking flips to cancelled or
    // no_show. Fire-and-forget — never let an SMTP/SMS failure roll back
    // the status change. Audit/observability is in the notify service.
    if (status === "cancelled" || status === "no_show") {
      try {
        const result = await notifyBookingStatusChange(
          admin,
          bookingId,
          status,
        );
        if (result.outcome === "send_failed") {
          console.warn(
            `[BookingPUT] status-notify failed for ${bookingId} (${status}): ${result.detail}`,
          );
        }
      } catch (err) {
        console.error(
          "[BookingPUT] notifyBookingStatusChange crashed:",
          err instanceof Error ? err.message : err,
        );
      }
    }

    // Fire payment-info dispatch on completion AND on cancellation. The
    // notify helper itself checks "all non-cancelled bookings in the
    // group are completed" + "payment_link_sent_at IS NULL" so calling
    // it on every relevant flip is safe; multi-session groups simply
    // no-op until the last non-cancelled session completes.
    //
    // 2026-05-29 (A2): also fire on cancelled — the helper now treats
    // cancelled bookings as terminal-non-blocking. Cancelling the last
    // pending session in a group whose other sessions are already
    // completed triggers dispatch; cancelling every session transitions
    // payment_info to 'cancelled' so it stops blocking the queue.
    const paymentInfoGroupId =
      (status === "completed" || status === "cancelled") &&
      booking.booking_group_id
        ? booking.booking_group_id
        : null;
    if (paymentInfoGroupId && status === "completed") {
      // 2026-06-09: when the researcher marks any session 'completed' via
      // the observation modal, sweep sibling sessions in the same group
      // whose slot_end is already past but status is still 'confirmed'.
      // These are stale rows that the auto-complete cron will eventually
      // pick up (after a 7d grace), but for multi-session experiments
      // (e.g. TimeExp1 Sbj16) the researcher typically only marks THE
      // LAST session manually and expects the payment-info email to fire
      // immediately — without this sweep, sessions 3/4 stay 'confirmed'
      // and notifyPaymentInfoIfReady bails on NOT_ALL_COMPLETED until
      // the cron sweep days later.
      //
      // Scope: only sibling rows in the same booking_group where
      // slot_end < now AND status='confirmed'. Future-scheduled and
      // already-terminal (cancelled/no_show) rows are left alone.
      // (2026-06-10: extracted to sweepStalePastSiblings so the
      // observation-modal door shares identical semantics.)
      await sweepStalePastSiblings(admin, paymentInfoGroupId, bookingId);
    }
    if (paymentInfoGroupId && status === "cancelled") {
      // Re-derive 활용일자 after a cancel (2026-06-10 review [16/21]) —
      // without this the claim documents kept a period stretching to
      // the cancelled session's date. The RPC only touches rows still
      // pending_participant and recomputes period from live
      // (confirmed/running/completed) bookings; amount is preserved
      // for overridden rows.
      try {
        await admin.rpc("propagate_payment_period", {
          p_booking_group_id: paymentInfoGroupId,
        });
      } catch (err) {
        console.warn(
          "[BookingPUT] propagate_payment_period failed:",
          err instanceof Error ? err.message : err,
        );
      }
    }
    if (paymentInfoGroupId) {
      try {
        const result = await notifyPaymentInfoIfReady(
          admin,
          paymentInfoGroupId,
        );
        if (result.outcome === "send_failed") {
          console.warn(
            `[BookingPUT] payment-info dispatch failed for ${booking.booking_group_id}: ${result.detail}`,
          );
        }
      } catch (err) {
        // Never fail the status PUT because of an email error.
        console.error(
          "[BookingPUT] notifyPaymentInfoIfReady crashed:",
          err instanceof Error ? err.message : err,
        );
      }
    }

    return NextResponse.json({
      booking: updated,
      calendar_sync_warning: calendarSyncWarning,
    });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// PATCH — reschedule an existing booking to a different slot. Admin or the
// experiment owner (researcher) may reschedule. New slot must be in the
// future, land on an allowed weekday, not clash with another confirmed
// booking, and not overlap a busy interval on the experiment's calendar.
//
// Note: session_number is no longer a client-controllable field. After
// the slot update lands we re-sort every booking in the group by date
// and rewrite session_number 1..N (see renumberSessionsInGroup), which
// is the right semantics: "회차" follows chronology, not whatever the
// participant entered first.
const rescheduleSchema = z.object({
  slot_start: z.string().datetime(),
  slot_end: z.string().datetime(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ bookingId: string }> },
) {
  const { bookingId } = await params;

  // Default owner-or-admin — admins were allowed to reschedule
  // pre-helper. The select pulls every booking + experiment column the
  // reschedule pipeline below references (status / slot window / group
  // members for renumber / google_event_id for GCal patch on the
  // booking side; weekdays / capacity / calendar_id / status on the
  // experiment side for the slot validation).
  const access = await requireBookingAccess(bookingId, {
    extraBookingColumns:
      "status, slot_start, slot_end, session_number, booking_group_id, google_event_id",
    extraExperimentColumns:
      "weekdays, max_participants_per_slot, google_calendar_id, status",
  });
  if (access instanceof NextResponse) return access;
  const { admin } = access;
  const booking = access.booking as unknown as {
    id: string;
    experiment_id: string;
    status: string;
    slot_start: string;
    slot_end: string;
    session_number: number;
    booking_group_id: string | null;
    google_event_id: string | null;
  };
  const exp = access.experiment as unknown as {
    id: string;
    created_by: string | null;
    weekdays: number[];
    max_participants_per_slot: number;
    google_calendar_id: string | null;
    status: string;
  };

  if (booking.status !== "confirmed") {
    return NextResponse.json(
      { error: "확정 상태의 예약만 변경할 수 있습니다" },
      { status: 400 },
    );
  }

  const parsed = rescheduleSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "잘못된 요청입니다" },
      { status: 400 },
    );
  }

  const newStart = new Date(parsed.data.slot_start);
  const newEnd = new Date(parsed.data.slot_end);
  if (newStart <= new Date()) {
    return NextResponse.json({ error: "이미 지난 시간으로는 변경할 수 없습니다" }, { status: 400 });
  }
  if (newEnd <= newStart) {
    return NextResponse.json({ error: "종료 시간이 시작 시간보다 이후여야 합니다" }, { status: 400 });
  }

  // Weekday check (KST)
  const kstParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(newStart);
  const kstDateStr = `${kstParts.find((p) => p.type === "year")!.value}-${kstParts.find((p) => p.type === "month")!.value}-${kstParts.find((p) => p.type === "day")!.value}`;
  const kstDow = new Date(`${kstDateStr}T09:00:00+09:00`).getDay();
  if (!exp.weekdays.includes(kstDow)) {
    return NextResponse.json({ error: "실험 운영 요일이 아닙니다" }, { status: 400 });
  }

  // Capacity check (excluding this booking)
  const { data: conflicts } = await admin
    .from("bookings")
    .select("id")
    .eq("experiment_id", booking.experiment_id)
    .eq("status", "confirmed")
    // Time-overlap (00069), not exact-match — an overlapping slot at a finer
    // increment must count as taken or a reschedule could double-book.
    .lt("slot_start", newEnd.toISOString())
    .gt("slot_end", newStart.toISOString())
    .neq("id", bookingId);

  if ((conflicts?.length ?? 0) >= exp.max_participants_per_slot) {
    return NextResponse.json(
      { error: "선택한 시간대가 이미 예약되었습니다" },
      { status: 409 },
    );
  }

  // GCal busy check (best-effort, ignore the booking's own event)
  const calendarId = (exp.google_calendar_id || process.env.GOOGLE_CALENDAR_ID || "").trim() || null;
  if (calendarId) {
    try {
      const busy = await excludeBookingOrphans(
        await getFreeBusy(calendarId, newStart, newEnd),
      );
      const conflict = busy.some((b) => {
        // Skip busy intervals that coincide with this booking's existing event
        // (we'll delete that event anyway)
        if (
          Math.abs(b.start.getTime() - new Date(booking.slot_start).getTime()) < 60_000 &&
          Math.abs(b.end.getTime() - new Date(booking.slot_end).getTime()) < 60_000
        ) {
          return false;
        }
        return intervalsOverlap({ start: newStart, end: newEnd }, b);
      });
      if (conflict) {
        return NextResponse.json(
          { error: "선택한 시간대가 캘린더의 기존 일정과 겹칩니다" },
          { status: 409 },
        );
      }
    } catch {
      // best-effort
    }
  }

  const oldSlotStart = booking.slot_start;
  const oldSlotEnd = booking.slot_end;
  const oldEventId = booking.google_event_id;

  const normalizedStart = normalizeToISO(newStart.toISOString());
  const normalizedEnd = normalizeToISO(newEnd.toISOString());

  // Atomicity (P2-1): create the new GCal event BEFORE touching the DB.
  // If GCal fails synchronously, DB and calendar both stay on the old slot
  // so the researcher can retry without being in an in-between state. Worst
  // case is a spare calendar event (if the DB update later fails), which is
  // preferable to a missing one.
  let newEventId: string | null = null;
  try {
    const { eventId } = await createReschedGCalEvent(
      bookingId,
      normalizedStart,
      normalizedEnd,
    );
    newEventId = eventId;
  } catch (err) {
    console.error(
      "[Reschedule] pre-create GCal failed:",
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json(
      {
        error:
          "캘린더 업데이트에 실패해 예약이 변경되지 않았습니다. 잠시 후 다시 시도해 주세요.",
      },
      { status: 502 },
    );
  }

  const update: {
    slot_start: string;
    slot_end: string;
    google_event_id?: string | null;
  } = {
    slot_start: normalizedStart,
    slot_end: normalizedEnd,
  };
  if (newEventId) {
    update.google_event_id = newEventId;
  }

  // CAS on status (2026-06-10 blind review [28]): the status gate at the
  // top of this handler ran BEFORE the GCal round-trip above — during
  // that window a concurrent writer (e.g. the sibling auto-complete
  // sweep in the status PUT, which targets past-confirmed rows) can flip
  // this booking to 'completed'. Without the .eq("status","confirmed")
  // guard the slot write landed on the completed row, producing a
  // 'completed' booking scheduled in the FUTURE plus a premature
  // payment email. Zero affected rows → undo the GCal pre-create and
  // 409 so the researcher re-loads and retries.
  const { data: updatedRows, error: updateErr } = await admin
    .from("bookings")
    .update(update)
    .eq("id", bookingId)
    .eq("status", "confirmed")
    .select("id");
  if (updateErr) {
    // DB update failed AFTER new GCal event created. Best we can do is log
    // the orphan id and return the error — next outbox sweep or a manual
    // cleanup has to fix it. Participant sees old time (DB unchanged);
    // orphan event on calendar is the lesser evil.
    console.error(
      "[Reschedule] DB update failed after GCal create, orphan event:",
      newEventId,
    );
    return NextResponse.json({ error: "예약 변경에 실패했습니다" }, { status: 500 });
  }
  if (!updatedRows || updatedRows.length === 0) {
    // Status changed mid-flight — clean up the just-created GCal event
    // and bail. Best-effort delete; on failure the orphan-reaper cron
    // collects it.
    if (newEventId) {
      try {
        const calId = (
          exp.google_calendar_id || process.env.GOOGLE_CALENDAR_ID || ""
        ).trim();
        if (calId) await deleteEvent(calId, newEventId);
      } catch (err) {
        console.error(
          "[Reschedule] CAS-conflict GCal cleanup failed, orphan event:",
          newEventId,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return NextResponse.json(
      { error: "예약 상태가 변경되어(완료/취소) 일정을 변경할 수 없습니다. 새로고침 후 다시 확인해 주세요." },
      { status: 409 },
    );
  }

  // Renumber sessions in the participant's group by date order. Multi-
  // session participants commonly hit "1회차 was Mon, now I want it on
  // Fri" — without this rewrite the session_number labels (and
  // payment-info ordering) drift out of chronological order.
  let renumberInfo: { changed: number; total: number } | null = null;
  if (booking.booking_group_id) {
    try {
      renumberInfo = await renumberSessionsInGroup(booking.booking_group_id);
    } catch (err) {
      console.error("[Reschedule] renumber failed:", err);
    }
  }

  await runReschedulePipeline({
    bookingId,
    oldSlotStart,
    oldSlotEnd,
    oldEventId,
    newEventId,
  }).catch((err) => {
    console.error("[Reschedule] pipeline failed:", err);
  });

  // Surface GCal sync warnings from runReschedulePipeline back to the
  // researcher. The pipeline records old-event-delete failures in
  // booking_integrations.last_error (see booking.service.ts) — we read
  // it here and forward so the admin UI can warn that the old SLAB
  // event may still be visible.
  let calendarSyncWarning: string | null = null;
  const { data: gcalRow } = await admin
    .from("booking_integrations")
    .select("last_error")
    .eq("booking_id", bookingId)
    .eq("integration_type", "gcal")
    .maybeSingle();
  if (gcalRow?.last_error) {
    calendarSyncWarning = `Google 캘린더의 이전 일정 정리에 실패했습니다 — 캘린더에서 직접 확인해 주세요. (${gcalRow.last_error.slice(0, 200)})`;
  }

  return NextResponse.json({
    ok: true,
    renumber: renumberInfo,
    calendar_sync_warning: calendarSyncWarning,
  });
}
