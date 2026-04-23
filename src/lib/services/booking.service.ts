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
    precautions: Array<{ question: string; required_answer: boolean }> | null;
    location_id: string | null;
  };
}

interface CreatorProfile {
  email: string;
  display_name: string | null;
  phone: string | null;
  contact_email: string | null;
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
      "id, slot_start, slot_end, session_number, subject_number, google_event_id, notion_page_id, participants(name, phone, email), experiments(title, project_name, participation_fee, google_calendar_id, created_by, precautions, location_id)",
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
      .select("email, display_name, phone, contact_email")
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
        projectName: booking.experiments.project_name ?? null,
        subjectNumber: booking.subject_number ?? null,
        sessionNumber: booking.session_number ?? 1,
        sessionDateIso: booking.slot_start,
        slotStartIso: booking.slot_start,
        slotEndIso: booking.slot_end,
        participantName: booking.participants.name,
        phone: booking.participants.phone,
        email: booking.participants.email,
        status: "확정",
        fee: booking.experiments.participation_fee,
        researcherName: null,
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

// CreatorProfile already carries contact_email; kept alias for legacy call sites.
type CreatorContact = CreatorProfile;

async function runEmail(
  supabase: Supabase,
  rows: BookingRow[],
  creator: CreatorProfile | null,
) {
  const participant = rows[0].participants;
  const experiment = rows[0].experiments;

  const safeName = escapeHtml(participant.name);
  const safeTitle = escapeHtml(experiment.title);

  // Look up location (address + naver_url) so the email can include "찾아오시는 길"
  interface LocRow {
    name: string;
    address_lines: string[];
    naver_url: string | null;
  }
  let location: LocRow | null = null;
  if (experiment.location_id) {
    const { data } = await supabase
      .from("experiment_locations")
      .select("name, address_lines, naver_url")
      .eq("id", experiment.location_id)
      .maybeSingle();
    location = (data as unknown as LocRow | null) ?? null;
  }

  const slotList = rows
    .map(
      (b) =>
        `<li style="margin:4px 0;">${formatDateKR(b.slot_start)} · ${formatTimeKR(b.slot_start)} – ${formatTimeKR(b.slot_end)}${rows.length > 1 ? ` <span style="color:#6b7280;">(${b.session_number}회차)</span>` : ""}</li>`,
    )
    .join("");

  // Researcher contact (used for both footer display and email CC).
  // Priority: contact_email (explicitly-provided public address) → login email.
  const creatorContact = creator as CreatorContact | null;
  const researcherEmail =
    (creatorContact?.contact_email || creator?.email || "").trim() || null;
  const researcherName = (creator?.display_name ?? "").trim() || "담당 연구원";
  const researcherPhone = (creator?.phone ?? "").trim();
  const contactLine = researcherEmail || BRAND_CONTACT_EMAIL;

  const precautionsBlock =
    experiment.precautions && experiment.precautions.length > 0
      ? `
      <div style="margin:20px 0;padding:14px 16px;background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;">
        <p style="margin:0 0 8px 0;font-weight:600;color:#92400e;">예약 시 확인하신 참여 주의사항</p>
        <ul style="margin:0;padding-left:18px;color:#78350f;">
          ${experiment.precautions
            .map(
              (p) =>
                `<li style="margin:3px 0;">${escapeHtml(p.question)}</li>`,
            )
            .join("")}
        </ul>
        <p style="margin:10px 0 0 0;font-size:12px;color:#92400e;">
          위 항목에 모두 "예"로 응답해 주셔서 감사합니다. 실험 당일까지 조건이 변경되면 미리 담당자에게 알려주세요.
        </p>
      </div>`
      : "";

  const locationBlock = location
    ? `
      <p style="margin:18px 0 6px 0;font-weight:600;">찾아오시는 길</p>
      <p style="margin:0;line-height:1.55;">
        ${escapeHtml(location.name)}<br/>
        ${location.address_lines.map((l) => escapeHtml(l)).join("<br/>")}
      </p>
      ${
        location.naver_url
          ? `<p style="margin:8px 0 0 0;"><a href="${location.naver_url}" style="color:#2563eb;">네이버 지도에서 열기 →</a></p>`
          : ""
      }`
    : "";

  const feeLine =
    experiment.participation_fee > 0
      ? `<tr><td style="padding:10px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600;width:110px;">참여비</td><td style="padding:10px 12px;border:1px solid #e5e7eb;">${experiment.participation_fee.toLocaleString()}원 (실험 당일 지급)</td></tr>`
      : "";

  const contactBlock = `
      <p style="margin:20px 0 6px 0;font-weight:600;">담당 연구원 · 문의</p>
      <p style="margin:0;line-height:1.6;">
        ${escapeHtml(researcherName)}${
          researcherPhone ? ` · ${escapeHtml(researcherPhone)}` : ""
        }<br/>
        <a href="mailto:${contactLine}" style="color:#2563eb;">${escapeHtml(contactLine)}</a>
      </p>`;

  const html = `
    <div style="font-family:-apple-system,'Segoe UI',sans-serif;max-width:620px;margin:0 auto;padding:8px;color:#111827;line-height:1.55;">
      <div style="padding:14px 18px;background:#ecfdf5;border:1px solid #6ee7b7;border-radius:10px;margin-bottom:18px;">
        <p style="margin:0;font-size:15px;font-weight:600;color:#065f46;">✓ 실험 예약이 확정되었습니다</p>
      </div>

      <p style="margin:0 0 6px 0;">안녕하세요, ${safeName}님.</p>
      <p style="margin:0 0 14px 0;">
        <b>${safeTitle}</b> 실험에 참여 신청해 주셔서 진심으로 감사드립니다. 아래 일정으로 예약이 확정되었습니다.
      </p>

      <table style="border-collapse:collapse;width:100%;margin:14px 0;font-size:14px;">
        <tr><td style="padding:10px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600;width:110px;">실험명</td><td style="padding:10px 12px;border:1px solid #e5e7eb;">${safeTitle}</td></tr>
        ${feeLine}
      </table>

      <p style="margin:18px 0 6px 0;font-weight:600;">예약하신 시간</p>
      <ul style="margin:0;padding-left:20px;">${slotList}</ul>

      ${locationBlock}
      ${precautionsBlock}
      ${contactBlock}

      <p style="margin:22px 0 6px 0;font-size:13px;color:#6b7280;">
        일정 변경이 필요하시면 실험 시작 24시간 전까지 담당 연구원에게 알려주세요. 실험 전날과 당일에 리마인더 메일이 한 번 더 발송됩니다.
      </p>
      <p style="margin:4px 0 0 0;font-size:12px;color:#9ca3af;">
        ${BRAND_NAME} — 본 메일은 예약 신청 확인용입니다.
      </p>
    </div>
  `;

  const ccList =
    researcherEmail && researcherEmail !== participant.email ? [researcherEmail] : undefined;

  const result = await sendEmail({
    to: participant.email,
    cc: ccList,
    subject: `[${BRAND_NAME}] 실험 예약 확정 — ${experiment.title}`,
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
      "id, slot_start, slot_end, session_number, subject_number, google_event_id, notion_page_id, participants(name, phone, email), experiments(title, project_name, participation_fee, google_calendar_id, created_by, precautions, location_id)",
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
      .select("email, display_name, phone, contact_email")
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

  const creatorContact = creator as CreatorContact | null;
  const researcherEmail =
    (creatorContact?.contact_email || creator?.email || "").trim() || null;
  const contactLine = researcherEmail || BRAND_CONTACT_EMAIL;

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
      <p>문의: ${contactLine}</p>
    </div>
  `;
  const ccList =
    researcherEmail && researcherEmail !== participant.email ? [researcherEmail] : undefined;
  const emailResult = await sendEmail({
    to: participant.email,
    cc: ccList,
    subject: `[${BRAND_NAME}] 실험 예약 변경 - ${experiment.title}`,
    html,
  });
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
