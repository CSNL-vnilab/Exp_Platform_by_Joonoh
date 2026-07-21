import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod/v4";
import { requireBookingAccess } from "@/lib/auth/booking-access";
import { deleteEvent } from "@/lib/google/calendar";
import { invalidateCalendarCache } from "@/lib/google/freebusy-cache";
import { archiveBookingPage } from "@/lib/notion/client";

// POST /api/bookings/[bookingId]/wipe
//
// 노쇼(펑크) 처리 & 기록 삭제. Deletes the ENTIRE booking group the given
// booking belongs to — bookings + participant_payment_info — plus the
// external artifacts (Google Calendar events, Notion pages). After a wipe
// the participant can re-apply to the same experiment cleanly: the freed
// subject_number, recruitment seat, and cross-study exclusion match are
// all gone (all keyed on the deleted booking rows).
//
// This route does NOT notify the participant. Notification is a separate,
// deliberate action: click "불참(노쇼) 처리" first (PUT status=no_show,
// which emails/SMSes the participant) and THEN "노쇼 기록 삭제" if you also
// want to purge the record. Keeping them separate avoids the impossible
// "notify after the row is deleted" and lets a silent cleanup stay silent.
//
// Order matters:
//   1. requireBookingAccess(ownerOnly) — only the experiment owner.
//   2. Server-derive the group id from the path bookingId (never trust a
//      client-supplied group id — IDOR guard).
//   3. Read-only PREFLIGHT guards (completed / money-moved / ever-claimed)
//      — refuse with 409 BEFORE any destructive/external side effect.
//   4. Delete Google Calendar events BEFORE deleting rows (the orphan
//      reaper finds stale events through surviving rows; a hard GCal
//      failure aborts the wipe so we never orphan an event).
//   5. Archive Notion pages (best-effort).
//   6. wipe_booking_group RPC (atomic guard backstop + the actual delete).
//   7. Optionally reopen an experiment auto-completed by recruitment-full,
//      so the participant can actually re-book (book_slot requires active).

const MONEY_MOVED_STATUSES = [
  "claimed",
  "submitted_to_admin",
  "paid",
  "paid_offline",
];

