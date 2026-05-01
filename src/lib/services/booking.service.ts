import { createAdminClient } from "@/lib/supabase/admin";
import { createEvent, deleteEvent } from "@/lib/google/calendar";
import { invalidateCalendarCache } from "@/lib/google/freebusy-cache";
import { createBookingPage } from "@/lib/notion/client";
import { sendEmail } from "@/lib/google/gmail";
import { sendSMS } from "@/lib/solapi/client";
import { formatDateKR, formatTimeKR } from "@/lib/utils/date";
import { fromInternalEmail } from "@/lib/auth/username";
import { BRAND_NAME, brandContactEmailOrNull } from "@/lib/branding";
import { issueRunToken } from "@/lib/experiments/run-token";
import { issuePaymentToken } from "@/lib/payments/token";
import { encryptToken } from "@/lib/crypto/payment-info";
import { backfillIdentityForBooking } from "@/lib/services/participant-identity.service";
import { buildConfirmationEmail } from "@/lib/services/booking-email-template";
import {
  buildRescheduleEmail,
  buildRescheduleSMS,
} from "@/lib/services/booking-reschedule-email";
import type { ExperimentMode, OnlineRuntimeConfig } from "@/types/database";

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
    experiment_mode: ExperimentMode;
    online_runtime_config: OnlineRuntimeConfig | null;
  };
}

// Used by the confirmation email to include a per-booking run link when
// the experiment has an online component.
interface RunLink {
  bookingId: string;
  token: string;
  url: string;
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
      "id, slot_start, slot_end, session_number, subject_number, google_event_id, notion_page_id, participants(name, phone, email), experiments(title, project_name, participation_fee, google_calendar_id, created_by, precautions, location_id, experiment_mode, online_runtime_config)",
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

  // Ensure per-(participant, lab) public_code exists before downstream
  // integrations (Stream C's Notion survey mirror reads it). Non-blocking:
  // log and continue on failure so GCal/email/SMS still fire.
  try {
    await backfillIdentityForBooking(rows[0].id);
  } catch (err) {
    console.error(
      "[PostBooking] participant identity backfill failed:",
      err instanceof Error ? err.message : err,
    );
  }

  await seedIntegrationRows(supabase, rows);

  // For online/hybrid experiments issue a run token per booking and seed
  // the experiment_run_progress row. The confirmation email then includes
  // a /run link. Offline experiments skip this entirely.
  const runLinks = await seedRunTokens(supabase, rows);

  // Seed participant_payment_info (one row per booking group). The token
  // goes in the confirmation email so the participant can come back
  // post-experiment to fill in RRN / bank / signature without needing to
  // log in. See src/lib/payments/token.ts for the scheme.
  const paymentLink = await seedPaymentInfo(supabase, rows, params);

  const results = await Promise.allSettled([
    runGCal(supabase, rows, creator),
    runNotion(supabase, rows),
    runEmail(supabase, rows, creator, runLinks, paymentLink),
    runSMS(supabase, rows),
  ]);

  results.forEach((result, index) => {
    if (result.status === "rejected") {
      const names = ["GCal", "Notion", "Email", "SMS"];
      console.error(`[PostBooking] ${names[index]} pipeline crashed:`, result.reason);
    }
  });
}

