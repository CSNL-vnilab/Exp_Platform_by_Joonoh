import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireExperimentAccess } from "@/lib/auth/experiment-access";
import { isValidUUID } from "@/lib/utils/validation";
import { issueBookingEditToken } from "@/lib/booking-edit/token";
import { buildRescheduleInviteEmail } from "@/lib/services/reschedule-invite-email";
import type { RescheduleEmailResearcher } from "@/lib/services/booking-reschedule-email";
import { sendEmail } from "@/lib/google/gmail";

// /api/experiments/:experimentId/reschedule-invite/:bookingGroupId
//
// Researcher → participant "실험 일정을 재조정해 주세요" INVITE email.
// One-button-with-preview flow, mirroring the payment-claim email route:
//
//   GET  → returns the rendered preview (to / subject / html + the
//          token-gated edit URL) so the frontend can show a confirmation
//          modal. Read-only, sends nothing.
//   POST → re-builds with the (optional) researcher note and dispatches
//          the mail via Gmail SMTP.
//
// Auth: experiment owner or admin (requireExperimentAccess). Both GET and
// POST resolve the same participant + researcher context; only POST has a
// side effect (send).

// Shared context: auth gate + participant/researcher resolution.
//
// Returns either an error NextResponse (caller returns it directly) or the
// resolved context. The bookingGroupId identifies one participant's
// enrollment; we load a single representative booking of that group to get
// the participant, then resolve the experiment owner's profile for the
// researcher envelope block + the fresh token-gated edit URL.
type ResolvedContext = {
  participant: { name: string; email: string };
  experimentTitle: string;
  researcher: RescheduleEmailResearcher | null;
  editUrl: string;
};

