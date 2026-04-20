#!/usr/bin/env node
// Multi-session E2E: 시간추정실험 1 configured as 5회차 multi with Sbj start=10
// and project_name="TimeEst". Books two participants and verifies that:
//   • each gets 5 distinct-date bookings, all with the same Sbj
//   • A=Sbj 10 (start), B=Sbj 11 (next)
//   • all 10 calendar events show "[${process.env.NEXT_PUBLIC_LAB_NAME || "LAB"}] TimeEst/Sbj N/Day M"

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
  console.log(`Multi-session Sbj=10 E2E (app=${APP})`);
  console.log("=".repeat(62));

  // Clear bookings so Sbj starts at configured value (10)
  await admin.from("bookings").delete().eq("experiment_id", EXP_ID);

  const { data: exp } = await admin.from("experiments").select("*").eq("id", EXP_ID).single();
  phase("experiment.config", exp.session_type === "multi" && exp.required_sessions === 5 && exp.subject_start_number === 10 && exp.project_name === "TimeEst", {
    session_type: exp.session_type,
    required_sessions: exp.required_sessions,
    subject_start_number: exp.subject_start_number,
    project_name: exp.project_name,
  });

  // Fetch range slots
  const rangeRes = await fetch(`${APP}/api/experiments/${EXP_ID}/slots/range`);
  const range = await rangeRes.json();
  const slots = (range.slots ?? []).filter((s) => s.status === "available" && new Date(s.slot_start).getTime() > Date.now() + 60_000);
  phase("slots.available", slots.length >= 10, { count: slots.length });

  // Pick 5 slots on 5 different KST dates for participant A
  function kstDate(iso) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso));
    return `${parts.find(p=>p.type==="year").value}-${parts.find(p=>p.type==="month").value}-${parts.find(p=>p.type==="day").value}`;
  }
  // Pick N slots on N distinct KST dates, avoiding a set of slot_starts
  // already claimed by another participant. Dates themselves can overlap
  // between participants as long as slot times differ.
  function pickN(fromSlots, n, skipSlotStarts = new Set()) {
    const seenDates = new Set();
    const chosen = [];
    for (const s of fromSlots) {
      if (skipSlotStarts.has(s.slot_start)) continue;
      const dk = kstDate(s.slot_start);
      if (seenDates.has(dk)) continue;
      chosen.push(s);
      seenDates.add(dk);
      if (chosen.length === n) break;
    }
    return { chosen, slotStarts: new Set(chosen.map((s) => s.slot_start)) };
  }

  const { chosen: aSlots, slotStarts: aSlotStarts } = pickN(slots, 5);
  phase("pickA.5_distinct_dates", aSlots.length === 5, { count: aSlots.length });
  const { chosen: bSlots } = pickN(slots, 5, aSlotStarts);
  phase("pickB.5_distinct_dates", bSlots.length === 5, { count: bSlots.length });

  // Book A
  const bookA = await fetch(`${APP}/api/bookings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      experiment_id: EXP_ID,
      participant: {
        name: "멀티 A",
        phone: "010-3333-3333",
        email: "multi-a@example.com",
        gender: "male",
        birthdate: "1990-01-01",
      },
      slots: aSlots.map((s, i) => ({ slot_start: s.slot_start, slot_end: s.slot_end, session_number: i + 1 })),
    }),
  });
  const bodyA = await bookA.json().catch(() => ({}));
  phase("bookingA.multi.created", bookA.status === 201 && bodyA.booking_ids?.length === 5, { status: bookA.status, ids: bodyA.booking_ids?.length });

  const bookB = await fetch(`${APP}/api/bookings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      experiment_id: EXP_ID,
      participant: {
        name: "멀티 B",
        phone: "010-4444-4444",
        email: "multi-b@example.com",
        gender: "female",
        birthdate: "1991-06-15",
      },
      slots: bSlots.map((s, i) => ({ slot_start: s.slot_start, slot_end: s.slot_end, session_number: i + 1 })),
    }),
  });
  const bodyB = await bookB.json().catch(() => ({}));
  phase("bookingB.multi.created", bookB.status === 201 && bodyB.booking_ids?.length === 5, { status: bookB.status, ids: bodyB.booking_ids?.length });

  // Verify Sbj numbers: A=10, B=11 for all 5 rows each
  const { data: rowsA } = await admin.from("bookings").select("subject_number, session_number").in("id", bodyA.booking_ids ?? []).order("session_number");
  const { data: rowsB } = await admin.from("bookings").select("subject_number, session_number").in("id", bodyB.booking_ids ?? []).order("session_number");

  phase("sbjA.all_10", rowsA?.every((r) => r.subject_number === 10) && rowsA?.length === 5, {
    sbjs: rowsA?.map((r) => r.subject_number),
  });
  phase("sbjB.all_11", rowsB?.every((r) => r.subject_number === 11) && rowsB?.length === 5, {
    sbjs: rowsB?.map((r) => r.subject_number),
  });

  // Wait for outbox + verify calendar titles
  await sleep(8000);

  const { data: intRows } = await admin
    .from("booking_integrations")
    .select("booking_id, external_id, status")
    .eq("integration_type", "gcal")
    .in("booking_id", [...(bodyA.booking_ids ?? []), ...(bodyB.booking_ids ?? [])]);
  phase("gcal.all_completed", intRows?.length === 10 && intRows.every((r) => r.status === "completed"), {
    count: intRows?.length,
    statuses: Array.from(new Set(intRows?.map((r) => r.status) ?? [])),
  });

  // Pull calendar events and verify titles
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/calendar"],
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    },
  });
  const calendar = google.calendar({ version: "v3", auth });
  const calendarId = exp.google_calendar_id || process.env.GOOGLE_CALENDAR_ID;

  const titleCheck = { correct: 0, wrong: [] };
  for (const row of intRows ?? []) {
    try {
      const { data: ev } = await calendar.events.get({ calendarId, eventId: row.external_id });
      const isA = bodyA.booking_ids?.includes(row.booking_id);
      const sbj = isA ? 10 : 11;
      // Find session_number
      const bookingRow = [...(rowsA ?? []), ...(rowsB ?? [])].find((_, i) =>
        i < (rowsA?.length ?? 0)
          ? bodyA.booking_ids?.[i] === row.booking_id
          : bodyB.booking_ids?.[i - (rowsA?.length ?? 0)] === row.booking_id,
      );
      const { data: bRow } = await admin.from("bookings").select("session_number").eq("id", row.booking_id).single();
      const day = bRow?.session_number;
      const expected = `[${process.env.NEXT_PUBLIC_LAB_NAME || "LAB"}] TimeEst/Sbj ${sbj}/Day ${day}`;
      if (ev.summary === expected) titleCheck.correct++;
      else titleCheck.wrong.push({ got: ev.summary, expected });
    } catch (e) {
      titleCheck.wrong.push({ error: e.message });
    }
  }
  phase("gcal.titles.all_formatted", titleCheck.correct === 10 && titleCheck.wrong.length === 0, titleCheck);

  console.log("=".repeat(62));
  console.log(`Passed ${summary.passed}  Failed ${summary.failed}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