async function seedRunTokens(supabase: Supabase, rows: BookingRow[]): Promise<RunLink[]> {
  const mode = rows[0]?.experiments.experiment_mode ?? "offline";
  if (mode === "offline") return [];
  // Absolute origin for the email link. Prefer explicit NEXT_PUBLIC_APP_URL;
  // fall back to Vercel's deploy URL. Relative ("/run/...") would still work
  // in-app but email clients require absolute URLs.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  const vercelUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`.replace(/\/$/, "")
    : "";
  const origin = appUrl || vercelUrl || "";

  const links: RunLink[] = [];
  for (const row of rows) {
    try {
      const issued = issueRunToken(row.id);
      const { error } = await supabase
        .from("experiment_run_progress")
        .upsert(
          {
            booking_id: row.id,
            token_hash: issued.hash,
            token_issued_at: new Date(issued.issuedAt).toISOString(),
          },
          { onConflict: "booking_id" },
        );
      if (error) {
        console.error(`[PostBooking] run progress seed failed for ${row.id}:`, error.message);
        continue;
      }
      const url = origin
        ? `${origin}/run/${row.id}?t=${encodeURIComponent(issued.token)}`
        : `/run/${row.id}?t=${encodeURIComponent(issued.token)}`;
      links.push({ bookingId: row.id, token: issued.token, url });
    } catch (err) {
      console.error(
        `[PostBooking] issueRunToken failed for ${row.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return links;
}

interface PaymentLink {
  url: string;
  earliestFillableAt: string; // ISO; MAX(slot_end) across the group
}

async function seedPaymentInfo(
  supabase: Supabase,
  rows: BookingRow[],
  params: { bookingGroupId: string; participantId: string; experimentId: string },
): Promise<PaymentLink | null> {
  // Only seed if the experiment actually pays participants. participation_fee
  // is on every row (same experiment), so read the first one.
  const fee = rows[0]?.experiments.participation_fee ?? 0;
  if (fee <= 0) return null;

  try {
    const issued = issuePaymentToken(params.bookingGroupId);
    // Encrypt the token plaintext at rest (P0 #6, migration 00052). Lets
    // payment-info-notify.service re-send the SAME URL when the
    // participant has already opened the link, instead of rotating the
    // hash and breaking their bookmark/open-tab.
    const encToken = encryptToken(issued.token);
    const toHex = (b: Buffer) => `\\x${b.toString("hex")}`;

    const starts = rows.map((r) => new Date(r.slot_start));
    const ends = rows.map((r) => new Date(r.slot_end));
    const periodStart = new Date(Math.min(...starts.map((d) => d.getTime())));
    const periodEnd = new Date(Math.max(...ends.map((d) => d.getTime())));
    // Format in Asia/Seoul — sessions ending before 09:00 KST would
    // otherwise record the prior UTC date. en-CA locale gives YYYY-MM-DD.
    const kstDate = (d: Date): string =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Seoul",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(d);
    const amountKrw = fee * rows.length;

    const { error } = await supabase.from("participant_payment_info").upsert(
      {
        participant_id: params.participantId,
        experiment_id: params.experimentId,
        booking_group_id: params.bookingGroupId,
        token_hash: issued.hash,
        token_cipher: toHex(encToken.cipher),
        token_iv: toHex(encToken.iv),
        token_tag: toHex(encToken.tag),
        token_key_version: encToken.keyVersion,
        token_issued_at: new Date(issued.issuedAt).toISOString(),
        token_expires_at: new Date(issued.expiresAt).toISOString(),
        period_start: kstDate(periodStart),
        period_end: kstDate(periodEnd),
        amount_krw: amountKrw,
        status: "pending_participant",
      },
      { onConflict: "booking_group_id" },
    );
    if (error) {
      console.error("[PostBooking] payment info seed failed:", error.message);
      return null;
    }

    const origin =
      process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ||
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}`.replace(/\/$/, "") : "");
    const path = `/payment-info/${encodeURIComponent(issued.token)}`;
    return {
      url: origin ? `${origin}${path}` : path,
      earliestFillableAt: periodEnd.toISOString(),
    };
  } catch (err) {
    console.error(
      "[PostBooking] seedPaymentInfo crashed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
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
        // Deterministic id so outbox retry after a lost response doesn't
        // create a duplicate event on the shared calendar.
        idempotencyKey: booking.id,
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

  // Look up the participant's lab-scoped public code once per pipeline
  // invocation. All rows here share the same participant + experiment (and
  // therefore the same lab), so we key off the first row. If Stream B's
  // ensureParticipantLabIdentity hasn't run for this (participant, lab)
  // yet, publicCode stays null and the Notion 공개 ID column is written
  // blank — researchers can re-sync via the retry path without blocking
  // the booking.
  let publicCode: string | null = null;
  // Migration 00043 — Notion Relations to Members / Projects. Both are
  // optional; unset → relation cell stays empty.
  let researcherMemberPageId: string | null = null;
  let projectPageId: string | null = null;
  const firstBookingId = rows[0]?.id;
  if (firstBookingId) {
    const { data: bookingMeta } = await supabase
      .from("bookings")
      .select(
        "participant_id, experiments(lab_id, notion_project_page_id, created_by)",
      )
      .eq("id", firstBookingId)
      .maybeSingle();
    const meta = bookingMeta as unknown as
      | {
          participant_id: string;
          experiments: {
            lab_id: string;
            notion_project_page_id: string | null;
            created_by: string | null;
          } | null;
        }
      | null;
    if (meta?.participant_id && meta.experiments?.lab_id) {
      const { data: identity } = await supabase
        .from("participant_lab_identity")
        .select("public_code")
        .eq("participant_id", meta.participant_id)
        .eq("lab_id", meta.experiments.lab_id)
        .maybeSingle();
      publicCode = identity?.public_code ?? null;
    }
    projectPageId = meta?.experiments?.notion_project_page_id ?? null;
    if (meta?.experiments?.created_by) {
      const { data: prof } = await supabase
        .from("profiles")
        .select("notion_member_page_id")
        .eq("id", meta.experiments.created_by)
        .maybeSingle();
      researcherMemberPageId =
        (prof as { notion_member_page_id?: string | null } | null)
          ?.notion_member_page_id ?? null;
    }
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
        publicCode,
        researcherMemberPageId,
        projectPageId,
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
  runLinks: RunLink[] = [],
  paymentLink: PaymentLink | null = null,
) {
  const experiment = rows[0].experiments;

  // Look up location (address + naver_url) for the "찾아오시는 길" block.
  let location: { name: string; address_lines: string[]; naver_url: string | null } | null = null;
  if (experiment.location_id) {
    const { data } = await supabase
      .from("experiment_locations")
      .select("name, address_lines, naver_url")
      .eq("id", experiment.location_id)
      .maybeSingle();
    location =
      (data as unknown as { name: string; address_lines: string[]; naver_url: string | null } | null) ?? null;
  }

  const built = buildConfirmationEmail({
    participant: rows[0].participants,
    experiment: {
      title: experiment.title,
      participation_fee: experiment.participation_fee,
      experiment_mode: experiment.experiment_mode,
      precautions: experiment.precautions,
    },
    rows: rows.map((r) => ({
      id: r.id,
      slot_start: r.slot_start,
      slot_end: r.slot_end,
      session_number: r.session_number,
    })),
    creator: creator && {
      email: creator.email,
      display_name: creator.display_name,
      phone: creator.phone,
      contact_email: (creator as CreatorContact | null)?.contact_email ?? null,
    },
    location,
    runLinks: runLinks.map((l) => ({ bookingId: l.bookingId, url: l.url })),
    paymentLink: paymentLink ? { url: paymentLink.url } : null,
  });

  const result = await sendEmail({
    to: built.to,
    cc: built.cc,
    subject: built.subject,
    html: built.html,
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
  const labContact = brandContactEmailOrNull();
  const inquirySuffix = labContact ? `\n문의: ${labContact}` : "";
  const text = `[${BRAND_NAME}] 예약확정\n${participant.name}님, "${experiment.title}" 실험이 예약되었습니다.\n일시: ${formatDateKR(firstSlot.slot_start)} ${formatTimeKR(firstSlot.slot_start)}${inquirySuffix}`;

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
  /**
   * If the caller pre-created the new GCal event synchronously (to make the
   * reschedule atomic with the DB update), pass the new event id here. The
   * pipeline will skip the GCal create step and only delete the old event.
   * If null, the pipeline creates the new event itself (legacy best-effort
   * path; drift window exists between DB update and new event creation).
   */
  newEventId?: string | null;
}

/**
 * Pre-create the new GCal event for a reschedule BEFORE the DB slot is
 * updated. On success returns the new event id (caller should store it
 * with the slot update in one DB write). On failure throws — caller
 * should abort the reschedule so the DB and calendar stay in sync.
 *
 * Idempotency caveat: if the DB update fails after this returns, the
 * orphan event stays on the calendar. A spare event is preferable to a
 * missing one; the weekly outbox sweep doesn't clean these up yet.
 */
export async function createReschedGCalEvent(
  bookingId: string,
  newSlotStart: string,
  newSlotEnd: string,
): Promise<{ eventId: string | null; usedCalendar: boolean }> {
  const supabase = createAdminClient();
  const { data: fresh } = await supabase
    .from("bookings")
    .select(
      "id, slot_start, slot_end, session_number, subject_number, google_event_id, notion_page_id, participants(name, phone, email), experiments(title, project_name, participation_fee, google_calendar_id, created_by, precautions, location_id, experiment_mode, online_runtime_config)",
    )
    .eq("id", bookingId)
    .single();
  if (!fresh) return { eventId: null, usedCalendar: false };

  const baseRow = fresh as unknown as BookingRow;
  // Use the NEW slot values for title/description — the row in DB still
  // has the old slot at this point.
  const row: BookingRow = {
    ...baseRow,
    slot_start: newSlotStart,
    slot_end: newSlotEnd,
  };

  const calendarId = (
    row.experiments.google_calendar_id || process.env.GOOGLE_CALENDAR_ID || ""
  ).trim() || null;
  if (!calendarId) return { eventId: null, usedCalendar: false };

  let creator: CreatorProfile | null = null;
  if (row.experiments.created_by) {
    const { data } = await supabase
      .from("profiles")
      .select("email, display_name, phone, contact_email")
      .eq("id", row.experiments.created_by)
      .maybeSingle();
    creator = (data as CreatorProfile | null) ?? null;
  }

  const eventId = await createEvent(calendarId, {
    summary: calendarTitle(row, creator),
    description: calendarDescription(row),
    start: new Date(newSlotStart),
    end: new Date(newSlotEnd),
  });
  return { eventId, usedCalendar: true };
}

export async function runReschedulePipeline(params: ReschedulePipelineParams) {
  const supabase = createAdminClient();

  const { data: fresh } = await supabase
    .from("bookings")
    .select(
      "id, slot_start, slot_end, session_number, subject_number, google_event_id, notion_page_id, participants(name, phone, email), experiments(title, project_name, participation_fee, google_calendar_id, created_by, precautions, location_id, experiment_mode, online_runtime_config)",
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

  // Delete old GCal event (if any). Best-effort: if the PATCH handler
  // pre-created the new event, the old one is an orphan we want gone,
  // but the reschedule is already "correct" from the participant's POV.
  if (calendarId && params.oldEventId) {
    try {
      await deleteEvent(calendarId, params.oldEventId);
    } catch (err) {
      console.error("[Reschedule] deleteEvent failed:", err instanceof Error ? err.message : err);
    }
  }

  // If caller pre-created the new event (atomic path), just stamp the
  // integration row and move on.
  if (params.newEventId) {
    await markIntegration(supabase, row.id, "gcal", {
      status: "completed",
      external_id: params.newEventId,
    });
    if (calendarId) await invalidateCalendarCache(calendarId).catch(() => {});
  } else if (calendarId) {
    // Legacy best-effort path: drift window exists (DB already updated).
    try {
      const newEventId = await createEvent(calendarId, {
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

  // Notify participant — email + SMS. Template lives in
  // booking-reschedule-email.ts so the structure (header box, location
  // block, sibling-session block, researcher block, footer watermark)
  // matches the other participant emails for inbox consistency.
  const participant = row.participants;
  const experiment = row.experiments;

  const creatorContact = creator as CreatorContact | null;
  const researcherEmail =
    (creatorContact?.contact_email || creator?.email || "").trim() || null;

  // Pull location for offline experiments (template hides the block for
  // online). Best-effort: a missing row falls through to no location.
  let location: { name: string; address_lines: string[]; naver_url: string | null } | null = null;
  if (experiment.experiment_mode !== "online" && experiment.location_id) {
    const { data: loc } = await supabase
      .from("experiment_locations")
      .select("name, address_lines, naver_url")
      .eq("id", experiment.location_id)
      .maybeSingle();
    location = (loc as { name: string; address_lines: string[]; naver_url: string | null } | null) ?? null;
  }

  // Sibling sessions in this booking_group, still confirmed. Lets the
  // template say "이번 회차에만 적용됩니다" + list the others.
  let otherActiveSessions: Array<{ slot_start: string; session_number: number }> = [];
  const groupId = (row as unknown as { booking_group_id: string | null }).booking_group_id;
  if (groupId) {
    const { data: siblings } = await supabase
      .from("bookings")
      .select("id, slot_start, session_number, status")
      .eq("booking_group_id", groupId)
      .neq("id", row.id);
    otherActiveSessions = (siblings ?? [])
      .filter((s) => (s as { status: string }).status === "confirmed")
      .map((s) => {
        const r = s as { slot_start: string; session_number: number };
        return { slot_start: r.slot_start, session_number: r.session_number };
      })
      .sort(
        (a, b) => new Date(a.slot_start).getTime() - new Date(b.slot_start).getTime(),
      );
  }

  const built = buildRescheduleEmail({
    participant: { name: participant.name, email: participant.email },
    experiment: {
      title: experiment.title,
      experiment_mode: experiment.experiment_mode,
    },
    booking: {
      id: row.id,
      session_number: row.session_number,
      slot_start: row.slot_start,
      slot_end: row.slot_end,
    },
    oldSlotStart: params.oldSlotStart,
    oldSlotEnd: params.oldSlotEnd,
    location,
    researcher: {
      display_name: creator?.display_name ?? null,
      contact_email: creatorContact?.contact_email ?? null,
      email: creator?.email ?? null,
      phone: creator?.phone ?? null,
    },
    otherActiveSessions,
  });

  const ccList =
    researcherEmail && researcherEmail !== participant.email ? [researcherEmail] : undefined;
  const emailResult = await sendEmail({
    to: built.to,
    cc: ccList,
    subject: built.subject,
    html: built.html,
  });
  await markIntegration(supabase, row.id, "email", {
    status: emailResult.success ? "completed" : "failed",
    external_id: emailResult.messageId,
    last_error: emailResult.error?.slice(0, 500),
  });

  if (process.env.SOLAPI_API_KEY && process.env.SOLAPI_API_SECRET) {
    const smsText = buildRescheduleSMS({
      participant: { name: participant.name, email: participant.email },
      experiment: {
        title: experiment.title,
        experiment_mode: experiment.experiment_mode,
      },
      booking: {
        id: row.id,
        session_number: row.session_number,
        slot_start: row.slot_start,
        slot_end: row.slot_end,
      },
      oldSlotStart: params.oldSlotStart,
      oldSlotEnd: params.oldSlotEnd,
      location,
      researcher: {
        display_name: creator?.display_name ?? null,
        contact_email: creatorContact?.contact_email ?? null,
        email: creator?.email ?? null,
        phone: creator?.phone ?? null,
      },
      otherActiveSessions,
    });
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
