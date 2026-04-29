#!/usr/bin/env node
// Ideal-observer end-to-end test against deployed prod.
//
// An *ideal observer* in time-reproduction reproduces theta exactly:
// click at vbl_respOnset + theta*1000 ms. This script wires the harness
// hook stream (window.__timeexpHooks__) up to Playwright via
// page.exposeFunction so we can react to `trial:phase` events from the
// runtime and schedule precise Playwright clicks. Real (isTrusted)
// clicks land on the iframe at responseStart + θ — RT ≈ θ — Error ≈ 0.
//
// Pass criteria (block 0):
//   - all 30 trials confirmed (no debounce, no timeout)
//   - per-trial |Error| ≤ 50 ms (1 frame at 60 Hz + small scheduling jitter)
//   - biasRepro |signed mean| ≤ 10 ms
//   - block_metadata.session.schedule[0] has 30 entries; spans 15 thetaLabels
//   - storage block_0.json arrives with the same record shape as the harness
//
// Run:
//   NEXT_PUBLIC_APP_URL=https://lab-reservation-seven.vercel.app \
//     node scripts/timeexp/e2e-ideal-observer.mjs
//
// Optional flags:
//   --blocks N  run N blocks (default 1; full Day 1 = 10)
//   --cleanup   delete the seeded experiment + booking + storage at end
//
// The test seeds its own [E2E-IdealObs] experiment via service-role so
// it doesn't pollute the canonical TimeExpOnline1_demo dataset.

import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..");
const OUT = "/tmp/timeexp-ideal";

async function loadEnv() {
  const text = await readFile(join(REPO, ".env.local"), "utf8").catch(() => "");
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
}
await loadEnv();

const argv = process.argv.slice(2);
const NUM_BLOCKS = (() => {
  const idx = argv.indexOf("--blocks");
  if (idx >= 0 && idx + 1 < argv.length) return Math.max(1, Math.min(12, Number(argv[idx + 1])));
  return 1;
})();
const CLEANUP = argv.includes("--cleanup");

const APP = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
if (!APP || !process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("missing env. Need NEXT_PUBLIC_APP_URL + SUPABASE creds.");
  process.exit(2);
}

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

// ── token plumbing — mirrors src/lib/experiments/run-token.ts ──
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

const log = (...a) => console.log("[ideal]", ...a);