async function resolveContext(
  request: NextRequest,
  experimentId: string,
  bookingGroupId: string,
): Promise<ResolvedContext | NextResponse> {
  if (!isValidUUID(bookingGroupId)) {
    return NextResponse.json(
      { error: "Invalid booking group ID" },
      { status: 400 },
    );
  }

  const access = await requireExperimentAccess(experimentId, {
    extraColumns: "title",
  });
  if (access instanceof NextResponse) return access;
  const { admin, experiment } = access;

  // requireExperimentAccess only guarantees id/created_by on `experiment`;
  // `title` is present because we requested it via extraColumns.
  const experimentRow = experiment as unknown as {
    id: string;
    created_by: string | null;
    title: string | null;
  };
  const experimentTitle = experimentRow.title ?? "실험";

  // Load one representative booking of this group to resolve the
  // participant. limit(1) + maybeSingle: the group may hold several
  // sessions but they all belong to the same participant.
  const { data: booking } = await admin
    .from("bookings")
    .select("participant_id, experiment_id, participants(name,email)")
    .eq("booking_group_id", bookingGroupId)
    .limit(1)
    .maybeSingle();

  const bookingRow = booking as unknown as {
    participant_id: string | null;
    experiment_id: string | null;
    participants: { name: string | null; email: string | null } | null;
  } | null;

  // 404 when the group doesn't exist OR belongs to a different experiment
  // (prevents cross-experiment enumeration via a valid-but-foreign group id).
  if (!bookingRow || bookingRow.experiment_id !== experimentId) {
    return NextResponse.json(
      { error: "Booking group not found" },
      { status: 404 },
    );
  }

  const participantName = bookingRow.participants?.name ?? "참여자";
  const participantEmail = (bookingRow.participants?.email ?? "").trim();
  if (!participantEmail) {
    return NextResponse.json(
      { error: "참여자 이메일이 없어 발송할 수 없습니다" },
      { status: 400 },
    );
  }

  // Researcher envelope block — the experiment owner's profile. Falls back
  // to a null block when the experiment has no owner or no profile row.
  let researcher: RescheduleEmailResearcher | null = null;
  if (experimentRow.created_by) {
    const { data: profile } = await admin
      .from("profiles")
      .select("display_name, contact_email, email, phone")
      .eq("id", experimentRow.created_by)
      .maybeSingle();
    const profileRow = profile as unknown as {
      display_name: string | null;
      contact_email: string | null;
      email: string | null;
      phone: string | null;
    } | null;
    if (profileRow) {
      researcher = {
        display_name: profileRow.display_name,
        contact_email: profileRow.contact_email,
        email: profileRow.email,
        phone: profileRow.phone,
      };
    }
  }

  // Fresh token-gated self-edit URL. issueBookingEditToken returns
  // { token, ... }; the URL mirrors buildEditLink in booking.service.ts
  // (origin + /booking-edit/{token}).
  const origin = process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin;
  const { token } = issueBookingEditToken(bookingGroupId);
  const editUrl = `${origin}/booking-edit/${token}`;

  return {
    participant: { name: participantName, email: participantEmail },
    experimentTitle,
    researcher,
    editUrl,
  };
}

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ experimentId: string; bookingGroupId: string }> },
) {
  try {
    const { experimentId, bookingGroupId } = await ctx.params;
    const resolved = await resolveContext(request, experimentId, bookingGroupId);
    if (resolved instanceof NextResponse) return resolved;

    // Preview: no researcher note (message = null); read-only, no send.
    const built = buildRescheduleInviteEmail({
      participant: {
        name: resolved.participant.name,
        email: resolved.participant.email,
      },
      experiment: { title: resolved.experimentTitle },
      editUrl: resolved.editUrl,
      researcher: resolved.researcher,
      message: null,
    });

    const cc =
      resolved.researcher?.contact_email ??
      resolved.researcher?.email ??
      null;
    return NextResponse.json({
      preview: { to: built.to, cc, subject: built.subject, html: built.html },
      participant: { name: resolved.participant.name },
      editUrl: resolved.editUrl,
    });
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : "Failed to build preview";
    console.error(`[RescheduleInvite][GET] ${msg}`, err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

const sendBodySchema = z.object({
  // Optional researcher note surfaced in the email body ("담당 연구원 메모").
  message: z.string().max(1000).optional(),
  // Force flag — the frontend must explicitly opt in, guarding against an
  // accidental single-button auto-send.
  confirm: z.literal(true),
});

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ experimentId: string; bookingGroupId: string }> },
) {
  try {
    const { experimentId, bookingGroupId } = await ctx.params;
    const resolved = await resolveContext(request, experimentId, bookingGroupId);
    if (resolved instanceof NextResponse) return resolved;

    let body: z.infer<typeof sendBodySchema>;
    try {
      body = sendBodySchema.parse(await request.json());
    } catch (err) {
      const msg =
        err instanceof z.ZodError
          ? `Invalid request: ${err.issues[0]?.message ?? "validation failed"}`
          : "Invalid request body";
      console.warn(`[RescheduleInvite][POST] body parse: ${msg}`);
      return NextResponse.json({ error: msg }, { status: 400 });
    }

    // Rebuild with the researcher's note.
    const built = buildRescheduleInviteEmail({
      participant: {
        name: resolved.participant.name,
        email: resolved.participant.email,
      },
      experiment: { title: resolved.experimentTitle },
      editUrl: resolved.editUrl,
      researcher: resolved.researcher,
      message: body.message ?? null,
    });

    // CC + Reply-To the responsible researcher (담당 연구원): they get a copy
    // of every invite they send and a participant reply reaches them directly
    // rather than the lab-wide send inbox.
    const researcherEmail =
      resolved.researcher?.contact_email ??
      resolved.researcher?.email ??
      undefined;

    let result: Awaited<ReturnType<typeof sendEmail>>;
    try {
      result = await sendEmail({
        to: built.to,
        subject: built.subject,
        html: built.html,
        cc: researcherEmail,
        replyTo: researcherEmail,
      });
    } catch (err) {
      // sendEmail catches its own errors and returns { success:false }, but
      // a transport-init throw can still propagate.
      const msg = err instanceof Error ? err.message : "SMTP error";
      console.error(`[RescheduleInvite][POST] sendEmail throw: ${msg}`, err);
      return NextResponse.json(
        { error: `이메일 발송 실패: ${msg}` },
        { status: 502 },
      );
    }

    if (!result.success) {
      const msg = result.error ?? "unknown";
      console.error(`[RescheduleInvite][POST] sendEmail !ok: ${msg}`);
      return NextResponse.json(
        { error: `이메일 발송 실패: ${msg}` },
        { status: 502 },
      );
    }

    console.log(
      `[RescheduleInvite][POST] OK messageId=${result.messageId ?? "-"} to=${built.to}`,
    );
    return NextResponse.json({ ok: true, sentTo: built.to });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to send invite";
    console.error(`[RescheduleInvite][POST] ${msg}`, err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
