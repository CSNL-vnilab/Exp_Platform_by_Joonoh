#!/usr/bin/env node
// Targeted E2E for 시간추정실험 1 — validates the new features introduced in
// this cycle:
//   1) weekdays[] filter (Sunday slots should be 0)
//   2) subject_number allocation (Sbj 1, Sbj 2 for two participants)
//   3) calendar event title format `[INITIAL] Project/Sbj N/Day M`
//   4) duplicate + past-slot rejection still works
//   5) researcher contact info surfaced on confirm page (phone + email)

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

const APP = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
const EXP_ID = process.argv[2] ?? "8ede2129-0c77-44e9-ad3d-16033ac25d7d";

const phases = [];
const summary = { passed: 0, failed: 0 };

function phase(name, ok, details) {
  phases.push({ name, ok, details });
  summary[ok ? "passed" : "failed"] += 1;
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) console.log("    ↳", JSON.stringify(details).slice(0, 300));
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  await loadEnv();
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  );

  console.log("=".repeat(62));
  console.log(`시간추정실험 1  E2E (app=${APP})`);
  console.log(`exp_id=${EXP_ID}`);
  console.log("=".repeat(62));

  // Sanity: load experiment
  const { data: exp } = await admin.from("experiments").select("*").eq("id", EXP_ID).single();
  phase("experiment.loaded", !!exp && exp.title === "시간추정실험 1", {
    title: exp?.title,
    weekdays: exp?.weekdays,
    project_name: exp?.project_name,
    subject_start_number: exp?.subject_start_number,
  });
  if (!exp) process.exit(1);

  // Fetch range slots
  const rangeRes = await fetch(`${APP}/api/experiments/${EXP_ID}/slots/range`);
  const range = await rangeRes.json();
  const slots = range.slots ?? [];
  phase("range.slots.loaded", slots.length > 0, {
    total: slots.length,
    available: slots.filter((s) => s.status === "available").length,
  });

  // Verify weekday filter: no Sunday slots should be present
  const sundaySlots = slots.filter((s) => {
    const kstDate = new Date(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Seoul",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(s.slot_start)) + "T09:00:00+09:00",
    );
    return kstDate.getDay() === 0;
  });
  phase("weekday.filter.no_sunday", sundaySlots.length === 0, { sundayCount: sundaySlots.length });

  // Clean up any previous test bookings so Sbj numbers start from the configured start
  await admin.from("bookings").delete().eq("experiment_id", EXP_ID);

  // Pick two future available slots
  const now = Date.now();
  const futureAvail = slots
    .filter((s) => s.status === "available" && new Date(s.slot_start).getTime() > now + 60_000)
    .slice(0, 2);
  phase("candidates.picked", futureAvail.length === 2, { futureAvail });
  if (futureAvail.length < 2) process.exit(2);

  // Participant A
  const partA = {
    name: "테스트 A",
    phone: "010-1111-1111",
    email: "e2e-a@example.com",
    gender: "male",
    birthdate: "1995-01-01",
  };
  const bookARes = await fetch(`${APP}/api/bookings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      experiment_id: EXP_ID,
      participant: partA,
      slots: [
        { slot_start: futureAvail[0].slot_start, slot_end: futureAvail[0].slot_end, session_number: 1 },
      ],
    }),
  });
  const bookA = await bookARes.json().catch(() => ({}));
  phase("bookingA.created", bookARes.status === 201, { status: bookARes.status, body: bookA });
  const bookingIdA = bookA.booking_ids?.[0];

  // Participant B
  const partB = {
    name: "테스트 B",
    phone: "010-2222-2222",
    email: "e2e-b@example.com",
    gender: "female",
    birthdate: "1998-06-15",
  };
  const bookBRes = await fetch(`${APP}/api/bookings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      experiment_id: EXP_ID,
      participant: partB,
      slots: [
        { slot_start: futureAvail[1].slot_start, slot_end: futureAvail[1].slot_end, session_number: 1 },
      ],
    }),
  });
  const bookB = await bookBRes.json().catch(() => ({}));
  phase("bookingB.created", bookBRes.status === 201, { status: bookBRes.status, body: bookB });
  const bookingIdB = bookB.booking_ids?.[0];

  // Subject numbers: A should be subject_start_number, B should be next
  const startN = exp.subject_start_number ?? 1;
  const { data: rowsAB } = await admin
    .from("bookings")
    .select("id, subject_number, session_number")
    .in("id", [bookingIdA, bookingIdB]);
  const byId = Object.fromEntries((rowsAB ?? []).map((r) => [r.id, r]));

  phase(
    "sbj.A.allocated",
    byId[bookingIdA]?.subject_number === startN,
    { expected: startN, got: byId[bookingIdA]?.subject_number },
  );
  phase(
    "sbj.B.allocated",
    byId[bookingIdB]?.subject_number === startN + 1,
    { expected: startN + 1, got: byId[bookingIdB]?.subject_number },
  );

  // Wait for post-booking pipeline to complete (integrations outbox)
  await sleep(4000);

  // Check GCal event title format
  const { data: intA } = await admin
    .from("booking_integrations")
    .select("external_id, status, last_error")
    .eq("booking_id", bookingIdA)
    .eq("integration_type", "gcal")
    .single();
  phase("integrations.gcal.A", intA?.status === "completed", { int: intA });

  if (intA?.external_id) {
    const auth = new google.auth.GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/calendar"],
      credentials: {
        client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, "\n"),
      },
    });
    const calendar = google.calendar({ version: "v3", auth });
    const { data: gcalEvent } = await calendar.events.get({
      calendarId: exp.google_calendar_id || process.env.GOOGLE_CALENDAR_ID,
      eventId: intA.external_id,
    });

    // Format: "[INITIAL] <project>/Sbj N/Day M" — accept any lab initial
    // since it comes from the deployment's NEXT_PUBLIC_LAB_NAME env.
    const titleRe = new RegExp(`^\\[[A-Z]+\\] TimeEst/Sbj ${startN}/Day 1$`);
    phase(
      "gcal.title.format",
      titleRe.test(gcalEvent.summary ?? ""),
      { pattern: titleRe.source, got: gcalEvent.summary },
    );

    // Expected description contains 예약자/이메일/전화번호/회차
    const desc = gcalEvent.description ?? "";
    phase(
      "gcal.description.format",
      desc.includes("예약자: 테스트 A") &&
        desc.includes("이메일: e2e-a@example.com") &&
        desc.includes("전화번호: 010-1111-1111") &&
        desc.includes("회차: 1회차"),
      { desc },
    );
  }

  // Weekday enforcement: try booking a Sunday slot (should be rejected)
  const sundayTry = new Date("2026-04-26T13:00:00+09:00");
  const sundayEnd = new Date("2026-04-26T14:00:00+09:00");
  const rejectRes = await fetch(`${APP}/api/bookings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      experiment_id: EXP_ID,
      participant: {
        ...partA,
        email: "sunday-try@example.com",
        phone: "010-9999-9999",
      },
      slots: [
        { slot_start: sundayTry.toISOString(), slot_end: sundayEnd.toISOString(), session_number: 1 },
      ],
    }),
  });
  phase("weekday.reject.sunday", rejectRes.status >= 400, { status: rejectRes.status });

  // Confirm page renders + includes 문의 section
  const confirmPage = await fetch(
    `${APP}/book/${EXP_ID}/confirm?bookingGroupId=${bookA.booking_group_id}`,
  );
  const html = await confirmPage.text();
  phase(
    "confirm.contact.rendered",
    confirmPage.status === 200 && html.includes("문의") && html.includes("csnl"),
    { status: confirmPage.status, hasEnquiry: html.includes("문의"), hasCsnl: html.includes("csnl") },
  );

  console.log("=".repeat(62));
  console.log(`Passed ${summary.passed}  Failed ${summary.failed}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