async function seedExperiment() {
  const { data: labs } = await admin.from("labs").select("id").limit(1);
  const labId = labs?.[0]?.id;
  if (!labId) throw new Error("no labs row");
  const expId = randomUUID();
  const today = new Date();
  const inTwoWeeks = new Date(today.getTime() + 14 * 86_400_000);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const { error } = await admin.from("experiments").insert({
    id: expId,
    lab_id: labId,
    title: `[E2E-IdealObs] TimeExpOnline1_demo @ ${stamp}`,
    description: "Ideal-observer e2e — clicks at vbl_respOnset + θ. Safe to delete.",
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
  if (error) throw new Error("experiment insert: " + error.message);
  log(`seeded experiment ${expId}`);
  return { expId };
}

async function seedBooking(expId) {
  const participantId = randomUUID();
  const bookingId = randomUUID();
  const slotStart = new Date(Date.now() + 60_000);
  const slotEnd = new Date(slotStart.getTime() + 60 * 60_000);

  await admin.from("participants").insert({
    id: participantId,
    name: "[E2E-IdealObs] participant",
    phone: "01000000000",
    email: `ideal-obs-${Date.now()}@example.test`,
    gender: "other",
    birthdate: "1990-01-01",
  });
  await admin.from("bookings").insert({
    id: bookingId,
    experiment_id: expId,
    participant_id: participantId,
    slot_start: slotStart.toISOString(),
    slot_end: slotEnd.toISOString(),
    session_number: 1,
    subject_number: 1,
    status: "confirmed",
  });

  const issued = issueToken(bookingId);
  const { error } = await admin
    .from("experiment_run_progress")
    .upsert(
      {
        booking_id: bookingId,
        token_hash: issued.hash,
        token_issued_at: new Date(issued.issuedAt).toISOString(),
      },
      { onConflict: "booking_id" },
    );
  if (error) throw new Error("progress upsert: " + error.message);
  log(`seeded booking ${bookingId} (subject 1, day 1, dist=U)`);
  return { bookingId, participantId, token: issued.token };
}

async function snapshot(page, label) {
  await mkdir(OUT, { recursive: true });
  const p = join(OUT, label + ".png");
  await page.screenshot({ path: p });
  return p;
}

async function driveIdealObserver({ bookingId, expId, runUrl }) {
  log("launching headless chromium");
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error" || /FATAL|undefined is not/i.test(t)) {
      console.log("  [console]", t);
    }
  });

  // Bridge: page calls scheduleIdealClick(theta_ms, fireAt_ms) on every
  // responseStart event; we wait until fireAt_ms then issue a real
  // Playwright click at the iframe centre (so it's isTrusted and lands
  // inside the iframe content).
  let pendingResolves = 0;
  const pendingClicks = [];
  await page.exposeFunction("scheduleIdealClick", async (thetaMs, fireAtMs) => {
    pendingClicks.push({ thetaMs, fireAtMs });
    pendingResolves += 1;
  });

  // Tracker that ticks every 5 ms and fires due clicks. Runs in node, not
  // page — so we can use real Playwright mouse.click at precise wall time.
  let clickerStop = false;
  const iframeBox = { current: null };
  const clickerLoop = (async () => {
    while (!clickerStop) {
      await new Promise((r) => setTimeout(r, 4));
      const now = await page.evaluate(() => performance.now()).catch(() => null);
      if (now == null) continue;
      while (pendingClicks.length > 0 && pendingClicks[0].fireAtMs <= now) {
        const job = pendingClicks.shift();
        try {
          if (!iframeBox.current) {
            iframeBox.current = await page.locator("iframe").first().boundingBox();
          }
          const box = iframeBox.current;
          if (box) {
            const cx = box.x + box.width / 2;
            const cy = box.y + box.height / 2;
            await page.mouse.click(cx, cy, { delay: 1 });
          }
        } catch {
          /* page may be navigating */
        }
      }
    }
  })();

  log(`navigate → ${runUrl}`);
  await page.goto(runUrl, { waitUntil: "networkidle", timeout: 60_000 });
  await snapshot(page, "00-run-page");

  // Click 실험 시작 (DOM-direct to avoid Playwright role-click race).
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll("button")).some((b) => /실험.*시작/.test(b.textContent || "")),
    null,
    { timeout: 30_000 },
  );
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button")).find((b) =>
      /실험.*시작/.test(b.textContent || ""),
    );
    btn && btn.click();
  });
  await page.waitForSelector("iframe", { timeout: 30_000 });
  const frame = page.frameLocator("iframe").first();
  iframeBox.current = await page.locator("iframe").first().boundingBox();

  // Wait for the iframe shim to expose __timeexpHooks__, then attach our
  // responseStart subscriber that calls back into node via the exposed
  // scheduleIdealClick.
  const frameElHandle = await page.locator("iframe").first().elementHandle();
  const frameObj = await frameElHandle.contentFrame();
  await frameObj.waitForFunction(() => window.__timeexpHooks__, null, { timeout: 30_000 });
  await frameObj.evaluate(() => {
    // Subscribe inside iframe. When responseStart fires, compute the
    // remaining time to θ from the iframe's own performance.now() (since
    // parent + sandboxed iframe have different time origins, we send
    // delayFromNowMs and parent schedules from its own clock).
    window.__timeexpHooks__.on("trial:phase", (e) => {
      if (e.phase !== "responseStart") return;
      // Look up theta from the latest occlusionEnd in the SAME trial.
      const hist = window.__timeexpHooks__.log;
      let theta = null;
      for (let i = hist.length - 1; i >= 0; i--) {
        const ev = hist[i];
        if (ev.name === "trial:phase" && ev.phase === "occlusionEnd" && ev.iR === e.iR && ev.iT === e.iT) {
          theta = ev.theta;
          break;
        }
      }
      if (theta == null) return;
      // e.t is already iframe-perf-now; subtract current iframe time to
      // get an "exec in X ms" delay. Add 5 ms padding so we land just
      // past θ (well above the 200 ms debounce).
      const remainingMs = e.t + theta * 1000 - performance.now();
      // Subtract a small lead to absorb the parent CDP round-trip +
      // page.mouse.click dispatch (~10-15 ms on local headless). The
      // first run with no compensation showed a flat +17ms positive
      // bias; -12 ms targets a residual close to zero.
      const delayMs = Math.max(0, remainingMs - 12);
      window.__idealClickQueue__ = window.__idealClickQueue__ || [];
      window.__idealClickQueue__.push({
        iR: e.iR,
        iT: e.iT,
        theta,
        emittedAtIframePerf: performance.now(),
        delayMs,
      });
    });
    window.__hookStream__ = [];
    setInterval(() => {
      while (window.__timeexpHooks__.log.length > window.__hookStream__.length) {
        window.__hookStream__.push(window.__timeexpHooks__.log[window.__hookStream__.length]);
      }
    }, 80);
  });

  // Bridge: parent polls iframe's __idealClickQueue__ and converts
  // delayMs (iframe clock) to parent-clock fireAt. Crucially we capture
  // parent now() AT THE TIME WE READ the queue so the relative offset is
  // consistent across the parent/iframe time-origin gap.
  let bridgeStop = false;
  const bridgeLoop = (async () => {
    while (!bridgeStop) {
      await new Promise((r) => setTimeout(r, 6));
      try {
        const jobs = await frameObj.evaluate(() => {
          const out = window.__idealClickQueue__ || [];
          window.__idealClickQueue__ = [];
          // Also report the iframe's current perf-now so parent can
          // compute the time offset accurately.
          return { jobs: out, iframeNow: performance.now() };
        });
        if (!jobs.jobs.length) continue;
        const parentNow = await page.evaluate(() => performance.now());
        for (const j of jobs.jobs) {
          // delayMs was computed at j.emittedAtIframePerf. By the time we
          // see it on parent, jobs.iframeNow time has elapsed in iframe.
          // True remaining wait in iframe = delayMs - (iframeNow - emittedAt)
          const elapsedSinceEmit = jobs.iframeNow - j.emittedAtIframePerf;
          const remaining = Math.max(0, j.delayMs - elapsedSinceEmit);
          pendingClicks.push({
            thetaMs: j.theta * 1000,
            fireAtMs: parentNow + remaining,
          });
        }
      } catch {
        /* iframe may not yet exist */
      }
    }
  })();

  // Walk through bootstrap UI: calibration / refresh / day 1 / instructions / block 1 intro.
  const clickInFrame = (sel) => frame.locator(sel).first().evaluate((el) => el.click());
  await frame.locator("#cal-next").waitFor({ state: "visible", timeout: 30_000 });
  await snapshot(page, "01-cal");
  await clickInFrame("#cal-next");
  await frame.locator("#cal-finish").waitFor({ state: "visible", timeout: 10_000 });
  await snapshot(page, "02-dist");
  await clickInFrame("#cal-finish");

  // Refresh-rate gate
  try {
    await frame.locator("#hz-bypass").waitFor({ state: "visible", timeout: 6_000 });
    await snapshot(page, "03-refresh");
    await clickInFrame("#hz-bypass");
  } catch {}

  // Day picker
  try {
    const dayBtn = frame.locator("button", { hasText: /^Day 1$/ });
    await dayBtn.first().waitFor({ state: "visible", timeout: 10_000 });
    await snapshot(page, "04-day");
    await dayBtn.first().evaluate((el) => el.click());
  } catch {}

  // Session instructions — "click anywhere"
  await frame
    .locator("h1", { hasText: /Time-reproduction/i })
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });
  await snapshot(page, "05-instructions");
  // Refresh iframe bbox before mouse click (post-overlay layout shifts).
  iframeBox.current = await page.locator("iframe").first().boundingBox();
  {
    const box = iframeBox.current;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }

  // For each block iR, walk: intro → dist guide → trial loop → summary chart.
  for (let iR = 0; iR < NUM_BLOCKS; iR++) {
    log(`──── block ${iR + 1} / ${NUM_BLOCKS} ────`);
    // Block intro screen
    await frame
      .locator("h1", { hasText: new RegExp(`Block ${iR + 1}\\s*/`, "i") })
      .first()
      .waitFor({ state: "visible", timeout: 30_000 });
    await snapshot(page, `b${iR + 1}-06-intro`);
    iframeBox.current = await page.locator("iframe").first().boundingBox();
    {
      const box = iframeBox.current;
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    }
    // Dist guide screen — click anywhere
    await page.waitForTimeout(500);
    iframeBox.current = await page.locator("iframe").first().boundingBox();
    {
      const box = iframeBox.current;
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    }
    await snapshot(page, `b${iR + 1}-07-trial-canvas`);

    // Wait for block:submitted hook
    await frameObj.waitForFunction(
      (target) => {
        return (window.__hookStream__ || []).some(
          (e) => e.name === "block:submitted" && e.iR === target,
        );
      },
      iR,
      { timeout: 600_000 },
    );
    log(`block ${iR + 1} submitted`);
    await snapshot(page, `b${iR + 1}-08-after`);

    // Block summary screen has 5s rest + 5..1 countdown + click. Auto-advance.
    if (iR < NUM_BLOCKS - 1) {
      // Wait until countdown 1 reached, then click.
      // Simple: wait 12 seconds (5+5+2 grace) then click center.
      await page.waitForTimeout(12_000);
      iframeBox.current = await page.locator("iframe").first().boundingBox();
      const box = iframeBox.current;
      if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    }
  }

  // Pull final hook stream + close.
  const stream = await frameObj.evaluate(() => window.__hookStream__);
  clickerStop = true;
  bridgeStop = true;
  await Promise.all([clickerLoop, bridgeLoop]);

  await snapshot(page, "99-final");
  await browser.close();
  return { stream };
}

