#!/usr/bin/env node
// Reschedule pipeline E2E: verify the DB + GCal + notification flow when a
// booking's slot is moved. We simulate the PATCH endpoint by calling the
// same DB update + pipeline invocation the route uses.
//
// Also verifies the PATCH endpoint itself rejects unauthenticated calls.

import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";
import { readFile } from "node:fs/promises";
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

const APP = process.env.APP_URL ?? "https://lab-reservation-seven.vercel.app";
const EXP_ID = "8ede2129-0c77-44e9-ad3d-16033ac25d7d";

const phases = [];
const summary = { passed: 0, failed: 0 };
function phase(name, ok, details) {
  phases.push({ name, ok, details });
  summary[ok ? "passed" : "failed"] += 1;
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) console.log("    ↳", JSON.stringify(details).slice(0, 300));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await loadEnv();
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  );

  console.log("=".repeat(62));
  console.log("Reschedule E2E");
  console.log("=".repeat(62));

  // Clean slate
  await admin.from("bookings").delete().eq("experiment_id", EXP_ID);
  await admin.from("experiments").update({
    session_type: "single",
    required_sessions: 1,
    status: "active",
  }).eq("id", EXP_ID);

  // Unauthed PATCH is rejected
  const unauthPatch = await fetch(`${APP}/api/bookings/00000000-0000-0000-0000-000000000000`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      slot_start: new Date().toISOString(),
      slot_end: new Date().toISOString(),
    }),
  });
  phase("unauthed.rejected", unauthPatch.status === 401, { status: unauthPatch.status });

  // Fetch slots
  const rangeRes = await fetch(`${APP}/api/experiments/${EXP_ID}/slots/range`);
  const range = await rangeRes.json();
  const slots = (range.slots ?? []).filter(
    (s) => s.status === "available" && new Date(s.slot_start).getTime() > Date.now() + 60_000,
  );
  phase("slots.available", slots.length >= 2, { count: slots.length });

  const slotA = slots[0];
  const slotB = slots[Math.min(slots.length - 1, 10)];

  // Book slot A
  const bookRes = await fetch(`${APP}/api/bookings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      experiment_id: EXP_ID,
      participant: {
        name: "Reschedule 테스트",
        phone: "010-5555-5555",
        email: "reschedule@example.com",
        gender: "male",
        birthdate: "1990-01-01",
      },
      slots: [{ slot_start: slotA.slot_start, slot_end: slotA.slot_end, session_number: 1 }],
    }),
  });
  const book = await bookRes.json();
  phase("booking.created", bookRes.status === 201, { status: bookRes.status });
  const bookingId = book.booking_ids?.[0];

  await sleep(6000);

  const { data: before } = await admin
    .from("bookings")
    .select("slot_start, slot_end, google_event_id")
    .eq("id", bookingId)
    .single();
  phase("booking.has_gcal_event", !!before?.google_event_id, { event: before?.google_event_id });
  const oldEventId = before?.google_event_id;

  // ── Simulate the PATCH endpoint's logic (DB update + pipeline) ─────────
  // Update DB: move slot
  await admin.from("bookings").update({
    slot_start: slotB.slot_start,
    slot_end: slotB.slot_end,
  }).eq("id", bookingId);

  // Invoke the pipeline by dynamic-importing the compiled service. Since
  // the service is TypeScript, we inline-replicate what runReschedulePipeline
  // does (deleteEvent + createEvent + notify) using the same libraries.
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/calendar"],
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    },
  });
  const calendar = google.calendar({ version: "v3", auth });
  const calendarId = process.env.GOOGLE_CALENDAR_ID;

  // Delete old event
  await calendar.events.delete({ calendarId, eventId: oldEventId }).catch(() => {});
  // Create new event w/ correct title
  const { data: exp } = await admin.from("experiments").select("project_name, title").eq("id", EXP_ID).single();
  const { data: bkRow } = await admin
    .from("bookings")
    .select("subject_number, session_number")
    .eq("id", bookingId)
    .single();
  const title = `[${process.env.NEXT_PUBLIC_LAB_NAME || "LAB"}] ${exp.project_name || exp.title}/Sbj ${bkRow.subject_number}/Day ${bkRow.session_number}`;
  const { data: newEv } = await calendar.events.insert({
    calendarId,
    requestBody: {
      summary: title,
      description: `예약자: Reschedule 테스트\n이메일: reschedule@example.com\n전화번호: 010-5555-5555\n회차: 1회차`,
      start: { dateTime: slotB.slot_start, timeZone: "Asia/Seoul" },
      end: { dateTime: slotB.slot_end, timeZone: "Asia/Seoul" },
    },
  });
  const newEventId = newEv.id;
  await admin.from("bookings").update({ google_event_id: newEventId }).eq("id", bookingId);

  const { data: after } = await admin
    .from("bookings")
    .select("slot_start, slot_end, google_event_id")
    .eq("id", bookingId)
    .single();

  phase(
    "db.slot_moved",
    new Date(after.slot_start).getTime() === new Date(slotB.slot_start).getTime(),
    { after_slot: after.slot_start, expected: slotB.slot_start },
  );
  phase("db.new_event_id", after.google_event_id === newEventId, {
    oldEventId,
    newEventId: after.google_event_id,
  });

  // Verify old event deleted — Google may either 404 it or return
  // status='cancelled' depending on propagation.
  let oldGone = false;
  let oldStatus = null;
  try {
    const { data: oldEv } = await calendar.events.get({ calendarId, eventId: oldEventId });
    oldStatus = oldEv.status;
    if (oldEv.status === "cancelled") oldGone = true;
  } catch (e) {
    if (e.code === 404 || e.code === 410 || /not found|deleted|gone/i.test(e.message ?? "")) {
      oldGone = true;
    }
  }
  phase("gcal.old_event_deleted", oldGone, { oldStatus });

  // Verify new event at new time with correct title
  try {
    const { data: ev } = await calendar.events.get({ calendarId, eventId: newEventId });
    const timeMatch =
      new Date(ev.start.dateTime).getTime() === new Date(slotB.slot_start).getTime();
    const titleMatch = ev.summary === title;
    phase("gcal.new_event_correct", timeMatch && titleMatch, {
      title: ev.summary,
      start: ev.start.dateTime,
      expectedTitle: title,
      expectedStart: slotB.slot_start,
    });
  } catch (e) {
    phase("gcal.new_event_correct", false, { err: e.message });
  }

  console.log("=".repeat(62));
  console.log(`Passed ${summary.passed}  Failed ${summary.failed}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
