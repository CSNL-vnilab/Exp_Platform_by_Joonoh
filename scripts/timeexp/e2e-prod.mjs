#!/usr/bin/env node
// End-to-end TimeExpOnline1_demo smoke against PROD.
//
// Acts in three roles in sequence:
//   1. Experimenter — service-role inserts an experiment record + a
//      participant + a confirmed booking + experiment_run_progress with
//      an HMAC run-token (mimics what the /experiments/new + /book
//      flows produce, but without UI).
//   2. Participant — Playwright headless Chromium navigates to
//      /run/<bookingId>?t=<token>, walks through calibration → refresh
//      gate → day picker → instructions → block intro → 30 trials with
//      an auto-clicker that fires real (isTrusted) clicks roughly 1 s
//      into each response window.
//   3. Verifier — service-role re-reads experiment_run_progress + the
//      experiment-data Storage bucket to confirm at least one block
//      landed with the expected schema.
//
// Outputs at the end:
//   - URL the human can open in their already-logged-in dashboard
//     to inspect the experiment row + the participant's booking row.
//   - Screenshots of every gating UI surface to /tmp/timeexp-e2e/.
//
// Run:
//   node scripts/timeexp/e2e-prod.mjs
// Env (read from .env.local automatically):
//   NEXT_PUBLIC_APP_URL, NEXT_PUBLIC_SUPABASE_URL,
//   SUPABASE_SERVICE_ROLE_KEY, RUN_TOKEN_SECRET (or REGISTRATION_SECRET).
//
// Notes:
//   - Test artefacts are tagged "[E2E-TimeExp]" so a researcher can find
//     and archive them. By default the experiment is left in `draft`
//     status (invisible to participants) and the script does NOT delete
//     anything; pass --cleanup to drop the inserted rows + storage.

import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..");
const OUT = "/tmp/timeexp-e2e";

async function loadEnv() {
  const text = await readFile(join(REPO, ".env.local"), "utf8").catch(() => "");
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
}
await loadEnv();

const APP = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
const cleanup = process.argv.includes("--cleanup");

if (!APP || !process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("missing required env. need NEXT_PUBLIC_APP_URL + SUPABASE creds.");
  process.exit(2);
}

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

// ── token plumbing — same as scripts/e2e-online-phase2.mjs ──
function tokenKey() {
  return createHash("sha256")
    .update(
      process.env.RUN_TOKEN_SECRET ??
        process.env.REGISTRATION_SECRET ??
        process.env.SUPABASE_SERVICE_ROLE_KEY,
    )
    .digest();
}
const b64u = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function issueToken(bookingId) {
  const nonce = b64u(randomBytes(16));
  const issuedAt = Date.now();
  const payload = `${bookingId}.${issuedAt}.${nonce}`;
  const sig = b64u(createHmac("sha256", tokenKey()).update(payload).digest());
  const token = `${payload}.${sig}`;
  return { token, hash: createHash("sha256").update(token).digest("hex"), issuedAt };
}

const log = (...a) => console.log("[e2e]", ...a);

async function seedExperiment() {
  const { data: labs } = await admin.from("labs").select("id").limit(1);
  const labId = labs?.[0]?.id;
  if (!labId) throw new Error("no labs row — migrations 00025+ not applied");

  const expId = randomUUID();
  const today = new Date();
  const inTwoWeeks = new Date(today.getTime() + 14 * 86_400_000);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  const { error: expErr } = await admin.from("experiments").insert({
    id: expId,
    lab_id: labId,
    title: `[E2E-TimeExp] TimeExpOnline1_demo @ ${stamp}`,
    description: "E2E smoke for the web port of main_duration.m. Safe to delete.",
    start_date: today.toISOString().slice(0, 10),
    end_date: inTwoWeeks.toISOString().slice(0, 10),
    daily_start_time: "09:00",
    daily_end_time: "18:00",
    session_duration_minutes: 30,
    max_participants_per_slot: 1,
    participation_fee: 0,
    status: "draft",
    experiment_mode: "online",
    session_type: "multi",
    required_sessions: 5,
    online_runtime_config: {
      entry_url: `${APP}/demo-exp/timeexp/main.js`,
      block_count: 10,
      estimated_minutes: 50,
    },
    data_consent_required: false,
  });
  if (expErr) throw new Error("experiment insert: " + expErr.message);

  log(`seeded experiment ${expId}`);
  return { expId, labId };
}