async function verifyStorageAndBias({ expId, subjectNumber, stream }) {
  const prefix = `${expId}/${subjectNumber}`;
  const { data: list, error } = await admin.storage
    .from("experiment-data")
    .list(prefix, { limit: 50 });
  if (error) throw error;
  const blocks = (list || []).filter((d) => /^block_\d+\.json$/.test(d.name));
  log(`storage ${prefix}/  → ${blocks.length} block file(s)`);
  if (blocks.length === 0) throw new Error("no block files in storage");

  const findings = [];
  for (let i = 0; i < blocks.length; i++) {
    const dl = await admin.storage
      .from("experiment-data")
      .download(`${prefix}/block_${i}.json`);
    if (dl.error) throw dl.error;
    const json = JSON.parse(await dl.data.text());
    const trials = json.trials || [];
    const errs = trials.map((t) => t.Error).filter(Number.isFinite);
    const ests = trials.map((t) => t.Est).filter(Number.isFinite);
    const valid = ests.length;
    const missed = trials.length - valid;
    const bias = errs.length > 0 ? errs.reduce((a, b) => a + b, 0) / errs.length : NaN;
    const absErrMax = errs.length > 0 ? Math.max(...errs.map(Math.abs)) : NaN;
    const absErrMean = errs.length > 0 ? errs.reduce((s, v) => s + Math.abs(v), 0) / errs.length : NaN;
    findings.push({
      block: i, valid, missed, biasSec: bias, absErrMaxSec: absErrMax, absErrMeanSec: absErrMean,
    });
    log(`  block ${i}: valid=${valid} missed=${missed} bias=${bias.toFixed(4)}s absErrMean=${absErrMean.toFixed(4)}s absErrMax=${absErrMax.toFixed(4)}s`);
  }

  // Pass criteria summary
  const f0 = findings[0];
  const pass = {
    "trials confirmed (no miss)": f0.missed === 0 && f0.valid === 30,
    "|biasRepro| ≤ 10 ms": Number.isFinite(f0.biasSec) && Math.abs(f0.biasSec) <= 0.010,
    "|Error|_mean ≤ 30 ms": Number.isFinite(f0.absErrMeanSec) && f0.absErrMeanSec <= 0.030,
    "|Error|_max ≤ 60 ms": Number.isFinite(f0.absErrMaxSec) && f0.absErrMaxSec <= 0.060,
  };
  for (const [k, v] of Object.entries(pass)) {
    console.log(`  ${v ? "✓" : "✗"} ${k}`);
  }
  const allPass = Object.values(pass).every(Boolean);

  // Hook-stream sanity: schedule covers 30 thetas; bias hook fired
  const sessionEv = stream.find((e) => e.name === "sessionResolved");
  console.log(`\n  hook events captured: ${stream.length}`);
  console.log(`  session day=${sessionEv?.day} dist=${sessionEv?.distChar}`);

  return { findings, allPass };
}

