#!/usr/bin/env node
// Clean DB + Google Calendar:
// 1. Delete every experiment except fb1cc943 (bookings, reminders, integrations cascade).
// 2. Delete all bookings on fb1cc943 (they were test runs too).
// 3. Delete every Google Calendar event we have a record of.
// 4. Set fb1cc943 to multi-session (required_sessions=5) without touching other fields.

import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";
import "dotenv/config";

const KEEP_ID = "fb1cc943-4419-49c9-8dbd-9314888280dd";
const CAL_ID = (process.env.GOOGLE_CALENDAR_ID || "").trim();

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

function mkCalendar() {
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
  return google.calendar({ version: "v3", auth });
}

async function listTestCalendarEvents() {
  const { data } = await supabase
    .from("bookings")
    .select("id,experiment_id,booking_integrations(external_id,integration_type,status)");
  const events = [];
  for (const b of data ?? []) {
    for (const i of b.booking_integrations ?? []) {
      if (i.integration_type === "gcal" && i.external_id) {
        events.push(i.external_id);
      }
    }
  }
  return [...new Set(events)];
}

async function deleteCalendarEvent(cal, eventId) {
  try {
    await cal.events.delete({ calendarId: CAL_ID, eventId });
    return "deleted";
  } catch (e) {
    const code = e?.response?.status ?? e?.code;
    if (code === 404 || code === 410) return "already_gone";
    throw e;
  }
}

async function main() {
  console.log("== Step 1: delete calendar events ==");
  const cal = mkCalendar();
  const evs = await listTestCalendarEvents();
  console.log(`  Found ${evs.length} event ids on calendar ${CAL_ID}`);
  for (const id of evs) {
    const result = await deleteCalendarEvent(cal, id);
    console.log(`  ${id}: ${result}`);
  }

  console.log("\n== Step 2: delete other experiments ==");
  const { data: others } = await supabase
    .from("experiments")
    .select("id,title")
    .neq("id", KEEP_ID);
  for (const e of others ?? []) {
    const { error } = await supabase.from("experiments").delete().eq("id", e.id);
    console.log(`  ${e.id} (${e.title}): ${error ? "ERR " + error.message : "deleted"}`);
  }

  console.log("\n== Step 3: purge bookings/reminders on fb1cc943 ==");
  // Delete reminders first (they FK to bookings)
  const { data: keepBks } = await supabase
    .from("bookings")
    .select("id")
    .eq("experiment_id", KEEP_ID);
  const ids = (keepBks ?? []).map((b) => b.id);
  if (ids.length > 0) {
    await supabase.from("reminders").delete().in("booking_id", ids);
    await supabase.from("booking_integrations").delete().in("booking_id", ids);
    await supabase.from("bookings").delete().in("id", ids);
    console.log(`  Purged ${ids.length} bookings on fb1cc943`);
  } else {
    console.log("  No bookings to purge on fb1cc943");
  }

  console.log("\n== Step 4: update fb1cc943 → multi-session 5회차 ==");
  const { error: updErr } = await supabase
    .from("experiments")
    .update({ session_type: "multi", required_sessions: 5 })
    .eq("id", KEEP_ID);
  console.log(updErr ? "  ERR " + updErr.message : "  updated");

  console.log("\n== Step 5: verify ==");
  const { data: remain } = await supabase
    .from("experiments")
    .select("id,title,session_type,required_sessions");
  console.log(remain);

  const { count: bkCount } = await supabase
    .from("bookings")
    .select("id", { count: "exact", head: true });
  console.log(`  Bookings remaining: ${bkCount}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