async function seedBooking(expId) {
  const participantId = randomUUID();
  const bookingId = randomUUID();
  const slotStart = new Date(Date.now() + 60_000);
  const slotEnd = new Date(slotStart.getTime() + 50 * 60_000);

  const { error: pErr } = await admin.from("participants").insert({
    id: participantId,
    name: "[E2E-TimeExp] participant",
    phone: "01000000000",
    email: `e2e-timeexp-${Date.now()}@example.test`,
    gender: "other",
    birthdate: "1990-01-01",
  });
  if (pErr) throw new Error("participant insert: " + pErr.message);

  const { error: bErr } = await admin.from("bookings").insert({
    id: bookingId,
    experiment_id: expId,
    participant_id: participantId,
    slot_start: slotStart.toISOString(),
    slot_end: slotEnd.toISOString(),
    session_number: 1,
    subject_number: 1,
    status: "confirmed",
  });
  if (bErr) throw new Error("booking insert: " + bErr.message);

  const issued = issueToken(bookingId);
  const { error: progErr } = await admin
    .from("experiment_run_progress")
    .upsert(
      {
        booking_id: bookingId,
        token_hash: issued.hash,
        token_issued_at: new Date(issued.issuedAt).toISOString(),
      },
      { onConflict: "booking_id" },
    );
  if (progErr) throw new Error("progress upsert: " + progErr.message);

  log(`seeded booking ${bookingId} (subject 1, day 1, dist=U)`);
  return { bookingId, participantId, token: issued.token };
}

async function snapshot(page, label) {
  await mkdir(OUT, { recursive: true });
  const p = join(OUT, label + ".png");
  await page.screenshot({ path: p, fullPage: false });
  return p;
}