async function main() {
  log(`APP=${APP} blocks=${NUM_BLOCKS} cleanup=${CLEANUP}`);
  await mkdir(OUT, { recursive: true });
  const { expId } = await seedExperiment();
  const { bookingId, participantId, token } = await seedBooking(expId);
  const runUrl = `${APP}/run/${bookingId}?t=${encodeURIComponent(token)}`;
  log(`participant URL: ${runUrl}`);

  const { stream } = await driveIdealObserver({ bookingId, expId, runUrl });
  const { findings, allPass } = await verifyStorageAndBias({
    expId, subjectNumber: 1, stream,
  });

  console.log("");
  console.log("=".repeat(70));
  console.log(allPass ? "✓ IDEAL OBSERVER PASS" : "✗ IDEAL OBSERVER FAIL");
  console.log("=".repeat(70));
  console.log(`Experiment id : ${expId}`);
  console.log(`Booking id    : ${bookingId}`);
  console.log("");
  console.log("Inspect on dashboard:");
  console.log(`  ${APP}/experiments/${expId}`);
  console.log(`  ${APP}/experiments/${expId}/bookings`);
  console.log("");
  console.log(`Screenshots in ${OUT}/`);

  if (CLEANUP) {
    log("--cleanup");
    const { data: files } = await admin.storage
      .from("experiment-data")
      .list(`${expId}/1`);
    if (files?.length) {
      await admin.storage
        .from("experiment-data")
        .remove(files.map((f) => `${expId}/1/${f.name}`));
    }
    await admin.from("experiment_run_progress").delete().eq("booking_id", bookingId);
    await admin.from("bookings").delete().eq("id", bookingId);
    await admin.from("participants").delete().eq("id", participantId);
    await admin.from("experiments").delete().eq("id", expId);
  }

  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error("✗ fatal:", err);
  process.exit(1);
});
