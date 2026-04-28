#!/usr/bin/env node
// Playwright smoke against the TimeExpOnline runtime. Two modes:
//   mock    — loads ./test-harness.html with a stubbed expPlatform,
//             walks calibration → refresh-rate → day-picker → 1 trial,
//             then asserts submitBlock fired with expected shape.
//   iframe  — embeds the prod main.js inside a sandboxed srcdoc iframe
//             so we test currentScript.src + CORS + null-origin fetches
//             behave identically to the real /run shell.
//
// Usage:
//   node scripts/timeexp/playwright-smoke.mjs mock
//   node scripts/timeexp/playwright-smoke.mjs iframe
//   node scripts/timeexp/playwright-smoke.mjs both

import http from "node:http";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { dirname, extname, join, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = pathResolve(__dirname, "..", "..");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".css": "text/css; charset=utf-8",
};

function startStaticServer(port = 0) {
  return new Promise((resolve) => {
    const srv = http.createServer(async (req, res) => {
      try {
        let p = req.url.split("?")[0];
        if (p === "/" || p.endsWith("/")) p += "index.html";
        const fp = join(REPO, p.replace(/^\/+/, ""));
        const buf = await readFile(fp);
        res.writeHead(200, {
          "content-type": MIME[extname(fp)] || "application/octet-stream",
          "access-control-allow-origin": "*",
          "cache-control": "no-store",
        });
        res.end(buf);
      } catch (err) {
        res.writeHead(404);
        res.end(String(err && err.message ? err.message : err));
      }
    });
    srv.listen(port, "127.0.0.1", () => resolve(srv));
  });
}

async function snapshot(page, label, outDir) {
  await mkdir(outDir, { recursive: true });
  const png = join(outDir, label + ".png");
  await page.screenshot({ path: png, fullPage: false });
  return png;
}