async function driveParticipant({ bookingId, token, expId, runUrl }) {
  log("launching headless chromium");
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error" || /error|FATAL/i.test(t)) console.log("  [console]", t);
  });
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

  log(`navigate → ${runUrl}`);
  await page.goto(runUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await snapshot(page, "00a-run-page");

  // The /run page is a researcher-friendly intro screen with a "실험 시작"
  // (Start experiment) button. Clicking it sets phase=running which
  // mounts the sandbox iframe with main.js.
  const startBtn = page.getByRole("button", { name: /실험\s*시작|Start experiment/i });
  await startBtn.waitFor({ state: "visible", timeout: 30_000 });
  await snapshot(page, "00b-pre-start");
  await startBtn.click({ force: true });
  // Give React a tick + screenshot post-click for diagnosis if iframe
  // never materializes.
  await page.waitForTimeout(1_000);
  await snapshot(page, "00c-post-start");

  // Iframe locator. Allow either srcdoc or src forms; FrameLocator picks
  // the first iframe (built after start click).
  try {
    await page.waitForSelector("iframe", { timeout: 30_000 });
  } catch (err) {
    const html = await page.content();
    log("post-click HTML head:", html.slice(0, 600));
    throw err;
  }
  const frame = page.frameLocator("iframe").first();

  // ── Calibration step 1: card width ──
  // The iframe is `h-[70vh]` on the parent page; even with force:true
  // Playwright's CDP click sometimes flags content as "outside viewport".
  // For calibration / day-picker / instructions our handlers don't check
  // event.isTrusted, so dispatching a click via DOM is safe — it reaches
  // the addEventListener("click", ...) registered by main.js.
  const clickInFrame = (sel) =>
    frame.locator(sel).first().evaluate((el) => el.click());

  await frame.locator("#cal-next").waitFor({ state: "visible", timeout: 30_000 });
  await snapshot(page, "01-calibration");
  await clickInFrame("#cal-next");

  // ── Calibration step 2: distance, default 60 cm ──
  await frame.locator("#cal-finish").waitFor({ state: "visible", timeout: 10_000 });
  await snapshot(page, "02-distance");
  await clickInFrame("#cal-finish");

  // ── Refresh-rate gate may show; bypass under headless ──
  let bypassed = false;
  try {
    await frame.locator("#hz-bypass").waitFor({ state: "visible", timeout: 6_000 });
    bypassed = true;
    await snapshot(page, "03-refresh-gate");
    await clickInFrame("#hz-bypass");
  } catch {
    log("refresh gate passed (no overlay)");
  }
  log(`refresh gate: ${bypassed ? "bypassed" : "passed"}`);

  // ── Day picker (sessionIndex undefined in current shim → asks) ──
  try {
    const dayBtn = frame.locator("button", { hasText: /^Day 1$/ });
    await dayBtn.first().waitFor({ state: "visible", timeout: 10_000 });
    await snapshot(page, "04-day-picker");
    await dayBtn.first().evaluate((el) => el.click());
    log("clicked Day 1");
  } catch {
    log("day picker skipped (sessionIndex provided?)");
  }

  // ── Master instructions screen ──
  // Instruction + block-intro + response-phase handlers all require
  // isTrusted=true on the pointerdown event. Synthetic dispatchEvent
  // would be ignored. Use real Playwright mouse clicks targeted at the
  // iframe's bounding box so the trusted event lands inside the iframe.
  const iframeEl = page.locator("iframe").first();
  const trustedClickIframe = async () => {
    const box = await iframeEl.boundingBox();
    if (!box) throw new Error("iframe no bounding box");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  };

  await frame
    .locator("h1", { hasText: /Time-reproduction/i })
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });
  await snapshot(page, "05-session-instructions");
  await trustedClickIframe();

  // ── Block 1 intro ──
  await frame
    .locator("h1", { hasText: /Block 1/i })
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });
  await snapshot(page, "06-block-1-intro");
  await trustedClickIframe();

  // ── Trial loop with auto-clicker ──
  log("trial loop started — auto-click every 600ms for ~5 minutes (block 1, 30 trials)");
  await snapshot(page, "07-trial-canvas");

  // Wait for canvas to be visible inside the iframe.
  await frame
    .locator("#ep-canvas")
    .waitFor({ state: "visible", timeout: 10_000 })
    .catch(() => log("canvas selector failed, continuing anyway"));

  // Polling auto-clicker: real Playwright clicks → isTrusted=true.
  // Coordinate-targeted at iframe centre so the click lands inside.
  let stopAuto = false;
  const autoClick = (async () => {
    while (!stopAuto) {
      try {
        const box = await iframeEl.boundingBox();
        if (box) {
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { delay: 5 });
        }
      } catch {
        /* page may be navigating */
      }
      await new Promise((r) => setTimeout(r, 600));
    }
  })();

  // ── Wait for block 1 to land on the server ──
  const expectBlocks = async (n, timeoutMs) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const { data, error } = await admin
        .from("experiment_run_progress")
        .select("blocks_submitted, behavior_signals, attention_fail_count")
        .eq("booking_id", bookingId)
        .single();
      if (!error && data && data.blocks_submitted >= n) return data;
      await new Promise((r) => setTimeout(r, 5_000));
    }
    return null;
  };
  const ok = await expectBlocks(1, 360_000); // up to 6 min for block 1
  stopAuto = true;
  await autoClick;

  await snapshot(page, "99-after-block-1");
  await browser.close();

  if (!ok) throw new Error("block 1 not submitted within 6 minutes");
  log(
    `block 1 landed in experiment_run_progress: blocks_submitted=${ok.blocks_submitted}, attention_fail=${ok.attention_fail_count}`,
  );
  return ok;
}

