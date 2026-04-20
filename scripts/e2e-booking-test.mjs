#!/usr/bin/env node
// End-to-end booking cycle test. Runs against local dev server + Supabase.
// Evidence is written to /tmp/e2e-booking-evidence.json for the reviewer team.

import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dirname, "..", ".env.local");

async function loadEnv() {
  const text = await readFile(ENV_PATH, "utf8").catch(() => "");
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    if (!process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
}

const APP = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
const ev = {
  startedAt: new Date().toISOString(),
  phases: [],
  summary: { passed: 0, failed: 0 },
};

function phase(name, ok, details) {
  ev.phases.push({ name, ok, details });
  ev.summary[ok ? "passed" : "failed"] += 1;
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) console.log("    ↳", JSON.stringify(details).slice(0, 200));
}

async function main() {
  await loadEnv();
  console.log("=".repeat(60));
  console.log("E2E Booking Cycle Test");
  console.log("=".repeat(60));

  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  );

  // --- Phase 1: fresh experiment ---
  // Use KST wall-clock date so slot generation aligns with Asia/Seoul boundaries.
  const kstToday = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const startDateStr = kstToday;
  const endDateStr = new Date(new Date(`${kstToday}T00:00:00Z`).getTime() + 7 * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const { data: csnl } = await admin
    .from("profiles")
    .select("id")
    .eq("email", "csnl@lab.local")
    .single();

  const { data: exp, error: expError } = await admin
    .from("experiments")
    .insert({
      title: `E2E 테스트 실험 ${Date.now()}`,
      description: "자동 E2E 테스트용 실험",
      start_date: startDateStr,
      end_date: endDateStr,
      daily_start_time: "09:00",
      daily_end_time: "18:00",
      session_duration_minutes: 60,
      break_between_slots_minutes: 0,
      max_participants_per_slot: 1,
      session_type: "single",
      required_sessions: 1,
      status: "active",
      participation_fee: 30000,
      google_calendar_id: process.env.GOOGLE_CALENDAR_ID ?? null,
      created_by: csnl?.id ?? null,
      precautions: [],
    })
    .select()
    .single();
  phase("experiment.created", !expError && !!exp, { id: exp?.id, error: expError?.message });

  if (!exp) {
    ev.finishedAt = new Date().toISOString();
    await writeFile("/tmp/e2e-booking-evidence.json", JSON.stringify(ev, null, 2));
    process.exit(1);
  }

  // --- Phase 2: fetch range slots ---
  const rangeRes = await fetch(
    `${APP}/api/experiments/${exp.id}/slots/range?from=${startDateStr}&to=${endDateStr}`,
  );
  const range = await rangeRes.json().catch(() => ({}));
  phase("slots.range.ok", rangeRes.ok && (range.slots?.length ?? 0) > 0, {
    status: rangeRes.status,
    count: range.slots?.length ?? 0,
    calendarWarning: range.calendarWarning,
  });

  // Pick the first available slot that's strictly in the future (past-slot
  // rejection, phase 8 below, exercises the same guard explicitly).
  const now = Date.now();
  const candidate = (range.slots ?? []).find(
    (s) => s.status === "available" && new Date(s.slot_start).getTime() > now + 60_000,
  );
  phase("slots.pickAvailable", !!candidate, { candidate });
  if (!candidate) {
    ev.finishedAt = new Date().toISOString();
    await writeFile("/tmp/e2e-booking-evidence.json", JSON.stringify(ev, null, 2));
    process.exit(2);
  }

  // --- Phase 3: submit booking ---
  const participant = {
    name: "테스트 참가자",
    phone: "010-1111-2222",
    email: "e2e-tester@example.com",
    gender: "male",
    birthdate: "1995-05-05",
  };
  const bookRes = await fetch(`${APP}/api/bookings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      experiment_id: exp.id,
      participant,
      slots: [
        { slot_start: candidate.slot_start, slot_end: candidate.slot_end, session_number: 1 },
      ],
    }),
  });
  const book = await bookRes.json().catch(() => ({}));
  phase("booking.api.201", bookRes.status === 201, { status: bookRes.status, body: book });

  if (bookRes.status !== 201) {
    ev.finishedAt = new Date().toISOString();
    await writeFile("/tmp/e2e-booking-evidence.json", JSON.stringify(ev, null, 2));
    process.exit(3);
  }

  const bookingId = book.booking_ids?.[0];
  ev.bookingId = bookingId;
  ev.bookingGroupId = book.booking_group_id;

  // --- Phase 4: verify DB row ---
  const { data: dbRow, error: dbErr } = await admin
    .from("bookings")
    .select("id, status, slot_start, slot_end, google_event_id, notion_page_id, participant_id")
    .eq("id", bookingId)
    .single();
  phase("booking.db.row", !!dbRow && dbRow.status === "confirmed", {
    row: dbRow,
    error: dbErr?.message,
  });

  // --- Phase 5: wait for post-booking pipeline (fire-and-forget) ---
  const MAX_WAIT = 15_000;
  const POLL = 500;
  const deadline = Date.now() + MAX_WAIT;
  let gotEvent = false;
  while (Date.now() < deadline) {
    const { data } = await admin
      .from("bookings")
      .select("google_event_id, notion_page_id")
      .eq("id", bookingId)
      .single();
    if (data?.google_event_id) {
      gotEvent = true;
      ev.googleEventId = data.google_event_id;
      ev.notionPageId = data.notion_page_id ?? null;
      break;
    }
    await new Promise((r) => setTimeout(r, POLL));
  }
  phase("booking.gcal.event_id", gotEvent, { eventId: ev.googleEventId });

  // --- Phase 6: actually query GCal for that event ---
  if (gotEvent && process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL) {
    try {
      const auth = new google.auth.GoogleAuth({
        scopes: ["https://www.googleapis.com/auth/calendar"],
        credentials: {
          client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
          private_key: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, "\n"),
        },
      });
      const calendar = google.calendar({ version: "v3", auth });
      const cal = exp.google_calendar_id || process.env.GOOGLE_CALENDAR_ID;
      const { data: gcalEvent } = await calendar.events.get({
        calendarId: cal,
        eventId: ev.googleEventId,
      });
      phase("gcal.event.fetched", !!gcalEvent?.id, {
        id: gcalEvent?.id,
        summary: gcalEvent?.summary,
        start: gcalEvent?.start?.dateTime,
        end: gcalEvent?.end?.dateTime,
      });
      ev.gcalEvent = {
        id: gcalEvent?.id,
        summary: gcalEvent?.summary,
        start: gcalEvent?.start?.dateTime,
        end: gcalEvent?.end?.dateTime,
      };
    } catch (e) {
      phase("gcal.event.fetched", false, { error: e.message });
    }
  } else {
    phase("gcal.event.fetched", false, { skipped: "no event_id or no service account email" });
  }

  // --- Phase 7: duplicate booking rejection (same slot) ---
  const dupeRes = await fetch(`${APP}/api/bookings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      experiment_id: exp.id,
      participant: { ...participant, email: "other@example.com" },
      slots: [
        { slot_start: candidate.slot_start, slot_end: candidate.slot_end, session_number: 1 },
      ],
    }),
  });
  phase("booking.dupe.rejected", dupeRes.status === 409, { status: dupeRes.status });

  // --- Phase 8: past-slot rejection ---
  const pastSlot = new Date(Date.now() - 3_600_000); // 1h ago
  const pastEnd = new Date(pastSlot.getTime() + 60 * 60 * 1000);
  const pastRes = await fetch(`${APP}/api/bookings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      experiment_id: exp.id,
      participant: { ...participant, email: "past-test@example.com", phone: "010-9999-8888" },
      slots: [
        { slot_start: pastSlot.toISOString(), slot_end: pastEnd.toISOString(), session_number: 1 },
      ],
    }),
  });
  const pastBody = await pastRes.json().catch(() => ({}));
  phase("booking.past.rejected", pastRes.status === 400 && /지난 시간/.test(pastBody.error ?? ""), {
    status: pastRes.status,
    body: pastBody,
  });

  // --- Phase 9: integration outbox rows ---
  // Wait for outbox rows to be materialised (still fire-and-forget from API
  // standpoint, but should land within a few seconds).
  const outboxDeadline = Date.now() + 15_000;
  let integrations = [];
  while (Date.now() < outboxDeadline) {
    const { data } = await admin
      .from("booking_integrations")
      .select("integration_type, status, external_id, last_error")
      .eq("booking_id", bookingId);
    if (data && data.length === 4) {
      integrations = data;
      // break once all four terminal (completed|failed|skipped), not still pending
      if (data.every((r) => r.status !== "pending")) break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  ev.integrations = integrations;
  phase("integrations.gcal", integrations.find((i) => i.integration_type === "gcal")?.status === "completed", {
    row: integrations.find((i) => i.integration_type === "gcal"),
  });
  phase("integrations.email", ["completed", "skipped"].includes(integrations.find((i) => i.integration_type === "email")?.status), {
    row: integrations.find((i) => i.integration_type === "email"),
  });
  phase("integrations.notion", ["completed", "skipped", "failed"].includes(integrations.find((i) => i.integration_type === "notion")?.status), {
    row: integrations.find((i) => i.integration_type === "notion"),
  });
  phase("integrations.sms", ["completed", "skipped"].includes(integrations.find((i) => i.integration_type === "sms")?.status), {
    row: integrations.find((i) => i.integration_type === "sms"),
  });

  // Cleanup experiment + bookings (keep for reviewer inspection — delete is optional)
  ev.experiment = {
    id: exp.id,
    title: exp.title,
    calendarId: exp.google_calendar_id,
  };
  ev.finishedAt = new Date().toISOString();

  await writeFile("/tmp/e2e-booking-evidence.json", JSON.stringify(ev, null, 2));
  console.log("=".repeat(60));
  console.log(`Passed ${ev.summary.passed}  Failed ${ev.summary.failed}`);
  console.log("Evidence written to /tmp/e2e-booking-evidence.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
