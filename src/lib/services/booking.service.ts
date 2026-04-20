import { createAdminClient } from "@/lib/supabase/admin";
import { createEvent, deleteEvent } from "@/lib/google/calendar";
import { invalidateCalendarCache } from "@/lib/google/freebusy-cache";
import { createBookingPage } from "@/lib/notion/client";
import { sendEmail } from "@/lib/google/gmail";
import { sendSMS } from "@/lib/solapi/client";
import { formatDateKR, formatTimeKR } from "@/lib/utils/date";
import { escapeHtml } from "@/lib/utils/validation";
import { fromInternalEmail } from "@/lib/auth/username";
import { BRAND_NAME, BRAND_CONTACT_EMAIL } from "@/lib/branding";

type IntegrationType = "gcal" | "notion" | "email" | "sms";

interface BookingRow {
  id: string;
  slot_start: string;
  slot_end: string;
  session_number: number;
  subject_number: number | null;
  google_event_id: string | null;
  notion_page_id: string | null;
  participants: {
    name: string;
    phone: string;
    email: string;
  };
  experiments: {
    title: string;
    project_name: string | null;
    participation_fee: number;
    google_calendar_id: string | null;
    created_by: string | null;
  };
}

interface CreatorProfile {
  email: string;
  display_name: string | null;
  phone: string | null;
}

type Supabase = ReturnType<typeof createAdminClient>;

export async function runPostBookingPipeline(params: {
  bookingIds: string[];
  bookingGroupId: string;
  participantId: string;
  experimentId: string;
}) {
  const supabase = createAdminClient();

  const { data: bookings } = await supabase
    .from("bookings")
    .select(
      "id, slot_start, slot_end, session_number, subject_number, google_event_id, notion_page_id, participants(name, phone, email), experiments(title, project_name, participation_fee, google_calendar_id, created_by)",
    )
    .in("id", params.bookingIds);

  if (!bookings || bookings.length === 0) return;
  const rows = bookings as unknown as BookingRow[];

  // Look up experiment creator once — we need their username (→ initial) and
  // contact info for calendar event metadata.
  let creator: CreatorProfile | null = null;
  const createdBy = rows[0].experiments.created_by;
  if (createdBy) {
    const { data } = await supabase
      .from("profiles")
      .select("email, display_name, phone")
      .eq("id", createdBy)
      .maybeSingle();
    creator = (data as CreatorProfile | null) ?? null;
  }

  await seedIntegrationRows(supabase, rows);

  const results = await Promise.allSettled([
    runGCal(supabase, rows, creator),
    runNotion(supabase, rows),
    runEmail(supabase, rows, creator),
    runSMS(supabase, rows),
  ]);

  results.forEach((result, index) => {
    if (result.status === "rejected") {
      const names = ["GCal", "Notion", "Email", "SMS"];
      console.error(`[PostBooking] ${names[index]} pipeline crashed:`, result.reason);
    }
  });
}

async function seedIntegrationRows(supabase: Supabase, rows: BookingRow[]) {
  const seed: Array<{ booking_id: string; integration_type: IntegrationType }> = [];
  for (const row of rows) {
    seed.push(
      { booking_id: row.id, integration_type: "gcal" },
      { booking_id: row.id, integration_type: "notion" },
      { booking_id: row.id, integration_type: "email" },
      { booking_id: row.id, integration_type: "sms" },
    );
  }
  await supabase
    .from("booking_integrations")
    .upsert(seed, { onConflict: "booking_id,integration_type", ignoreDuplicates: true });
}

async function markIntegration(
  supabase: Supabase,
  bookingId: string,
  type: IntegrationType,
  patch: {
    status: "completed" | "failed" | "skipped";
    external_id?: string;
    last_error?: string;
  },
) {
  const { data: existing } = await supabase
    .from("booking_integrations")
    .select("attempts")
    .eq("booking_id", bookingId)
    .eq("integration_type", type)
    .maybeSingle();

  await supabase
    .from("booking_integrations")
    .update({
      status: patch.status,
      attempts: (existing?.attempts ?? 0) + 1,
      external_id: patch.external_id ?? null,
      last_error: patch.last_error ?? null,
      processed_at: new Date().toISOString(),
    })
    .eq("booking_id", bookingId)
    .eq("integration_type", type);
}