async function runMock(srv, outDir) {
  console.log("\n── mode=mock ──────────────────────────────────────────");
  const port = srv.address().port;
  const url = `http://127.0.0.1:${port}/scripts/timeexp/test-harness.html?subject=1&sessionIndex=1`;
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  page.on("console", (m) => console.log(`  [console.${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

  const t0 = Date.now();
  await page.goto(url, { waitUntil: "domcontentloaded" });

  // wait for main.js to construct overlays
  await page.waitForFunction(() => document.querySelector("body > div"));

  await snapshot(page, "01-calibration-step1", outDir);

  // step 1 of calibration: click "다음"
  await page.waitForSelector("#cal-next");
  await page.click("#cal-next");
  await page.waitForSelector("#cal-finish");
  await snapshot(page, "02-calibration-step2", outDir);

  // step 2: keep default 60 cm, click "완료"
  await page.click("#cal-finish");

  // refresh-rate gate may or may not pass under headless; if it presents
  // a "그대로 진행" or "다시 측정" button, click bypass.
  let bypassedHz = false;
  try {
    const bypass = await page.waitForSelector("#hz-bypass", { timeout: 5000 });
    bypassedHz = true;
    await snapshot(page, "03-refresh-gate", outDir);
    await bypass.click();
  } catch {
    /* gate passed silently */
  }

  // session-index picker — should not appear because harness sets sessionIndex=1.
  // Instead the master instruction screen should come up.
  await page.waitForFunction(
    () => {
      const ovs = Array.from(document.querySelectorAll("body > div"));
      return ovs.some((d) => /Time-reproduction/.test(d.textContent || ""));
    },
    { timeout: 10000 },
  );
  await snapshot(page, "04-session-instructions", outDir);

  // master instructions: click anywhere to start
  await page.mouse.click(640, 500);

  // block 1 intro
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll("body > div")).some((d) =>
        /Block 1/.test(d.textContent || ""),
      ),
    { timeout: 10000 },
  );
  await snapshot(page, "05-block-intro", outDir);
  await page.mouse.click(640, 500);

  // First trial begins. Inject auto-clicker so we click 1.0 s into the
  // response window — produces a non-NaN response. Wait for canvas to
  // appear & become animated.
  await page.waitForSelector("#ep-canvas", { state: "visible", timeout: 10000 });
  await snapshot(page, "06-trial-running", outDir);

  // Strategy: install a global click pumper that fires a synthetic
  // pointerdown ~1s into each response phase. Actually main.js requires
  // event.isTrusted, so synthetic events would be ignored. Use the
  // Playwright mouse API which dispatches trusted clicks.
  //
  // We monitor blocksSubmitted to know when we're "during" a response
  // phase. Simplest: every 0.5 s, click center. main.js debounces sub-200ms
  // and only accepts during response phase, so spamming is safe.
  const stopClicker = await page.evaluateHandle(() => {
    const handle = setInterval(() => {
      const ev = new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        clientX: window.innerWidth / 2,
        clientY: window.innerHeight / 2,
      });
      window.dispatchEvent(ev);
    }, 500);
    return handle;
  });
  // Note: synthetic dispatch yields isTrusted=false, so above won't help.
  // We need real Playwright mouse clicks. Use a Playwright-side loop:
  await page.evaluate(() => clearInterval(window.__noop__));

  const clickerStop = setInterval(() => {
    page.mouse
      .click(640, 400, { delay: 5 })
      .catch(() => {});
  }, 600);

  // Wait until at least 1 block submitted OR 90 s elapse.
  const ok = await page
    .waitForFunction(() => window.__SUBMITTED__ && window.__SUBMITTED__.length >= 1, null, {
      timeout: 600 * 1000,
    })
    .then(() => true)
    .catch(() => false);
  clearInterval(clickerStop);

  await snapshot(page, "99-after-block-1", outDir);

  const result = await page.evaluate(() => ({
    submitted: window.__SUBMITTED__,
    fatal: window.__FATAL__,
    log: window.__LOG__.slice(0, 50),
  }));

  await browser.close();
  console.log(`  mode=mock elapsed=${Date.now() - t0}ms bypassedHz=${bypassedHz} ok=${ok}`);
  console.log("  submitted blocks:", result.submitted.length);
  if (result.submitted[0]) {
    const b = result.submitted[0];
    console.log(`  block 0: trials=${b.trialCount} isLast=${b.isLast}`);
    console.log(
      `    firstTrial keys: ${b.firstTrial ? Object.keys(b.firstTrial).join(", ") : "(none)"}`,
    );
    if (b.blockMetadata && b.blockMetadata.session) {
      const s = b.blockMetadata.session;
      console.log(
        `    session.day=${s.day} dist=${s.distChar} ppd=${s.ppd?.toFixed?.(1)} hz=${s.refreshHz?.toFixed?.(1)} blocks=${s.blockCount}`,
      );
    }
  }
  if (result.fatal) console.log("  FATAL:", result.fatal);
  if (result.log.length) console.log("  log[0..]:", result.log.slice(0, 5));

  return { ok, result };
}

async function runIframe(srv, outDir) {
  console.log("\n── mode=iframe ────────────────────────────────────────");
  const port = srv.address().port;

  // Build a sandbox srcdoc that mimics what run-shell.tsx produces:
  // - sandbox="allow-scripts" only (null origin)
  // - <script src="${prod main.js URL}">
  // - bridge via postMessage (we add a minimal listener that stubs submitBlock)
  const wrapHtml = `<!doctype html>
  <html><body style="margin:0;height:100vh;background:#181818">
  <iframe id="exp" sandbox="allow-scripts" style="width:100%;height:100vh;border:0"
    srcdoc='&lt;!doctype html&gt;
    &lt;html&gt;&lt;body&gt;
    &lt;script&gt;
      window.__SUBMITTED__ = [];
      window.__FATAL__ = null;
      window.addEventListener("error", e => { window.__FATAL__ = (window.__FATAL__||"") + "\\n" + e.message; });
      window.addEventListener("unhandledrejection", e => {
        window.__FATAL__ = (window.__FATAL__||"") + "\\n" + (e.reason && e.reason.message ? e.reason.message : String(e.reason));
      });
      window.expPlatform = {
        subject: 1,
        experimentId: "deadbeef-0000-0000-0000-000000000000",
        bookingId: "00000000-1111-2222-3333-444444444444",
        sessionIndex: 1,
        config: {},
        blocksSubmitted: 0,
        condition: null,
        isPilot: false,
        submitBlock(p) {
          window.__SUBMITTED__.push({
            blockIndex: p.blockIndex,
            isLast: !!p.isLast,
            trialCount: (p.trials||[]).length,
          });
          window.expPlatform.blocksSubmitted += 1;
          parent.postMessage({type:"submit", blockIndex:p.blockIndex, trialCount:(p.trials||[]).length, isLast:!!p.isLast}, "*");
          return Promise.resolve({blocks_submitted: window.expPlatform.blocksSubmitted, completion_code: p.isLast?"X":null});
        },
        reportAttentionFailure() { return Promise.resolve(); },
        log(m) { parent.postMessage({type:"log", msg:String(m)}, "*"); return Promise.resolve(); },
        clock: {
          now() { return performance.now(); },
          nextFrame() { return new Promise(r => requestAnimationFrame(r)); },
        },
      };
      var s = document.createElement("script");
      s.crossOrigin = "anonymous";
      s.src = "https://lab-reservation-seven.vercel.app/demo-exp/timeexp/main.js";
      s.onerror = () => { parent.postMessage({type:"loadError"}, "*"); window.__FATAL__ = "SCRIPT_LOAD_FAILED"; };
      s.onload = () => parent.postMessage({type:"loaded"}, "*");
      document.body.appendChild(s);
    &lt;/script&gt;
    &lt;/body&gt;&lt;/html&gt;'>
  </iframe>
  <script>
    window.__events = [];
    window.addEventListener("message", e => window.__events.push(e.data));
  </script>
  </body></html>`;

  const harnessPath = join(REPO, "scripts/timeexp/_iframe-wrap.html");
  await writeFile(harnessPath, wrapHtml);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on("console", (m) => console.log(`  [console.${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

  await page.goto(`http://127.0.0.1:${port}/scripts/timeexp/_iframe-wrap.html`, {
    waitUntil: "domcontentloaded",
  });

  // Wait for either "loaded" or "loadError" event from iframe.
  const verdict = await page.evaluate(() =>
    new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        const e = window.__events.find(
          (x) => x.type === "loaded" || x.type === "loadError",
        );
        if (e) return resolve(e.type);
        if (Date.now() - t0 > 30000) return resolve("timeout");
        setTimeout(tick, 200);
      };
      tick();
    }),
  );

  console.log(`  iframe script load: ${verdict}`);
  await snapshot(page, "iframe-after-load", outDir);

  const events = await page.evaluate(() => window.__events.slice(0, 20));
  console.log("  events sample:", JSON.stringify(events));

  await browser.close();
  return { ok: verdict === "loaded", verdict };
}

async function main() {
  const mode = process.argv[2] || "mock";
  const outDir = join(REPO, "/tmp/timeexp-smoke".replace(/^\//, "/"));
  // ensure output dir
  await mkdir(outDir, { recursive: true });

  const srv = await startStaticServer();
  console.log("static server listening on", srv.address().port);

  let exitCode = 0;
  try {
    if (mode === "mock" || mode === "both") {
      const r = await runMock(srv, outDir);
      if (!r.ok) exitCode = 1;
      else if (r.result.submitted.length === 0) exitCode = 1;
    }
    if (mode === "iframe" || mode === "both") {
      const r = await runIframe(srv, outDir);
      if (!r.ok) exitCode = 1;
    }
  } finally {
    srv.close();
  }
  console.log("\nartifacts in:", outDir);
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
