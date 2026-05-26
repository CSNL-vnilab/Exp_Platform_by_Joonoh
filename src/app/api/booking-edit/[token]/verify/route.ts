import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { z } from "zod/v4";
import { normalizePhone } from "@/lib/utils/validation";
import {
  verifyBookingEditToken,
  BookingEditTokenError,
} from "@/lib/booking-edit/token";
import {
  issueVerifySession,
  BOOKING_EDIT_SESSION_COOKIE,
  BOOKING_EDIT_SESSION_TTL_MS,
} from "@/lib/booking-edit/session";

// POST /api/booking-edit/[token]/verify
//
// Identity gate. The token validates the URL signature (bearer-cred —
// anyone with the URL can call); this endpoint then asks "are you the
// participant?" by checking the supplied name + phone against the
// participants row that owns the booking_group. On success we set a
// signed HttpOnly cookie scoped to this group so refresh / API calls
// within 24h skip the re-prompt.
//
// Body: { name: string, phone: string }
// Returns: { ok: true } on success, 401/403 otherwise.

const verifySchema = z.object({
  name: z.string().min(1).max(200),
  phone: z.string().min(1).max(50),
});

function normalizeName(name: string): string {
  // Trim + collapse internal whitespace. Participants commonly have
  // "홍 길동" vs "홍길동" — we compare on the collapsed form on both
  // sides so the entry is forgiving of inputs.
  return name.replace(/\s+/g, "").trim();
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;

  let verifiedToken;
  try {
    verifiedToken = verifyBookingEditToken(token);
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

  const parsed = verifySchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "이름과 전화번호를 모두 입력해 주세요" },
      { status: 400 },
    );
  }

  const inName = normalizeName(parsed.data.name);
  const inPhone = normalizePhone(parsed.data.phone);

  const admin = createAdminClient();

  // Walk: booking_group → any booking → participant. We don't expose
  // participant_id directly; we re-derive it from the group so a stolen
  // group id alone is not enough.
  const { data: any_booking } = await admin
    .from("bookings")
    .select("participant_id, participants(name, phone)")
    .eq("booking_group_id", verifiedToken.bookingGroupId)
    .limit(1)
    .maybeSingle();

  type ParticipantRow = { name: string; phone: string };
  const row = any_booking as
    | { participant_id: string; participants: ParticipantRow | null }
    | null;

  if (!row || !row.participants) {
    // Group not found / no participant join — same response surface as
    // a mismatch to avoid letting an attacker tell "valid token, wrong
    // name" apart from "invalid token / no group".
    return NextResponse.json(
      { error: "본인 확인에 실패했습니다. 입력하신 정보를 확인해 주세요." },
      { status: 401 },
    );
  }

  const storedName = normalizeName(row.participants.name);
  const storedPhone = normalizePhone(row.participants.phone);

  if (inName !== storedName || inPhone !== storedPhone) {
    return NextResponse.json(
      { error: "본인 확인에 실패했습니다. 입력하신 정보를 확인해 주세요." },
      { status: 401 },
    );
  }

  const session = issueVerifySession({
    bookingGroupId: verifiedToken.bookingGroupId,
    participantId: row.participant_id,
  });

  const res = NextResponse.json({ ok: true });
  // HttpOnly so JS can't read it. SameSite=Lax so links from the email
  // client work (Strict would break first navigation). Secure only when
  // we're on https — preview deployments and prod both are.
  const secure = process.env.NODE_ENV === "production";
  res.cookies.set({
    name: BOOKING_EDIT_SESSION_COOKIE,
    value: session.value,
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: `/booking-edit/${token}`,
    maxAge: Math.floor(BOOKING_EDIT_SESSION_TTL_MS / 1000),
  });
  // Also expose under /api/booking-edit/<token> so cancel/reschedule
  // see the cookie. Path-scoping prevents bleed to other surfaces.
  res.cookies.set({
    name: BOOKING_EDIT_SESSION_COOKIE,
    value: session.value,
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: `/api/booking-edit/${token}`,
    maxAge: Math.floor(BOOKING_EDIT_SESSION_TTL_MS / 1000),
  });
  return res;
}