// Derive the researcher's initial from their login username (the local part
// of the synthetic @lab.local email). Uppercased because calendar titles
// should read as SHORT caps tags. If no username can be extracted (legacy
// email), fall back to the first 2-3 chars of display_name.
function creatorInitial(creator: CreatorProfile | null): string {
  if (!creator) return "???";
  const username = fromInternalEmail(creator.email);
  if (username) return username.toUpperCase();
  const localPart = creator.email.split("@")[0];
  if (localPart) return localPart.toUpperCase().slice(0, 4);
  return (creator.display_name ?? "???").toUpperCase().slice(0, 4);
}

function calendarTitle(booking: BookingRow, creator: CreatorProfile | null): string {
  const initial = creatorInitial(creator);
  const project =
    booking.experiments.project_name?.trim() || booking.experiments.title;
  const sbj = booking.subject_number ?? 0;
  const day = booking.session_number ?? 1;
  return `[${initial}] ${project}/Sbj ${sbj}/Day ${day}`;
}

function formatKrPhone(raw: string): string {
  const d = raw.replace(/\D/g, "");
  if (d.length === 11) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  return raw;
}

function calendarDescription(booking: BookingRow): string {
  const p = booking.participants;
  return [
    `예약자: ${p.name}`,
    `이메일: ${p.email}`,
    `전화번호: ${formatKrPhone(p.phone)}`,
    `회차: ${booking.session_number}회차`,
  ].join("\n");
}