const bodySchema = z.object({
  reason: z.string().max(500).optional(),
  // Reopen the experiment if a recruitment-full auto-complete flipped it
  // to 'completed'. Without this, book_slot returns EXPERIMENT_NOT_FOUND
  // and the participant still can't re-apply after the wipe.
  reopenExperiment: z.boolean().optional().default(false),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ bookingId: string }> },
) {
  try {
    const { bookingId } = await params;

    const access = await requireBookingAccess(bookingId, {
      extraBookingColumns: "status, booking_group_id",
      ownerOnly: true,
    });
    if (access instanceof NextResponse) return access;
    const { user, admin } = access;
    const booking = access.booking as unknown as {
      id: string;
      experiment_id: string;
      status: string;
      booking_group_id: string | null;
    };

    const groupId = booking.booking_group_id;
    if (!groupId) {
      return NextResponse.json(
        { error: "이 예약은 그룹에 속해 있지 않아 삭제할 수 없습니다." },
        { status: 400 },
      );
    }

    // Parse the (optional) body — reason + reopen flag.
    let reason = "";
    let reopen = false;
    try {
      const raw = (await req.json().catch(() => ({}))) as unknown;
      const parsed = bodySchema.parse(raw ?? {});
      reason = (parsed.reason ?? "").slice(0, 500);
      reopen = parsed.reopenExperiment;
    } catch {
      // Malformed body → treat as no reason / no reopen.
    }

    // Load the whole group (server-derived id). One query pulls everything
    // the side-effect steps need.
    const { data: groupRows, error: groupErr } = await admin
      .from("bookings")
      .select("id, status, google_event_id, notion_page_id")
      .eq("booking_group_id", groupId);
    if (groupErr) {
      console.error(`[WipeBooking] group load failed: ${groupErr.message}`);
      return NextResponse.json(
        { error: "그룹 정보를 불러오지 못했습니다." },
        { status: 500 },
      );
    }
    if (!groupRows || groupRows.length === 0) {
      return NextResponse.json(
        { error: "삭제할 예약을 찾을 수 없습니다." },
        { status: 404 },
      );
    }
    const rows = groupRows as unknown as Array<{
      id: string;
      status: string;
      google_event_id: string | null;
      notion_page_id: string | null;
    }>;

    // ── PREFLIGHT guards (read-only) — same 3 conditions the RPC enforces
    //    atomically, evaluated here first so we refuse BEFORE any external
    //    side effect (no spurious GCal delete / Notion archive on a group
    //    that must be kept).
    if (rows.some((r) => r.status === "completed")) {
      return NextResponse.json(
        {
          error:
            "완료된 세션이 있는 그룹은 삭제할 수 없습니다 (실제 참여 기록 보존).",
          reason: "completed",
        },
        { status: 409 },
      );
    }
    const { data: piRows } = await admin
      .from("participant_payment_info")
      .select("status, claimed_at")
      .eq("booking_group_id", groupId);
    const moneyMoved = (piRows ?? []).some(
      (pi) =>
        MONEY_MOVED_STATUSES.includes(
          (pi as { status: string }).status,
        ) || (pi as { claimed_at: string | null }).claimed_at !== null,
    );
    const { data: claimRows } = await admin
      .from("payment_claims")
      .select("id")
      .contains("booking_group_ids", [groupId])
      .limit(1);
    const everClaimed = (claimRows ?? []).length > 0;
    if (moneyMoved || everClaimed) {
      return NextResponse.json(
        {
          error:
            "정산이 진행되었거나 청구된 그룹은 삭제할 수 없습니다 (감사 추적 보존).",
          reason: "payment",
        },
        { status: 409 },
      );
    }

    // Resolve experiment status + calendar id (requireBookingAccess doesn't
    // surface these on its return shape).
    const { data: expRow } = await admin
      .from("experiments")
      .select("id, status, google_calendar_id")
      .eq("id", booking.experiment_id)
      .maybeSingle();
    const experiment = (expRow ?? null) as {
      id: string;
      status: string | null;
      google_calendar_id: string | null;
    } | null;

    // ── GCal delete BEFORE row delete. deleteEvent swallows 404/410, so any
    //    throw is a real failure → abort so we never delete a row whose live
    //    calendar event survives (which the orphan reaper could no longer
    //    find).
    const calId = (
      experiment?.google_calendar_id ||
      process.env.GOOGLE_CALENDAR_ID ||
      ""
    ).trim();
    if (calId) {
      for (const r of rows) {
        if (!r.google_event_id) continue;
        try {
          await deleteEvent(calId, r.google_event_id);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(
            `[WipeBooking] deleteEvent failed for ${r.google_event_id} on ${calId}:`,
            msg,
          );
          return NextResponse.json(
            {
              error: `Google 캘린더 일정 삭제에 실패하여 중단했습니다 (${msg.slice(0, 150)}). 잠시 후 다시 시도해 주세요.`,
            },
            { status: 502 },
          );
        }
      }
      await invalidateCalendarCache(calId).catch(() => {});
    }

    // ── Notion archive (best-effort — a Notion outage must not block wipe).
    for (const r of rows) {
      if (!r.notion_page_id) continue;
      try {
        await archiveBookingPage(r.notion_page_id);
      } catch (err) {
        console.warn(
          `[WipeBooking] Notion archive failed for ${r.notion_page_id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    // ── The atomic delete (guards re-checked inside the RPC).
    const { data: rpcData, error: rpcErr } = await admin.rpc(
      "wipe_booking_group",
      {
        p_booking_group_id: groupId,
        p_wiped_by: user.id,
        p_reason: reason,
      },
    );
    if (rpcErr) {
      const m = rpcErr.message ?? "";
      if (m.includes("wipe_blocked_completed")) {
        return NextResponse.json(
          { error: "완료된 세션이 있어 삭제할 수 없습니다.", reason: "completed" },
          { status: 409 },
        );
      }
      if (m.includes("wipe_blocked_payment")) {
        return NextResponse.json(
          { error: "정산/청구 이력이 있어 삭제할 수 없습니다.", reason: "payment" },
          { status: 409 },
        );
      }
      if (m.includes("wipe_no_bookings")) {
        return NextResponse.json(
          { error: "삭제할 예약을 찾을 수 없습니다." },
          { status: 404 },
        );
      }
      console.error(`[WipeBooking] RPC failed: ${rpcErr.message}`);
      return NextResponse.json(
        { error: "기록 삭제 중 오류가 발생했습니다." },
        { status: 500 },
      );
    }

    // ── Reopen an auto-completed experiment so re-application is possible.
    let reopened = false;
    if (reopen && experiment && experiment.status === "completed") {
      const { error: reErr } = await admin
        .from("experiments")
        .update({ status: "active" })
        .eq("id", experiment.id)
        .eq("status", "completed");
      if (reErr) {
        console.warn(
          `[WipeBooking] experiment reopen failed: ${reErr.message}`,
        );
      } else {
        reopened = true;
      }
    }

    const wipedCount =
      (rpcData as { deleted_count?: number } | null)?.deleted_count ??
      rows.length;
    console.log(
      `[WipeBooking] group ${groupId} wiped (${wipedCount} rows) by ${user.id}, reopened=${reopened}`,
    );
    return NextResponse.json({ success: true, wipedCount, reopened });
  } catch (err) {
    console.error(
      "[WipeBooking] unhandled:",
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
