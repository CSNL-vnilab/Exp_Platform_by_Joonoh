// requireBookingEditAccess — shared gate for /api/booking-edit/[token]/[bookingId]/*
// routes.
//
// Why this exists (refactor-roadmap B4-edit, 2026-05-30):
//
// The two participant-facing booking-edit endpoints — cancel and
// reschedule — each duplicate the same 4-step gate:
//
//   1. Validate the booking UUID.
//   2. Verify the HMAC signed booking-edit token (60-day TTL).
//   3. Check the name+phone verify-session cookie scoped to the
//      booking_group encoded in the token.
//   4. Load the booking + joined experiment and confirm the booking
//      belongs to the token's booking_group.
//
// Each step has a participant-facing Korean error message — those need
// to stay readable in the UI because the response surface is the
// participant's browser, not a researcher's dashboard. Helper keeps
// the messages verbatim and exposes `extraBookingColumns` /
// `extraExperimentColumns` so the two routes can pull their respective
// downstream columns without re-fetching.
//
// Unlike requireExperimentAccess / requireBookingAccess (which gate by
// admin/owner profile.role), this helper has NO admin override — the
// token IS the credential. A misuse of the helper from a non-token
// surface would 401 immediately because there's no signed payload to
// verify. The function is intentionally not reused outside
// src/app/api/booking-edit/.

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidUUID } from "@/lib/utils/validation";
import {
  verifyBookingEditToken,
  BookingEditTokenError,
  type VerifiedBookingEditToken,
} from "@/lib/booking-edit/token";
import {
  readVerifySession,
  BOOKING_EDIT_SESSION_COOKIE,
  type VerifySession,
} from "@/lib/booking-edit/session";

/**
 * Verify a booking-edit HMAC token and translate the typed error into a
 * NextResponse with the same Korean user-facing message the cancel /
 * reschedule / verify routes were duplicating. Returns the decoded
 * claims on success.
 *
 * Exposed separately from `requireBookingEditAccess` because the verify
 * endpoint itself (`POST /api/booking-edit/[token]/verify`) needs the
 * token check WITHOUT the session-cookie / booking-row resolution —
 * that endpoint IS what mints the session cookie in the first place
 * (chicken-and-egg).
 */
export function verifyBookingEditTokenOrError(
  token: string,
): VerifiedBookingEditToken | NextResponse {
  try {
    return verifyBookingEditToken(token);
  } catch (err) {
    if (err instanceof BookingEditTokenError && err.code === "EXPIRED") {
      return NextResponse.json(
        { error: "링크가 만료되었습니다" },
        { status: 401 },
      );
    }
    return NextResponse.json(
      { error: "링크가 유효하지 않습니다" },
      { status: 401 },
    );
  }
}

type AdminClient = ReturnType<typeof createAdminClient>;

export interface BookingEditAccessContext {
  /** Decoded token claims (booking_group_id + issuedAt). */
  verified: VerifiedBookingEditToken;
  /** Verified identity session pulled from the be_session cookie. */
  session: VerifySession;
  /**
   * Booking row — id + booking_group_id always present; additional
   * columns appear when `extraBookingColumns` is set.
   */
  booking: { id: string; booking_group_id: string | null };
  /** Service-role Supabase client. */
  admin: AdminClient;
}

export interface BookingEditAccessOptions {
  /**
   * Extra booking columns to include in the select. The required
   * `id, booking_group_id` are always included.
   */
  extraBookingColumns?: string;
  /**
   * Extra experiment columns to include in the joined select. The
   * join always uses `experiments(...)`; omit this when the route
   * doesn't need any experiment field beyond the booking-group gate.
   */
  extraExperimentColumns?: string;
}

/**
 * Returns either a `BookingEditAccessContext` (gate passed — caller
 * proceeds) or a `NextResponse` (gate failed — caller returns it).
 *
 * Failure modes (with their participant-facing Korean messages):
 *   * 400 "잘못된 예약 ID입니다"             — bookingId not a UUID
 *   * 401 "링크가 만료되었습니다"             — token expired (60d)
 *   * 401 "링크가 유효하지 않습니다"          — token malformed / bad signature
 *   * 401 "본인 확인이 필요합니다..."         — no/invalid verify cookie
 *   * 404 "예약을 찾을 수 없습니다"           — bookings row missing
 *   * 403 "권한이 없습니다"                   — booking_group mismatch
 *
 * Usage:
 *
 *     const access = await requireBookingEditAccess(token, bookingId, {
 *       extraBookingColumns: "status, slot_start, google_event_id",
 *       extraExperimentColumns: "google_calendar_id",
 *     });
 *     if (access instanceof NextResponse) return access;
 *     const { verified, session, booking, admin } = access;
 */
export async function requireBookingEditAccess(
  token: string,
  bookingId: string,
  opts: BookingEditAccessOptions = {},
): Promise<BookingEditAccessContext | NextResponse> {
  if (!isValidUUID(bookingId)) {
    return NextResponse.json(
      { error: "잘못된 예약 ID입니다" },
      { status: 400 },
    );
  }

  const tokenResult = verifyBookingEditTokenOrError(token);
  if (tokenResult instanceof NextResponse) return tokenResult;
  const verified: VerifiedBookingEditToken = tokenResult;

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

  const baseBookingCols = "id, booking_group_id";
  const bookingCols = opts.extraBookingColumns
    ? `${baseBookingCols}, ${opts.extraBookingColumns}`
    : baseBookingCols;
  const selectExpr = opts.extraExperimentColumns
    ? `${bookingCols}, experiments(${opts.extraExperimentColumns})`
    : bookingCols;

  const { data: bookingRow, error: fetchErr } = await admin
    .from("bookings")
    .select(selectExpr)
    .eq("id", bookingId)
    .maybeSingle();

  if (fetchErr || !bookingRow) {
    return NextResponse.json(
      { error: "예약을 찾을 수 없습니다" },
      { status: 404 },
    );
  }

  const bookingTyped = bookingRow as unknown as {
    id: string;
    booking_group_id: string | null;
  };
  if (bookingTyped.booking_group_id !== verified.bookingGroupId) {
    return NextResponse.json(
      { error: "권한이 없습니다" },
      { status: 403 },
    );
  }

  return {
    verified,
    session,
    booking: bookingTyped,
    admin,
  };
}