async function runGCal(
  supabase: Supabase,
  rows: BookingRow[],
  creator: CreatorProfile | null,
) {
  const calendarId = (
    rows[0].experiments.google_calendar_id || process.env.GOOGLE_CALENDAR_ID || ""
  ).trim() || null;
  if (!calendarId) {
    for (const b of rows) await markIntegration(supabase, b.id, "gcal", { status: "skipped" });
    return;
  }

  for (const booking of rows) {
    try {
      const eventId = await createEvent(calendarId, {
        summary: calendarTitle(booking, creator),
        description: calendarDescription(booking),
        start: new Date(booking.slot_start),
        end: new Date(booking.slot_end),
      });

      await supabase.from("bookings").update({ google_event_id: eventId }).eq("id", booking.id);
      await markIntegration(supabase, booking.id, "gcal", {
        status: "completed",
        external_id: eventId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[PostBooking] GCal failed for ${booking.id}:`, msg);
      await markIntegration(supabase, booking.id, "gcal", {
        status: "failed",
        last_error: msg.slice(0, 500),
      });
    }
  }

  // The calendar now has N new events — drop cached FreeBusy so the next
  // participant page load computes availability against the real state.
  await invalidateCalendarCache(calendarId).catch(() => {});
}

async function runNotion(supabase: Supabase, rows: BookingRow[]) {
  if (!process.env.NOTION_API_KEY || !process.env.NOTION_DATABASE_ID) {
    for (const b of rows) await markIntegration(supabase, b.id, "notion", { status: "skipped" });
    return;
  }

  for (const booking of rows) {
    try {
      const pageId = await createBookingPage({
        experimentTitle: booking.experiments.title,
        participantName: booking.participants.name,
        phone: booking.participants.phone,
        email: booking.participants.email,
        sessionDate: booking.slot_start,
        sessionTime: `${formatTimeKR(booking.slot_start)} - ${formatTimeKR(booking.slot_end)}`,
        status: "확정",
        fee: booking.experiments.participation_fee,
      });
      await supabase.from("bookings").update({ notion_page_id: pageId }).eq("id", booking.id);
      await markIntegration(supabase, booking.id, "notion", {
        status: "completed",
        external_id: pageId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[PostBooking] Notion failed for ${booking.id}:`, msg);
      await markIntegration(supabase, booking.id, "notion", {
        status: "failed",
        last_error: msg.slice(0, 500),
      });
    }
  }
}

interface CreatorContact extends CreatorProfile {
  contact_email?: string | null;
}

async function runEmail(
  supabase: Supabase,
  rows: BookingRow[],
  creator: CreatorProfile | null,
) {
  const participant = rows[0].participants;
  const experiment = rows[0].experiments;

  const safeName = escapeHtml(participant.name);
  const safeTitle = escapeHtml(experiment.title);
  const slotList = rows
    .map(
      (b) =>
        `<li>${formatDateKR(b.slot_start)} ${formatTimeKR(b.slot_start)} - ${formatTimeKR(b.slot_end)}</li>`,
    )
    .join("");

  // Researcher contact (used for both footer display and email CC)
  const creatorContact = creator as CreatorContact | null;
  const researcherEmail =
    (creatorContact?.contact_email || creator?.email || "").trim() || null;
  const contactLine = researcherEmail || BRAND_CONTACT_EMAIL;

  const html = `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
      <h2>[${BRAND_NAME}] 실험 예약 확정</h2>
      <p>${safeName}님, 아래 실험 예약이 확정되었습니다.</p>
      <table style="border-collapse: collapse; width: 100%; margin: 16px 0;">
        <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">실험명</td><td style="padding: 8px; border: 1px solid #ddd;">${safeTitle}</td></tr>
        <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">참여비</td><td style="padding: 8px; border: 1px solid #ddd;">${experiment.participation_fee.toLocaleString()}원</td></tr>
      </table>
      <p><strong>예약 시간:</strong></p>
      <ul>${slotList}</ul>
      <p>문의: ${contactLine}</p>
    </div>
  `;

  const ccList =
    researcherEmail && researcherEmail !== participant.email ? [researcherEmail] : undefined;

  const result = await sendEmail({
    to: participant.email,
    cc: ccList,
    subject: `[${BRAND_NAME}] 실험 예약 확정 - ${experiment.title}`,
    html,
  });

  for (const booking of rows) {
    if (result.success) {
      await markIntegration(supabase, booking.id, "email", {
        status: "completed",
        external_id: result.messageId,
      });
    } else {
      await markIntegration(supabase, booking.id, "email", {
        status: "failed",
        last_error: (result.error ?? "unknown").slice(0, 500),
      });
    }
  }
}

async function runSMS(supabase: Supabase, rows: BookingRow[]) {
  if (!process.env.SOLAPI_API_KEY || !process.env.SOLAPI_API_SECRET) {
    for (const b of rows) await markIntegration(supabase, b.id, "sms", { status: "skipped" });
    return;
  }

  const participant = rows[0].participants;
  const experiment = rows[0].experiments;
  const firstSlot = rows[0];
  const text = `[${BRAND_NAME}] 예약확정\n${participant.name}님, "${experiment.title}" 실험이 예약되었습니다.\n일시: ${formatDateKR(firstSlot.slot_start)} ${formatTimeKR(firstSlot.slot_start)}\n문의: ${BRAND_CONTACT_EMAIL}`;

  try {
    await sendSMS(participant.phone, text);
    for (const b of rows) {
      await markIntegration(supabase, b.id, "sms", { status: "completed" });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    for (const b of rows) {
      await markIntegration(supabase, b.id, "sms", {
        status: "failed",
        last_error: msg.slice(0, 500),
      });
    }
  }
}

// ── Reschedule pipeline ────────────────────────────────────────────────────
// Called by PATCH /api/bookings/[id] after the booking row's slot_start/end
// have been updated. We delete the old GCal event, create a new one with the
// updated time, email/SMS the participant about the change.

interface ReschedulePipelineParams {
  bookingId: string;
  oldSlotStart: string;
  oldSlotEnd: string;
  oldEventId: string | null;
}

export async function runReschedulePipeline(params: ReschedulePipelineParams) {
  const supabase = createAdminClient();

  const { data: fresh } = await supabase
    .from("bookings")
    .select(
      "id, slot_start, slot_end, session_number, subject_number, google_event_id, notion_page_id, participants(name, phone, email), experiments(title, project_name, participation_fee, google_calendar_id, created_by)",
    )
    .eq("id", params.bookingId)
    .single();
  if (!fresh) return;

  const row = fresh as unknown as BookingRow;

  // Look up experiment creator for initial
  let creator: CreatorProfile | null = null;
  if (row.experiments.created_by) {
    const { data } = await supabase
      .from("profiles")
      .select("email, display_name, phone")
      .eq("id", row.experiments.created_by)
      .maybeSingle();
    creator = (data as CreatorProfile | null) ?? null;
  }

  const calendarId = (
    row.experiments.google_calendar_id || process.env.GOOGLE_CALENDAR_ID || ""
  ).trim() || null;

  // Delete old GCal event (if any)
  if (calendarId && params.oldEventId) {
    try {
      await deleteEvent(calendarId, params.oldEventId);
    } catch (err) {
      console.error("[Reschedule] deleteEvent failed:", err instanceof Error ? err.message : err);
    }
  }

  // Create new GCal event with updated time + correct title
  let newEventId: string | null = null;
  if (calendarId) {
    try {
      newEventId = await createEvent(calendarId, {
        summary: calendarTitle(row, creator),
        description: calendarDescription(row),
        start: new Date(row.slot_start),
        end: new Date(row.slot_end),
      });
      await supabase
        .from("bookings")
        .update({ google_event_id: newEventId })
        .eq("id", row.id);
      await markIntegration(supabase, row.id, "gcal", {
        status: "completed",
        external_id: newEventId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await markIntegration(supabase, row.id, "gcal", {
        status: "failed",
        last_error: msg.slice(0, 500),
      });
    }
    await invalidateCalendarCache(calendarId).catch(() => {});
  }

  // Notify participant — email + SMS
  const participant = row.participants;
  const experiment = row.experiments;
  const safeName = escapeHtml(participant.name);
  const safeTitle = escapeHtml(experiment.title);
  const oldLine = `${formatDateKR(params.oldSlotStart)} ${formatTimeKR(params.oldSlotStart)} - ${formatTimeKR(params.oldSlotEnd)}`;
  const newLine = `${formatDateKR(row.slot_start)} ${formatTimeKR(row.slot_start)} - ${formatTimeKR(row.slot_end)}`;

  const html = `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
      <h2>[${BRAND_NAME}] 실험 예약 변경 안내</h2>
      <p>${safeName}님, 실험 예약 시간이 변경되었습니다.</p>
      <table style="border-collapse: collapse; width: 100%; margin: 16px 0;">
        <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">실험명</td><td style="padding: 8px; border: 1px solid #ddd;">${safeTitle}</td></tr>
        <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">회차</td><td style="padding: 8px; border: 1px solid #ddd;">${row.session_number}회차</td></tr>
        <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">이전 일정</td><td style="padding: 8px; border: 1px solid #ddd; color:#888; text-decoration:line-through">${escapeHtml(oldLine)}</td></tr>
        <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold; background:#fef3c7;">변경된 일정</td><td style="padding: 8px; border: 1px solid #ddd; background:#fef3c7;"><b>${escapeHtml(newLine)}</b></td></tr>
      </table>
      <p>문의: ${BRAND_CONTACT_EMAIL}</p>
    </div>
  `;
  const emailResult = await sendEmail(
    participant.email,
    `[${BRAND_NAME}] 실험 예약 변경 - ${experiment.title}`,
    html,
  );
  await markIntegration(supabase, row.id, "email", {
    status: emailResult.success ? "completed" : "failed",
    external_id: emailResult.messageId,
    last_error: emailResult.error?.slice(0, 500),
  });

  if (process.env.SOLAPI_API_KEY && process.env.SOLAPI_API_SECRET) {
    const smsText = `[${BRAND_NAME}] 예약 변경\n${participant.name}님, "${experiment.title}" 실험 ${row.session_number}회차 일정이 변경되었습니다.\n변경: ${newLine}\n문의: ${BRAND_CONTACT_EMAIL}`;
    try {
      await sendSMS(participant.phone, smsText);
      await markIntegration(supabase, row.id, "sms", { status: "completed" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await markIntegration(supabase, row.id, "sms", {
        status: "failed",
        last_error: msg.slice(0, 500),
      });
    }
  }
}
