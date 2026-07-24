import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { z } from "zod/v4";
import { normalizePhone } from "@/lib/utils/validation";
import { rateLimit } from "@/lib/utils/rate-limit";
import { verifyBookingEditTokenOrError } from "@/lib/booking-edit/access";
import {
  issueVerifySession,
  BOOKING_EDIT_SESSION_COOKIE,
  BOOKING_EDIT_SESSION_TTL_MS,
} from "@/lib/booking-edit/session";

function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const xri = req.headers.get("x-real-ip");
  if (xri) return xri.trim();
  return "unknown";
}

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

  const tokenResult = verifyBookingEditTokenOrError(token);
  if (tokenResult instanceof NextResponse) return tokenResult;
  const verifiedToken = tokenResult;

  // Rate-limit the identity guess BEFORE touching the DB — an unauthenticated
  // name+phone check is a brute-force target (the payment routes already gate
  // this way). Per-IP (broad) + per-token (the group under attack).
  const rl429 = () =>
    new NextResponse(
      JSON.stringify({ error: "요청이 많아 잠시 후 다시 시도해 주세요." }),
      {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "60" },
      },
    );
  const ip = clientIp(request);
  if (!rateLimit("booking-verify-ip", ip, { windowMs: 60_000, max: 10 }).allowed) {
    return rl429();
  }
  const tokenKey = createHash("sha256").update(token).digest("hex").slice(0, 32);
  if (
    !rateLimit("booking-verify-token", tokenKey, { windowMs: 60_000, max: 5 })
      .allowed
  ) {
    return rl429();
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

  // Reject any EMPTY normalized factor — a backfilled/phone-less participant
  // (stored phone empty by policy) would otherwise pass with an empty phone
  // input, collapsing the two-factor gate to name-only. Empty can never match.
  if (!storedName || !storedPhone || !inName || !inPhone) {
    return NextResponse.json(
      { error: "본인 확인에 실패했습니다. 입력하신 정보를 확인해 주세요." },
      { status: 401 },
    );
  }

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
  //
  // One cookie at the ROOT path, deliberately. The page lives at
  // /booking-edit/<token> and the cancel/reschedule APIs at
  // /api/booking-edit/<token>/... — those two share no common path prefix
  // except "/". Next's ResponseCookies.set() keys its internal map by
  // cookie NAME only (node_modules/next/.../@edge-runtime/cookies), so two
  // set() calls with the same name but different paths collapse to a single
  // Set-Cookie header — whichever was set LAST. The previous two-cookie
  // form therefore only ever emitted the /api/... path, so a post-verify
  // `location.reload()` of the page (at /booking-edit/<token>) never
  // received the cookie and the verify form re-prompted forever. A single
  // root-path cookie reaches both surfaces. Security is unchanged: it comes
  // from the signed, group-bound value (readVerifySession rejects on
  // bookingGroupId mismatch), not from path scoping.
  const secure = process.env.NODE_ENV === "production";
  res.cookies.set({
    name: BOOKING_EDIT_SESSION_COOKIE,
    value: session.value,
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: Math.floor(BOOKING_EDIT_SESSION_TTL_MS / 1000),
  });
  return res;
}