async function verifyStorage({ expId, subjectNumber }) {
  const prefix = `${expId}/${subjectNumber}`;
  const { data, error } = await admin.storage
    .from("experiment-data")
    .list(prefix, { limit: 50 });
  if (error) throw error;
  const blocks = (data || []).filter((d) => /^block_\d+\.json$/.test(d.name));
  log(`storage ${prefix}/  → ${blocks.length} block file(s)`);
  if (blocks.length === 0) throw new Error("no block files in storage");

  // Read block_0.json
  const dl = await admin.storage
    .from("experiment-data")
    .download(`${prefix}/${blocks[0].name}`);
  if (dl.error) throw dl.error;
  const json = JSON.parse(await dl.data.text());
  const trials = (json.trials || []).length;
  const sample = json.trials?.[0] ?? null;
  // The block route normalises payload keys to snake_case before
  // persistence, so blockMetadata becomes block_metadata in storage.
  const sessionMeta = json.block_metadata?.session ?? json.blockMetadata?.session;
  log(
    `block_0 trials=${trials}, day=${sessionMeta?.day}, dist=${sessionMeta?.distChar}, ppd≈${sessionMeta?.ppd?.toFixed?.(1)}, hz≈${sessionMeta?.refreshHz?.toFixed?.(1)}`,
  );
  if (trials !== 30) throw new Error(`expected 30 trials, got ${trials}`);
  // schema spot-check
  for (const k of ["Stm", "Est", "Error", "RT", "vbl_occlu", "occlu_dur_observed"]) {
    if (!(k in (sample || {}))) throw new Error("missing trial field: " + k);
  }
  return { trials, sessionMeta };
}

async function main() {
  log("APP=", APP);
  await mkdir(OUT, { recursive: true });
  const { expId } = await seedExperiment();
  const { bookingId, participantId, token } = await seedBooking(expId);

  const runUrl = `${APP}/run/${bookingId}?t=${encodeURIComponent(token)}`;
  log("PARTICIPANT URL (for reference):", runUrl);

  const progress = await driveParticipant({ bookingId, token, expId, runUrl });
  const verify = await verifyStorage({ expId, subjectNumber: 1 });

  console.log("");
  console.log("=".repeat(70));
  console.log("✓ E2E PASS — block 1 submitted with valid schema");
  console.log("=".repeat(70));
  console.log(`Experiment id : ${expId}`);
  console.log(`Booking id    : ${bookingId}`);
  console.log(`Participant   : ${participantId}`);
  console.log(
    `Trials        : ${verify.trials}, day=${verify.sessionMeta?.day}, dist=${verify.sessionMeta?.distChar}`,
  );
  console.log("");
  console.log("Inspect on dashboard (you're logged in):");
  console.log(`  ${APP}/experiments/${expId}`);
  console.log(`  ${APP}/experiments/${expId}/bookings`);
  console.log(`  ${APP}/experiments/${expId}/live`);
  console.log("");
  console.log("Screenshots:");
  console.log(`  ${OUT}/`);
  console.log("");

  if (cleanup) {
    log("--cleanup: dropping all seeded rows + storage");
    await admin.storage
      .from("experiment-data")
      .remove((await admin.storage.from("experiment-data").list(`${expId}/1`)).data?.map(
        (f) => `${expId}/1/${f.name}`,
      ) || []);
    await admin.from("experiment_run_progress").delete().eq("booking_id", bookingId);
    await admin.from("bookings").delete().eq("id", bookingId);
    await admin.from("participants").delete().eq("id", participantId);
    await admin.from("experiments").delete().eq("id", expId);
    log("cleanup done");
  } else {
    console.log("(records left in place — pass --cleanup to drop them)");
  }
}

main().catch((err) => {
  console.error("✗ E2E FAIL:", err);
  process.exit(1);
});
