// TimeExpOnline1_demo — web port of main_duration.m (Exp1, reproduction-only)
//
// Source paradigm: /Volumes/CSNL_new/people/JOP/Magnitude/Experiment/main_duration.m
// In-lab MATLAB version stays the canonical pipeline. This file is a
// faithful behavioural twin for online deployment ONLY — never co-mingle
// data with TimeExp1.
//
// Loaded by the lab platform's /run shell as the iframe entry_url. Talks
// to the parent via window.expPlatform (see docs/online-experiment-designer-guide.md).
//
// Decisions captured (per-question references in docs/timeexp-online1-demo.md):
//   Q1=A  visual-angle calibration via credit-card widget at session start
//   Q2    60 Hz strict — abort if measured refresh < 50 Hz or > 80 Hz
//   Q3    record vsync timestamps; analyst filters trials post-hoc
//   Q4=B  schedule deterministic per bookingId via mulberry32(SHA-256-prefix)
//         and shipped in block 0 metadata for analyst convenience
//   Q5    1 experiment × 5 sessions; sessionIndex from EP.sessionIndex if
//         present else asked at start
//   Q6    save schedule + seed; drop texture handles + UI internals
//   Q7=A  pre-rendered hi-res guide PNG (dist_guide_{U,A,B}.png)
//   Q8    Supabase persistence handled by EP.submitBlock; NAS sync is a
//         separate cron (see scripts/timeexp/backup-to-nas.mjs)

(function () {
  "use strict";

  // The lab platform iframe is sandboxed via srcdoc → no `<base>` set,
  // so relative URLs would resolve against `about:srcdoc` and 404.
  // Capture our own script's URL synchronously (before any await) so
  // all later fetches/image src strings are absolute.
  const SCRIPT_BASE = (function () {
    const s = document.currentScript;
    if (s && s.src) {
      const u = new URL(s.src);
      return u.origin + u.pathname.replace(/\/[^/]+$/, "/");
    }
    // Defensive fallback — should never fire when loaded via entry_url.
    return "https://lab-reservation-seven.vercel.app/demo-exp/timeexp/";
  })();

  // ───────────────────────────────────────── lifecycle guard
  const EP = window.expPlatform;
  if (!EP) {
    document.body.innerHTML =
      '<p style="padding:24px;color:#555">Load this via the experiment runtime (/run/[bookingId]).</p>';
    return;
  }

  // ───────────────────────────────────────── instrumentation hooks (harness)
  // Public, documented surface for test harnesses + analyst tooling.
  // Each named hook fires once per occurrence with a payload object that
  // captures the salient state at that moment. Listeners attached via
  // `__timeexpHooks__.on(name, fn)` from a parent or from the same iframe
  // (no isTrusted requirement) — synchronous; do NOT do heavy work in a
  // listener or you'll smear the timing measurement you came to inspect.
  //
  // Lifecycle (every listener payload contains `t` = performance.now()):
  //   bootstrap                — { subjectNum, bookingId, sessionIndex }
  //   calibration:done         — { pxPerDeg, distanceCm, pxPerCm }
  //   refreshGate:result       — { fps, ok, bypassed, sampleCount }
  //   sessionResolved          — { day, distChar, source }
  //   scheduleGenerated        — { seed, blocks, totalRetries }
  //   sessionInstructions:done — { distChar, day }
  //   block:start              — { iR, totalBlocks, runtimeStartMs }
  //   trial:phase              — { iR, iT, phase, t, theta, ... }
  //                               phase ∈ { cueStart, vm1Start, occlusionStart,
  //                                         occlusionEnd, vm2Start, cue2Start,
  //                                         vm3Start, responseStart,
  //                                         responseClick (or responseTimeout),
  //                                         feedbackStart, feedbackEnd,
  //                                         itiStart, itiEnd }
  //   trial:saved              — { iR, iT, record }
  //   block:bias               — { iR, biasRepro, valid, missed }
  //   block:submitted          — { iR, blockIndex, isLast, retryAttempts }
  //   block:summary:done       — { iR }
  //   visibility:change        — { hidden, t }
  //   error                    — { phase, error }
  //   completed                — { totalBlocks }
  //
  // The parent (run-shell) doesn't subscribe today; harness mode (Playwright
  // mock + e2e) does. Listeners die with the iframe.
  const __hooks__ = (function () {
    const listeners = new Map();
    function on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
      return () => {
        const arr = listeners.get(name) || [];
        const i = arr.indexOf(fn);
        if (i >= 0) arr.splice(i, 1);
      };
    }
    function emit(name, payload) {
      const stamped = Object.assign({ t: performance.now(), name }, payload || {});
      // Always push to the ring buffer first — analyst/harness scrapes
      // this even when no subscribers are attached.
      __hooksLog__.push(stamped);
      if (__hooksLog__.length > 4000) __hooksLog__.shift();
      const arr = listeners.get(name);
      if (!arr || arr.length === 0) return;
      // Synchronous fan-out; defensive try/catch so a buggy listener doesn't
      // kill the experiment.
      for (const fn of arr) {
        try {
          fn(stamped);
        } catch (err) {
          console.error("[hook listener]", name, err);
        }
      }
    }
    return { on, emit };
  })();
  const __hooksLog__ = [];
  // Expose to window so Playwright + analyst tooling can subscribe.
  window.__timeexpHooks__ = { on: __hooks__.on, log: __hooksLog__ };

  // ───────────────────────────────────────── constants matching MATLAB
  const C = {
    // timing (s) — from param_TrialRunTime_Duration.m
    tprecue: 0.3,
    testimate: 2.5,
    tfeedback: 1.0,
    lentrial: 7.7,

    // distribution range (s)
    THETA_LO: 0.6,
    THETA_HI: 1.6,

    // 15-level rho grid 0.01:0.07:0.99 (length 15)
    RHO_GRID: Array.from({ length: 15 }, (_, i) => 0.01 + 0.07 * i),

    // canonical refresh rate the MATLAB version assumes
    REFRESH_HZ: 60,
    IFI: 1 / 60,

    // visual geometry (from param_StimFixDisplay_Duration)
    RING_OUTER_DEG: 5,
    RING_WIDTH_DEG: 1, // inner radius = 4 deg
    BULLSEYE_OUTER_DEG: 0.75,
    BULLSEYE_INNER_DEG: 0.2,
    BAR_LENGTH_DEG: 1, // bar height = pxPerDeg
    BAR_WIDTH_FACTOR: 1 / 10, // bar width = pxPerDeg / 10
    APERTURE_RADIUS_DEG: 4.5,

    // schedule — from StimGenerator_Duration.m
    BLOCKS_DAY_1: 10,
    BLOCKS_DAYS_2_5: 12,
    TRIALS_PER_BLOCK: 30,
    TVM1_LO: 0.3,
    TVM1_HI: 0.8,
    TVM2_TOTAL: 1.1, // tvm2 = TVM2_TOTAL - tvm1
    TVM3_LO: 0.3,
    TVM3_HI: 0.8,
    OCC_DEG_LO: 0.8,
    OCC_DEG_HI: 2.0,
    SCHEDULE_MAX_RETRIES: 50,

    // colours (RGB) — match param_StimFixDisplay_Duration.m
    col_dg: [3, 150, 96],
    col_probe: [230, 230, 230], // 255*0.9
    col_white: [166, 166, 166], // 255*0.65
    col_red: [178, 18, 18], // 255*[1,0.1,0.1]*0.7
    col_blue: [36, 36, 178], // 255*[0.2,0.2,1]*0.7
    col_grey: [102, 102, 102], // 255*0.4
    col_yellow: [102, 102, 0], // 255*[1,1,0]*0.4
    col_black: [26, 26, 26], // 255*0.1 → round-half-up
    // MATLAB `par.grey = par.white * lum2colorcode(0.03)`. With sRGB γ≈2.2,
    // colorcode = 255 × 0.03^(1/2.2) ≈ 49. Was 8 (linear interpretation),
    // visible as ~30× darker than MATLAB. Now matches MATLAB display.
    backgroundLum: 0.03,
    BACKGROUND_GREY: Math.round(255 * Math.pow(0.03, 1 / 2.2)), // 49
    // col_red and col_blue rounded half-up to match MATLAB framebuffer
    // (was [178,18,18] and [36,36,178]; now [179,18,18] and [36,36,179]).
  };
  // Patch col_red / col_blue to round-half-up (matches MATLAB framebuffer).
  C.col_red = [179, 18, 18];
  C.col_blue = [36, 36, 179];

  // gradient blue→red, 100 steps (col_grad)
  const COL_GRAD = (() => {
    const out = [];
    for (let i = 0; i < 100; i++) {
      const t = i / 99;
      out.push([Math.round(t * 255), 0, Math.round((1 - t) * 255)]);
    }
    return out;
  })();

  // ───────────────────────────────────────── tiny utilities
  function rgb(c) {
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }
  function deg2rad(d) {
    return (d * Math.PI) / 180;
  }
  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }
  function modPos(a, m) {
    return ((a % m) + m) % m;
  }
  function median(arr) {
    const s = [...arr].sort((a, b) => a - b);
    const n = s.length;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }
  function linspace(a, b, n) {
    if (n <= 1) return [a];
    const step = (b - a) / (n - 1);
    return Array.from({ length: n }, (_, i) => a + step * i);
  }
  function shuffle(arr, rng) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  function permIndex(n, rng) {
    return shuffle(
      Array.from({ length: n }, (_, i) => i),
      rng,
    );
  }
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
  function nextFrame() {
    return new Promise((r) => requestAnimationFrame(r));
  }
  // SHA-256 → uint32 prefix, async (uses SubtleCrypto). Used to seed PRNG.
  async function uint32FromString(s) {
    const data = new TextEncoder().encode(s);
    const buf = await crypto.subtle.digest("SHA-256", data);
    const view = new DataView(buf);
    return view.getUint32(0, false) >>> 0;
  }
  // mulberry32 — same algorithm jsPsych ships when seeded; small + fast.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // standard normal pdf, used only for distribution-guide axis hint
  function normPdf(z) {
    return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
  }

  // ───────────────────────────────────────── DOM scaffolding
  document.body.style.margin = "0";
  document.body.style.padding = "0";
  document.body.style.background = "#181818";
  document.body.style.overflow = "hidden";
  document.body.style.fontFamily = "system-ui, -apple-system, Arial, sans-serif";
  document.body.style.color = "#eee";
  document.body.innerHTML = "";

  const root = document.createElement("div");
  root.id = "ep-root";
  Object.assign(root.style, {
    position: "fixed",
    inset: "0",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  });
  document.body.appendChild(root);

  const canvas = document.createElement("canvas");
  canvas.id = "ep-canvas";
  Object.assign(canvas.style, { display: "none", touchAction: "none" });
  root.appendChild(canvas);
  const ctx = canvas.getContext("2d", { alpha: false });

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener("resize", resizeCanvas);

  function clearCanvas(bgGrey) {
    const w = window.innerWidth,
      h = window.innerHeight;
    // Default to gamma-corrected MATLAB par.grey (≈49). Callers may
    // override for special states but should rarely need to.
    const g = typeof bgGrey === "number" ? bgGrey : C.BACKGROUND_GREY;
    ctx.fillStyle = `rgb(${g},${g},${g})`;
    ctx.fillRect(0, 0, w, h);
  }

  // ───────────────────────────────────────── overlay helpers (text screens)
  function makeOverlay() {
    const ov = document.createElement("div");
    Object.assign(ov.style, {
      position: "fixed",
      inset: "0",
      background: "#181818",
      color: "#f0f0f0",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      padding: "32px",
      boxSizing: "border-box",
      textAlign: "center",
      zIndex: "10",
      lineHeight: "1.55",
    });
    document.body.appendChild(ov);
    return ov;
  }
  function showText(html) {
    const ov = makeOverlay();
    ov.innerHTML = html;
    return ov;
  }
  function waitForClick(target = window) {
    return new Promise((resolve) => {
      const handler = (e) => {
        if (!e.isTrusted) return;
        target.removeEventListener("pointerdown", handler);
        resolve(e.timeStamp);
      };
      target.addEventListener("pointerdown", handler, { once: false });
    });
  }

  // ───────────────────────────────────────── visual-angle calibration (Q1=A)
  // Credit-card widget. Participant drags the right edge of an on-screen
  // rectangle until it physically matches a real ISO/IEC 7810 ID-1 card
  // (85.60 × 53.98 mm) held against the screen. From card-px we get
  // pxPerCm; combined with self-reported viewing distance (default 60 cm)
  // we get pxPerDeg ≈ pxPerCm × distance × tan(1°).
  async function runCalibration() {
    const stored = readStoredCalib();
    if (stored) {
      // Don't auto-trust persisted values across sessions of the demo —
      // ask whether to re-use. Keeps the calibration step honest while
      // not punishing repeat participants.
      const reuse = await confirmReuseCalib(stored);
      if (reuse) return stored;
    }
    const ppd = await calibrationFlow();
    persistCalib(ppd);
    return ppd;
  }

  function readStoredCalib() {
    // Sandboxed iframe (no allow-same-origin) → localStorage is empty
    // every session. We use sessionStorage which is per-iframe-lifetime;
    // good enough for "don't recalibrate after a refresh". If even that
    // fails (Safari strict mode), we silently re-run.
    try {
      const v = window.sessionStorage.getItem("ep:timeexp:ppd");
      if (!v) return null;
      const obj = JSON.parse(v);
      if (typeof obj.pxPerDeg === "number" && obj.pxPerDeg > 5) return obj;
    } catch {
      /* noop */
    }
    return null;
  }
  function persistCalib(obj) {
    try {
      window.sessionStorage.setItem("ep:timeexp:ppd", JSON.stringify(obj));
    } catch {
      /* noop */
    }
  }

  async function confirmReuseCalib(prev) {
    return new Promise((resolve) => {
      const ov = makeOverlay();
      ov.innerHTML = `
        <h2 style="margin:0 0 16px;font-size:22px;">화면 캘리브레이션</h2>
        <p style="max-width:540px">
          이전에 사용한 캘리브레이션 값이 남아있습니다
          (1° = ${prev.pxPerDeg.toFixed(1)} px,
          시야 거리 ${prev.distanceCm} cm).<br>
          그대로 사용하시겠습니까?
        </p>
        <div style="display:flex;gap:16px;margin-top:24px">
          <button id="reuse-y" style="padding:10px 24px;font-size:16px">예, 그대로</button>
          <button id="reuse-n" style="padding:10px 24px;font-size:16px">아니오, 다시</button>
        </div>`;
      ov.querySelector("#reuse-y").addEventListener("click", () => {
        ov.remove();
        resolve(true);
      });
      ov.querySelector("#reuse-n").addEventListener("click", () => {
        ov.remove();
        resolve(false);
      });
    });
  }

  function calibrationFlow() {
    return new Promise((resolve) => {
      const ov = makeOverlay();
      ov.style.justifyContent = "flex-start";
      ov.innerHTML = `
        <h2 style="margin:24px 0 8px;font-size:22px;">화면 캘리브레이션 (1/2)</h2>
        <p style="max-width:600px;margin:0 0 16px;font-size:14px">
          신용카드 또는 학생증을 화면에 대고, 아래 사각형의 오른쪽 가장자리를
          드래그하여 카드의 가로 길이와 정확히 같게 맞춰 주세요.<br>
          <span style="opacity:0.7">표준 카드: 가로 8.56 cm × 세로 5.398 cm.</span>
        </p>
        <div id="card-area" style="position:relative;background:#fff;border-radius:6px;
              height:53.98vh;max-height:280px;width:85.60vh;max-width:444px;
              box-shadow:0 0 0 2px #444 inset"></div>
        <p style="margin-top:16px;font-size:13px;opacity:0.7">
          카드 길이가 사각형 가로와 정확히 일치하면 다음 단계로 넘어가세요.
        </p>
        <div style="display:flex;gap:12px;margin-top:18px">
          <button id="cal-next" style="padding:10px 24px;font-size:16px">다음</button>
        </div>`;

      const cardArea = ov.querySelector("#card-area");
      // Make it resizable horizontally only via right-edge drag.
      cardArea.style.cursor = "ew-resize";
      let dragging = false;
      let startX = 0;
      let startW = 0;

      cardArea.addEventListener("pointerdown", (e) => {
        const rect = cardArea.getBoundingClientRect();
        if (e.clientX < rect.right - 24) return; // only right-edge grab zone
        dragging = true;
        startX = e.clientX;
        startW = rect.width;
        cardArea.setPointerCapture(e.pointerId);
      });
      cardArea.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const newW = Math.max(120, startW + (e.clientX - startX));
        cardArea.style.width = newW + "px";
        // maintain card aspect 85.60 / 53.98
        cardArea.style.height = (newW * 53.98) / 85.6 + "px";
      });
      cardArea.addEventListener("pointerup", () => {
        dragging = false;
      });

      ov.querySelector("#cal-next").addEventListener("click", () => {
        const cardWidthPx = cardArea.getBoundingClientRect().width;
        const cardWidthCm = 8.56;
        const pxPerCm = cardWidthPx / cardWidthCm;

        // ─── step 2: viewing distance
        ov.innerHTML = `
          <h2 style="margin:24px 0 8px;font-size:22px;">화면 캘리브레이션 (2/2)</h2>
          <p style="max-width:600px;margin:0 0 16px;font-size:14px">
            얼굴-화면 거리를 측정해 주세요. 측정이 어려우면 권장값(60 cm)을
            그대로 두셔도 좋습니다. 의자 위치/팔 길이 정도가 60 cm입니다.
          </p>
          <label style="font-size:18px">
            거리 (cm):
            <input id="cal-dist" type="number" value="60" min="20" max="200"
                   style="font-size:18px;width:120px;padding:6px;text-align:center">
          </label>
          <div style="display:flex;gap:12px;margin-top:18px">
            <button id="cal-finish" style="padding:10px 24px;font-size:16px">완료</button>
          </div>`;
        ov.querySelector("#cal-finish").addEventListener("click", () => {
          const distInput = ov.querySelector("#cal-dist");
          const distanceCm = clamp(parseFloat(distInput.value || "60") || 60, 20, 200);
          // pxPerDeg = pxPerCm × cmPerDeg = pxPerCm × distance × tan(1°)
          const pxPerDeg = pxPerCm * distanceCm * Math.tan(Math.PI / 180);
          ov.remove();
          resolve({
            pxPerDeg,
            pxPerCm,
            distanceCm,
            cardWidthPx,
            measuredAt: new Date().toISOString(),
          });
        });
      });
    });
  }

  // ───────────────────────────────────────── refresh-rate gate (Q2)
  // Sample 90 frames; fail if median FPS outside [50, 80] (i.e. not 60 Hz).
  // We don't try to "synthesise" 60 Hz on a 144 Hz monitor — instructing the
  // participant to set their display to 60 Hz is the cleaner path for a
  // demo run; data quality matters more than completion rate.
  async function ensureRefreshRate60() {
    const samples = [];
    let lastTs = await nextFrame();
    for (let i = 0; i < 90; i++) {
      const ts = await nextFrame();
      const dt = ts - lastTs;
      if (dt > 0 && dt < 200) samples.push(dt);
      lastTs = ts;
    }
    samples.sort((a, b) => a - b);
    const med = samples[Math.floor(samples.length / 2)] || 16.67;
    const fps = 1000 / med;
    const ok = fps >= 50 && fps <= 80;
    return { fps, ok, sampleCount: samples.length, medianMs: med };
  }

  async function refreshRateGate() {
    const result = await ensureRefreshRate60();
    if (result.ok) return result;
    // Block hard with retry path.
    return new Promise((resolve) => {
      const ov = makeOverlay();
      ov.innerHTML = `
        <h2 style="color:#ffb46e;margin:0 0 12px">디스플레이 주사율 안내</h2>
        <p style="max-width:600px">
          현재 화면 주사율 측정값: <b>${result.fps.toFixed(1)} Hz</b>.
          이 실험은 <b>60 Hz</b> 모니터를 가정합니다.<br>
          시스템 환경설정에서 디스플레이 주사율을 60 Hz로 설정한 뒤
          다시 측정해 주세요.
        </p>
        <div style="display:flex;gap:12px;margin-top:18px">
          <button id="hz-retry" style="padding:10px 24px;font-size:16px">다시 측정</button>
          <button id="hz-bypass" style="padding:10px 24px;font-size:16px;opacity:0.6">
            그대로 진행 (데이터 품질 ↓)
          </button>
        </div>`;
      ov.querySelector("#hz-retry").addEventListener("click", async () => {
        ov.remove();
        const r = await refreshRateGate();
        resolve(r);
      });
      ov.querySelector("#hz-bypass").addEventListener("click", () => {
        ov.remove();
        resolve({ ...result, bypassed: true });
      });
    });
  }

  // ───────────────────────────────────────── session-index resolution (Q5)
  async function resolveSessionIndex() {
    if (typeof EP.sessionIndex === "number" && EP.sessionIndex >= 1 && EP.sessionIndex <= 5) {
      return { day: EP.sessionIndex, source: "platform" };
    }
    return new Promise((resolve) => {
      const ov = makeOverlay();
      ov.innerHTML = `
        <h2 style="margin:0 0 12px">오늘은 며칠째 세션입니까?</h2>
        <p style="max-width:520px;font-size:14px;opacity:0.85">
          이 실험은 5일 연속 진행됩니다. 어제까지 몇 차례 진행했는지에 따라
          오늘이 몇 번째 세션인지 선택해 주세요. 가능하면 매일 같은 시각에
          진행해 주세요.
        </p>
        <div style="display:flex;gap:12px;margin-top:24px">
          ${[1, 2, 3, 4, 5]
            .map(
              (d) =>
                `<button data-day="${d}" style="padding:14px 22px;font-size:18px">Day ${d}</button>`,
            )
            .join("")}
        </div>`;
      ov.querySelectorAll("button").forEach((btn) =>
        btn.addEventListener("click", () => {
          ov.remove();
          resolve({ day: Number(btn.dataset.day), source: "self-report" });
        }),
      );
    });
  }

  // ───────────────────────────────────────── distribution rule (matches exp_info_duration.m)
  function distForSession(subjNum, day) {
    if (day === 1) return "U";
    const patList = ["AABB", "ABBA", "BABA", "BBAA"];
    const pat = patList[subjNum % 4];
    const ch = pat[day - 2];
    return ch; // 'A' or 'B'
  }
  // Internal numeric code 1=U, 2=A (=L-skew), 3=B (=R-skew) — same as MATLAB.
  function distCode(distChar) {
    return distChar === "U" ? 1 : distChar === "A" ? 2 : 3;
  }

  // ───────────────────────────────────────── stimulus-distribution loader
  async function loadStimulusJson() {
    const url = SCRIPT_BASE + "stimulus_30.json";
    const res = await fetch(url, { cache: "force-cache" });
    if (!res.ok) throw new Error(`stimulus_30.json fetch ${res.status}`);
    return res.json();
  }
  // Matches StimGenerator_Duration_total.m: sort ascending, pick 15 quantile-spaced.
  function quantile15(samples) {
    const sorted = [...samples].sort((a, b) => a - b);
    const n = sorted.length;
    const out = [];
    for (let i = 1; i <= 15; i++) {
      // round(linspace(1, n, 15))[i-1], MATLAB 1-indexed
      const idx = Math.round(1 + ((n - 1) * (i - 1)) / 14);
      out.push(sorted[idx - 1]);
    }
    return out;
  }

  // ───────────────────────────────────────── schedule generator (port of StimGenerator_Duration.m)
  function generateBlockSchedule(rng, distChar, stmDist15) {
    const distSel = distCode(distChar);
    const nT = C.TRIALS_PER_BLOCK;

    // Base = 15 quantiles repeated to fill nT (15 × repN).
    const repN = Math.max(1, Math.round(nT / 15));
    const base = [];
    const baseIdx = [];
    for (let r = 0; r < repN; r++) {
      for (let i = 0; i < 15; i++) {
        base.push(stmDist15[i]);
        baseIdx.push(i + 1); // 1..15
      }
    }
    if (base.length < nT) {
      throw new Error(`stmDist15 only yields ${base.length} trials (need ${nT})`);
    }

    for (let attempt = 0; attempt < C.SCHEDULE_MAX_RETRIES; attempt++) {
      const order = permIndex(base.length, rng);
      const thetasShuf = order.map((i) => base[i]);
      const idxLabelsShuf = order.map((i) => baseIdx[i]);

      const Stm = thetasShuf.slice(0, nT);
      const thetaLabel = idxLabelsShuf.slice(0, nT);
      const Stm_pr = thetaLabel.map((tl) => C.RHO_GRID[tl - 1]);

      // Feedback assignment (matches MATLAB switch).
      const feedback = new Array(nT).fill(0);
      const idxMean = 8;
      const idxCenter = distSel === 2 ? 5 : distSel === 3 ? 11 : 8;
      const pickAt = (label) => {
        const out = [];
        for (let i = 0; i < nT; i++) if (thetaLabel[i] === label) out.push(i);
        return out;
      };
      const pickMean = pickAt(idxMean);
      pickMean.forEach((i) => (feedback[i] = 1));
      if (distSel === 1) {
        const p5 = pickAt(5);
        const p11 = pickAt(11);
        if (p5.length > 0) feedback[p5[Math.floor(rng() * p5.length)]] = 1;
        if (p11.length > 0) feedback[p11[Math.floor(rng() * p11.length)]] = 1;
      } else {
        pickAt(idxCenter).forEach((i) => (feedback[i] = 1));
      }

      // Per-trial parameters via permuted linspaces.
      const tvm1Vals = linspace(C.TVM1_LO, C.TVM1_HI, nT);
      const tvm1 = permIndex(nT, rng).map((i) => tvm1Vals[i]);
      const tvm2 = tvm1.map((t) => C.TVM2_TOTAL - t);
      const tvm3Vals = linspace(C.TVM3_LO, C.TVM3_HI, nT);
      const tvm3 = permIndex(nT, rng).map((i) => tvm3Vals[i]);
      const occVals = linspace(C.OCC_DEG_LO, C.OCC_DEG_HI, nT);
      const occ_deg = permIndex(nT, rng).map((i) => occVals[i]);

      const speed1 = occ_deg.map((od, i) => od / Stm[i]);
      const speed2Med = median(speed1);
      const speed2 = new Array(nT).fill(speed2Med);

      const startVals = linspace(0, 2 * Math.PI, nT);
      const start1 = permIndex(nT, rng).map((i) => startVals[i]);
      const start2 = permIndex(nT, rng).map((i) => startVals[i]);

      const half = Math.floor(nT / 2);
      const dirsBase = [
        ...new Array(nT - half).fill(+1),
        ...new Array(half).fill(-1),
      ];
      const dir1 = permIndex(nT, rng).map((i) => dirsBase[i]);
      const dir2 = permIndex(nT, rng).map((i) => dirsBase[i]);

      const end1 = start1.map((s, i) => s + dir1[i] * speed1[i] * tvm1[i]);
      const occl_end = end1.map((e, i) => e + dir1[i] * speed1[i] * Stm[i]);

      // Reproduction-only seed=0; derived guard from MATLAB for length sanity.
      const tmaxArr = Stm.map(
        (theta, i) =>
          C.tprecue +
          tvm1[i] +
          theta +
          tvm2[i] +
          C.tprecue +
          tvm3[i] +
          C.testimate +
          C.tfeedback,
      );
      const tmax = Math.max(...tmaxArr);
      if (tmax <= C.lentrial) {
        return {
          Stm,
          thetaLabel,
          Stm_pr,
          feedback,
          tvm1,
          tvm2,
          tvm3,
          occ_deg,
          speed1,
          speed2,
          start1,
          start2,
          dir1,
          dir2,
          end1,
          occl_end,
          seed: new Array(nT).fill(0),
          attempts: attempt + 1,
        };
      }
    }
    // MATLAB falls through with a warning at attempt 50; we mirror.
    throw new Error("schedule generation exceeded max retries (tmax > lentrial)");
  }

  function generateAllSchedules(rng, distChar, stmDist15, day) {
    const nBlocks = day === 1 ? C.BLOCKS_DAY_1 : C.BLOCKS_DAYS_2_5;
    const blocks = [];
    for (let r = 0; r < nBlocks; r++) {
      blocks.push(generateBlockSchedule(rng, distChar, stmDist15));
    }
    return blocks;
  }

  // ───────────────────────────────────────── drawing primitives
  // background ring + bullseye, sized in CSS pixels relative to current ppd.
  // Mirrors my_ring_aperture_bullseye(par.irect, 5, 1, ppd, [0,0,0],
  // grey/255, 0.75, [0,0,0], 0.2) — for miss state the ring + bullseye
  // turn yellow but the cross-gap is still the background grey (matches
  // MATLAB tex_arc_miss).
  function drawArcBackground(ppd, options = {}) {
    const w = window.innerWidth,
      h = window.innerHeight;
    const cx = w / 2,
      cy = h / 2;
    clearCanvas(C.BACKGROUND_GREY); // gamma-corrected ~49

    const outer = ppd * C.RING_OUTER_DEG;
    const inner = ppd * (C.RING_OUTER_DEG - C.RING_WIDTH_DEG);
    const ringColor = options.miss ? rgb(C.col_yellow) : "rgb(0,0,0)";
    ctx.fillStyle = ringColor;
    ctx.beginPath();
    ctx.arc(cx, cy, outer, 0, 2 * Math.PI);
    ctx.arc(cx, cy, inner, 0, 2 * Math.PI, true);
    ctx.fill("evenodd");

    // Bullseye outer (0.75°). MATLAB clips the cross-gap to inside the
    // outer disk; we approximate by drawing the disk first, then drawing
    // the cross-gap rects clipped to the same disk via canvas clip().
    const fixOuter = ppd * C.BULLSEYE_OUTER_DEG;
    const fixInner = ppd * C.BULLSEYE_INNER_DEG;
    const bullColor = options.miss ? rgb(C.col_yellow) : "rgb(0,0,0)";
    ctx.fillStyle = bullColor;
    ctx.beginPath();
    ctx.arc(cx, cy, fixOuter, 0, 2 * Math.PI);
    ctx.fill();

    // Cross-gap: "+" of background grey clipped to the outer disk so it
    // never bleeds past the bullseye edge (MATLAB mask: `r <= r_outer`).
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, fixOuter, 0, 2 * Math.PI);
    ctx.clip();
    ctx.fillStyle = `rgb(${C.BACKGROUND_GREY},${C.BACKGROUND_GREY},${C.BACKGROUND_GREY})`;
    ctx.fillRect(cx - fixInner, cy - fixOuter, 2 * fixInner, 2 * fixOuter);
    ctx.fillRect(cx - fixOuter, cy - fixInner, 2 * fixOuter, 2 * fixInner);
    ctx.restore();

    // Inner dot (0.2°): black or yellow on miss, covers cross intersection.
    ctx.fillStyle = bullColor;
    ctx.beginPath();
    ctx.arc(cx, cy, fixInner, 0, 2 * Math.PI);
    ctx.fill();
  }

  function drawBar(angle, color, scale = 1) {
    const w = window.innerWidth,
      h = window.innerHeight;
    const cx = w / 2,
      cy = h / 2;
    // Ported from sub/draw_bar.m
    const radiusPx = ppd * C.APERTURE_RADIUS_DEG;
    const widthPx = ppd * C.BAR_WIDTH_FACTOR;
    const heightPx = ppd * C.BAR_LENGTH_DEG;
    const x = radiusPx * Math.cos(angle);
    const y = radiusPx * Math.sin(angle);
    const theta = angle - Math.PI / 2;
    const cosT = Math.cos(theta),
      sinT = Math.sin(theta);

    const corners = [
      [-widthPx / 2, -heightPx / 2],
      [widthPx / 2, -heightPx / 2],
      [widthPx / 2, heightPx / 2],
      [-widthPx / 2, heightPx / 2],
    ].map(([rx, ry]) => [
      cx + x + scale * (rx * cosT - ry * sinT),
      cy + y + scale * (rx * sinT + ry * cosT),
    ]);

    ctx.fillStyle = rgb(color);
    ctx.beginPath();
    ctx.moveTo(corners[0][0], corners[0][1]);
    for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i][0], corners[i][1]);
    ctx.closePath();
    ctx.fill();
  }

  function drawArcSegment(startAngle, arcLength, color) {
    const w = window.innerWidth,
      h = window.innerHeight;
    const cx = w / 2,
      cy = h / 2;
    const radiusPx = ppd * C.APERTURE_RADIUS_DEG;
    const rOut = radiusPx + ppd * 0.5;
    const rIn = radiusPx - ppd * 0.5;
    ctx.fillStyle = rgb(color);
    ctx.beginPath();
    ctx.arc(cx, cy, rOut, startAngle, startAngle + arcLength, arcLength < 0);
    ctx.arc(cx, cy, rIn, startAngle + arcLength, startAngle, arcLength >= 0);
    ctx.closePath();
    ctx.fill();
  }

  function drawArcGradient(angle1, angle2) {
    const nSteps = COL_GRAD.length;
    const w = window.innerWidth,
      h = window.innerHeight;
    const cx = w / 2,
      cy = h / 2;
    const radiusPx = ppd * C.APERTURE_RADIUS_DEG;
    const rOut = radiusPx + ppd * 0.5;
    const rIn = radiusPx - ppd * 0.5;
    const step = (angle2 - angle1) / nSteps;
    for (let i = 0; i < nSteps; i++) {
      ctx.fillStyle = rgb(COL_GRAD[i]);
      const t1 = angle1 + step * i;
      const t2 = angle1 + step * (i + 1);
      ctx.beginPath();
      ctx.arc(cx, cy, rOut, t1, t2);
      ctx.arc(cx, cy, rIn, t2, t1, true);
      ctx.closePath();
      ctx.fill();
    }
  }

  // ───────────────────────────────────────── trial state machine (port of Duration_Occlusion.m)
  let ppd = 60; // overwritten after calibration
  let measuredRefreshHz = 60; // overwritten by refresh-rate gate
  function activeIfiMs() {
    // 1000/REFRESH_HZ MS, derived from whatever the refresh-rate gate
    // actually measured. Defaults to 60 Hz baseline if not yet measured.
    const hz = Number.isFinite(measuredRefreshHz) && measuredRefreshHz > 30
      ? measuredRefreshHz
      : 60;
    return 1000 / hz;
  }

  // Visibility / focus loss tracking. Start a single page-level listener
  // once and accumulate (start, end) pairs into hiddenSpans so per-trial
  // analysis can flag any phase that overlapped a hidden window.
  const hiddenSpans = [];
  let hiddenStart = null;
  document.addEventListener("visibilitychange", () => {
    const t = performance.now();
    if (document.hidden) {
      hiddenStart = t;
      __hooks__.emit("visibility:change", { hidden: true, t });
    } else if (hiddenStart != null) {
      hiddenSpans.push([hiddenStart, t]);
      __hooks__.emit("visibility:change", { hidden: false, t, spanMs: t - hiddenStart });
      hiddenStart = null;
    }
  });
  function trialHiddenMs(t0, t1) {
    let acc = 0;
    for (const [a, b] of hiddenSpans) {
      const lo = Math.max(t0, a);
      const hi = Math.min(t1, b);
      if (hi > lo) acc += hi - lo;
    }
    if (hiddenStart != null && t1 > hiddenStart) {
      acc += Math.min(t1, performance.now()) - Math.max(t0, hiddenStart);
    }
    return acc;
  }

  function expPlatformLog(...args) {
    if (typeof EP.log === "function") EP.log(args.map(String).join(" "));
  }

  async function runTrial(iR, iT, sched, runtimeStartMs) {
    const theta = sched.Stm[iT];
    const dir1 = sched.dir1[iT];
    const dir2 = sched.dir2[iT];
    const speed1 = sched.speed1[iT];
    const speed2 = sched.speed2[iT];
    const start1 = sched.start1[iT];
    const start2 = sched.start2[iT];
    const tvm1 = sched.tvm1[iT];
    const tvm2 = sched.tvm2[iT];
    const tvm3 = sched.tvm3[iT];
    const occl_end = sched.occl_end[iT];
    const doFeedback = sched.feedback[iT] === 1;

    // Active ifi for deadline arithmetic. Defaults to 60 Hz frame
    // duration (16.67 ms) but if the refresh-rate gate measured a
    // different median we honour that — keeps `WaitSecs UntilTime ±ifi`
    // semantics correct on non-60 Hz screens that bypassed the gate.
    const IFI_MS = activeIfiMs();

    // vbl_start equivalent — captured BEFORE the first nextFrame() wait
    // so we mirror MATLAB's `tstart = GetSecs` at the top of the trial.
    const vblStart = EP.clock.now();
    __hooks__.emit("trial:phase", {
      iR, iT, phase: "trialStart", theta, doFeedback, vblStart,
    });

    // Trial-end target (anchored to runtime start so missed responses don't
    // drift the schedule — matches MATLAB tend = prev tend + lentrial).
    const tend = runtimeStartMs + (iT + 1) * C.lentrial * 1000;

    // === Phase 1: cue + vm1 ===
    const tCueOnset = await EP.clock.nextFrame();
    __hooks__.emit("trial:phase", { iR, iT, phase: "cueStart", t: tCueOnset });
    while (true) {
      const t = EP.clock.now();
      if (t >= tCueOnset + C.tprecue * 1000 - IFI_MS) break;
      drawArcBackground(ppd);
      drawBar(start1, C.col_white);
      await nextFrame();
    }

    const vm1Start = EP.clock.now();
    __hooks__.emit("trial:phase", { iR, iT, phase: "vm1Start", t: vm1Start });
    const vm1End = tCueOnset + C.tprecue * 1000 + tvm1 * 1000;
    while (true) {
      const t = EP.clock.now();
      if (t >= vm1End - IFI_MS) break;
      const f = (t - tCueOnset - C.tprecue * 1000) / (tvm1 * 1000);
      const a = start1 + dir1 * speed1 * tvm1 * f;
      drawArcBackground(ppd);
      drawBar(a, C.col_white);
      await nextFrame();
    }

    // === Phase 2: occlusion (theta) ===
    // MATLAB uses `WaitSecs('UntilTime', vbl_occlu1 + theta - ifi)` to
    // overshoot by less than one frame. Our previous version waited the
    // full theta which biased the occluded interval up by ~1 frame.
    const tOcclOnset = await EP.clock.nextFrame();
    __hooks__.emit("trial:phase", { iR, iT, phase: "occlusionStart", t: tOcclOnset });
    drawArcBackground(ppd);
    while (true) {
      const t = EP.clock.now();
      if (t >= tOcclOnset + theta * 1000 - IFI_MS) break;
      drawArcBackground(ppd);
      await nextFrame();
    }
    const tOcclEnd = EP.clock.now();
    const occluDurObserved = (tOcclEnd - tOcclOnset) / 1000;
    __hooks__.emit("trial:phase", {
      iR, iT, phase: "occlusionEnd", t: tOcclEnd, occluDurObserved, theta,
    });

    // === Phase 3: vm2 ===
    __hooks__.emit("trial:phase", { iR, iT, phase: "vm2Start", t: tOcclEnd });
    const vm2End = tOcclEnd + tvm2 * 1000;
    while (true) {
      const t = EP.clock.now();
      if (t >= vm2End - IFI_MS) break;
      const f = (t - tOcclEnd) / (tvm2 * 1000);
      const a = occl_end + dir1 * speed1 * tvm2 * f;
      drawArcBackground(ppd);
      drawBar(a, C.col_white);
      await nextFrame();
    }

    // === Phase 4: cue2 ===
    const tCue2Onset = await EP.clock.nextFrame();
    __hooks__.emit("trial:phase", { iR, iT, phase: "cue2Start", t: tCue2Onset });
    while (true) {
      const t = EP.clock.now();
      if (t >= tCue2Onset + C.tprecue * 1000 - IFI_MS) break;
      drawArcBackground(ppd);
      drawBar(start2, C.col_dg);
      await nextFrame();
    }

    // === Phase 4-2: vm3 ===
    __hooks__.emit("trial:phase", { iR, iT, phase: "vm3Start" });
    const vm3End = tCue2Onset + C.tprecue * 1000 + tvm3 * 1000;
    while (true) {
      const t = EP.clock.now();
      if (t >= vm3End - IFI_MS) break;
      const f = (t - tCue2Onset - C.tprecue * 1000) / (tvm3 * 1000);
      const a = start2 + dir2 * speed2 * tvm3 * f;
      drawArcBackground(ppd);
      drawBar(a, C.col_dg);
      await nextFrame();
    }
    const startAngle = modPos(start2 + dir2 * speed2 * tvm3, 2 * Math.PI);

    // === Phase 5: response (click → reproduced duration) ===
    // MATLAB anchors `vbl_respOnset = GetSecs` immediately after the last
    // vm3 flip; the previous JS port waited an extra `nextFrame()` here
    // which shifted response onset by ~1 frame. Use clock.now() to match.
    const tRespOnset = EP.clock.now();
    __hooks__.emit("trial:phase", { iR, iT, phase: "responseStart", t: tRespOnset });
    let confirm = false;
    let response = NaN;
    let responseAngle = NaN;
    let ierror = NaN;
    let RT = NaN;
    let tClick = NaN;

    let pendingClick = null;
    const clickHandler = (e) => {
      if (!e.isTrusted) return;
      // event.timeStamp is on the same DOMHighResTimeStamp epoch as
      // performance.now(), so direct subtraction with tRespOnset is valid.
      pendingClick = e.timeStamp;
    };
    window.addEventListener("pointerdown", clickHandler, { passive: true });

    while (true) {
      const t = EP.clock.now();
      const elapsedMs = t - tRespOnset;
      if (elapsedMs >= C.testimate * 1000) {
        __hooks__.emit("trial:phase", { iR, iT, phase: "responseTimeout", t });
        break;
      }
      drawArcBackground(ppd);
      await nextFrame();
      if (pendingClick !== null) {
        tClick = pendingClick;
        const respSec = (tClick - tRespOnset) / 1000;
        // MATLAB Duration_Occlusion.m:125-131 — debounce <0.2s clicks
        // by treating them as a miss AND breaking out of the loop.
        // (Previous JS port kept polling, which let participants tap
        // twice and "rescue" a bouncy click. Now matches MATLAB.)
        if (respSec > 0.2) {
          response = respSec;
          responseAngle = dir2 * speed2 * response;
          ierror = response - theta;
          RT = response;
          confirm = true;
          __hooks__.emit("trial:phase", {
            iR, iT, phase: "responseClick", t: tClick, response, ierror,
          });
        } else {
          response = NaN;
          ierror = NaN;
          RT = NaN;
          tClick = NaN;
          confirm = false;
          __hooks__.emit("trial:phase", {
            iR, iT, phase: "responseDebounced", t: pendingClick, respSec,
          });
        }
        break;
      }
    }
    window.removeEventListener("pointerdown", clickHandler);

    // === Phase 6: feedback ===
    if (doFeedback) {
      // Trial gets feedback (== iTrainTest=2 in MATLAB).
      if (confirm) {
        __hooks__.emit("trial:phase", { iR, iT, phase: "feedbackStart", confirm: true });
        const trueAngle = modPos(startAngle + dir2 * speed2 * theta, 2 * Math.PI);
        const respAngleAbs = modPos(startAngle + responseAngle, 2 * Math.PI);
        const errAngle = dir2 * speed2 * ierror;

        // Step 6a: response trace shown for 0.25 s.
        drawArcBackground(ppd);
        drawArcSegment(startAngle, responseAngle, C.col_white);
        drawBar(respAngleAbs, C.col_dg, 1.2);
        await sleepUntil(EP.clock.now() + (0.25 * 1000 - IFI_MS));

        // Step 6b: error visualization for remaining 0.75 s.
        drawArcBackground(ppd);
        if (ierror > 0) {
          // Over-shoot: white trajectory to truth, red over-extension.
          drawArcSegment(startAngle, dir2 * speed2 * theta, C.col_white);
          drawArcSegment(trueAngle, errAngle, C.col_red);
        } else {
          drawArcSegment(startAngle, responseAngle, C.col_white);
          drawArcSegment(trueAngle, errAngle, C.col_blue);
        }
        await sleepUntil(EP.clock.now() + ((C.tfeedback - 0.25) * 1000 - IFI_MS));
      } else {
        __hooks__.emit("trial:phase", { iR, iT, phase: "feedbackStart", confirm: false });
        drawArcBackground(ppd, { miss: true });
        await sleepUntil(EP.clock.now() + (C.tfeedback * 1000 - IFI_MS));
      }
    } else {
      // No-feedback trials (MATLAB iTrainTest=3): show response bar only.
      if (confirm) {
        __hooks__.emit("trial:phase", { iR, iT, phase: "feedbackStart", noFeedback: true, confirm: true });
        const respAngleAbs = modPos(startAngle + responseAngle, 2 * Math.PI);
        drawArcBackground(ppd);
        drawBar(respAngleAbs, C.col_dg);
        await sleepUntil(EP.clock.now() + (C.tfeedback * 1000 - IFI_MS));
      } else {
        __hooks__.emit("trial:phase", { iR, iT, phase: "feedbackStart", noFeedback: true, confirm: false });
        drawArcBackground(ppd, { miss: true });
        await sleepUntil(EP.clock.now() + (C.tfeedback * 1000 - IFI_MS));
      }
    }
    __hooks__.emit("trial:phase", { iR, iT, phase: "feedbackEnd", t: EP.clock.now() });

    // === Phase 7: ITI — hold arc background until tend.
    __hooks__.emit("trial:phase", { iR, iT, phase: "itiStart" });
    drawArcBackground(ppd);
    await sleepUntil(tend);
    const tendActual = EP.clock.now();
    __hooks__.emit("trial:phase", { iR, iT, phase: "itiEnd", t: tendActual });

    const tHiddenMs = trialHiddenMs(vblStart, tendActual);
    const record = {
      block_index: iR,
      trial_index: iT,
      Stm: theta,
      Stm_pr: sched.Stm_pr[iT],
      thetaLabel: sched.thetaLabel[iT],
      feedback: doFeedback ? 1 : 0,
      seed: 0, // reproduction-only
      tvm1,
      tvm2,
      tvm3,
      occ_deg: sched.occ_deg[iT],
      speed1,
      speed2,
      start1,
      start2,
      dir1,
      dir2,
      end1: sched.end1[iT],
      occl_end,
      // Response & error
      Est: response,
      ResponseAngle: confirm ? startAngle + responseAngle : NaN,
      Error: ierror,
      RT,
      response_isTrusted: confirm,
      // Timing
      vbl_start: vblStart,
      vbl_cue: tCueOnset,
      vbl_occlu: tOcclOnset,
      vbl_occlu_end: tOcclEnd,
      occlu_dur_observed: occluDurObserved,
      vbl_cue2: tCue2Onset,
      vbl_respOnset: tRespOnset,
      vbl_resp: confirm ? tClick : NaN,
      tend: tendActual,
      tend_target: tend,
      // visibility / focus integrity
      hidden_ms: tHiddenMs,
      hidden_flag: tHiddenMs > 0,
      // covariates
      dpr: window.devicePixelRatio || 1,
      inner_w: window.innerWidth,
      inner_h: window.innerHeight,
      ifi_ms: IFI_MS,
    };
    __hooks__.emit("trial:saved", { iR, iT, record });
    return record;
  }

  // Sleep until performance.now() reaches a target time. Uses RAF coalescing
  // so we don't busy-wait; gives sub-frame accuracy on 60 Hz displays.
  async function sleepUntil(targetMs) {
    while (true) {
      const t = EP.clock.now();
      if (t >= targetMs) return t;
      await nextFrame();
    }
  }

  // ───────────────────────────────────────── instruction screens
  function instructionsAtSessionStart(distChar, day, totalBlocks) {
    return new Promise((resolve) => {
      const ov = makeOverlay();
      const guideUrl = `${SCRIPT_BASE}dist_guide_${distChar}.png`;
      ov.style.justifyContent = "flex-start";
      ov.style.padding = "24px";
      ov.innerHTML = `
        <h1 style="margin:8px 0 4px;font-size:24px">Time-reproduction (Day ${day}/5)</h1>
        <p style="max-width:720px;margin:8px 0;font-size:15px;opacity:0.9">
          링 안쪽에서 막대가 한 번 회전한 뒤 사라집니다 (가려진 시간 = θ).
          잠시 후 두 번째 회전이 시작되면 <b>가려진 시간만큼 기다린 뒤
          한 번 클릭</b>해 그 길이를 재현해 주세요.
        </p>
        <ul style="max-width:720px;margin:0 0 12px;font-size:14px;opacity:0.85;text-align:left">
          <li>총 ${totalBlocks}개 블록 × 30 트라이얼. 한 트라이얼은 약 8초.</li>
          <li>일부 트라이얼에는 정답 피드백이 붙습니다.</li>
          <li>창을 다른 데로 옮기면 자동으로 기록됩니다 (해당 트라이얼은 분석에서 제외될 수 있어요).</li>
          <li>실험 중에는 가능한 한 같은 자세·같은 거리를 유지해 주세요.</li>
          <li>편의를 위해 <kbd>F11</kbd> (윈도우) / <kbd>⌃⌘F</kbd> (맥)으로
              브라우저를 전체 화면으로 두면 좋습니다.</li>
        </ul>
        <p style="margin:8px 0 4px">오늘의 자극 분포 (Day ${day}, ${distChar}):</p>
        <img src="${guideUrl}" alt="dist guide ${distChar}"
             style="max-width:720px;width:60vw;height:auto;border:1px solid #444;background:#b3b3b3">
        <p style="margin:18px 0 6px">아무 곳이나 클릭하여 시작</p>`;
      const start = (e) => {
        if (!e.isTrusted) return;
        window.removeEventListener("pointerdown", start);
        ov.remove();
        resolve();
      };
      window.addEventListener("pointerdown", start);
    });
  }

  function blockIntroScreen(iR, totalBlocks, distChar) {
    // Two-screen flow mirroring instruction_Duration.m:23-33:
    //   (1) Block-N intro text → click → (2) dist-guide screen → click → trials.
    return new Promise(async (resolve) => {
      // Screen 1: block intro
      await new Promise((r) => {
        const ov = makeOverlay();
        ov.innerHTML = `
          <h1 style="margin:0 0 8px;font-size:24px">Block ${iR + 1} / ${totalBlocks}</h1>
          <p style="max-width:560px">
            <b>Reproduction task</b><br>
            가려진 시간(θ)을 클릭으로 재현하세요. 일부 트라이얼에는 정답 피드백이 표시됩니다.
          </p>
          <p style="margin-top:18px;opacity:0.7">아무 곳이나 클릭하여 계속</p>`;
        const start = (e) => {
          if (!e.isTrusted) return;
          window.removeEventListener("pointerdown", start);
          ov.remove();
          r();
        };
        window.addEventListener("pointerdown", start);
      });
      // Screen 2: dist-guide (matches instruction_Duration.m:32-33 every block).
      await new Promise((r) => {
        const ov = makeOverlay();
        const guideUrl = `${SCRIPT_BASE}dist_guide_${distChar}.png`;
        ov.style.padding = "32px";
        ov.innerHTML = `
          <p style="margin:0 0 12px;max-width:720px">
            In this experiment, stimuli will be sampled from a distribution with this shape.
          </p>
          <img src="${guideUrl}" alt="dist guide ${distChar}"
               style="max-width:760px;width:62vw;height:auto;border:1px solid #444;background:#b3b3b3">
          <p style="margin-top:16px;opacity:0.7">아무 곳이나 클릭하여 블록 시작</p>`;
        const start = (e) => {
          if (!e.isTrusted) return;
          window.removeEventListener("pointerdown", start);
          ov.remove();
          r();
        };
        window.addEventListener("pointerdown", start);
      });
      resolve();
    });
  }

  // Per-block summary screen: ports MATLAB Summary_Duration.m progress
  // panel (bias bar chart over up-to-12 blocks + stimulus dist + response
  // histogram). Followed by a 5-second mandatory rest, then a 5..1
  // countdown, then click-to-continue (instruction_Duration paradigm).
  function blockSummaryScreen(iR, totalBlocks, isLastBlock, biasReproSec, distChar, biasHistory, responseHistogramTrials) {
    return new Promise(async (resolve) => {
      // Step 1: bias chart + dist guide + response histogram screen.
      const summaryOv = await makeBiasChartOverlay({
        iR,
        totalBlocks,
        biasReproSec,
        biasHistory,
        distChar,
        responseHistogramTrials,
      });
      // Step 2: 5 s mandatory rest (MATLAB pause(par.trest=5)).
      await new Promise((r) => setTimeout(r, 5000));
      // Step 3: countdown 5..1.
      const cdEl = document.createElement("div");
      Object.assign(cdEl.style, {
        position: "absolute",
        left: "50%",
        bottom: "32px",
        transform: "translateX(-50%)",
        color: "#222",
        fontSize: "28px",
        fontWeight: "600",
      });
      summaryOv.appendChild(cdEl);
      for (let s = 5; s >= 1; s--) {
        cdEl.textContent = String(s);
        await new Promise((r) => setTimeout(r, 1000));
      }
      cdEl.textContent = "아무 곳이나 클릭하여 다음 블록 시작";
      cdEl.style.fontSize = "16px";
      cdEl.style.opacity = "0.85";
      // Step 4: wait for click. (Last block goes straight to goodbye.)
      if (isLastBlock) {
        await new Promise((r) => setTimeout(r, 1500));
        summaryOv.remove();
        resolve();
        return;
      }
      const click = (e) => {
        if (!e.isTrusted) return;
        window.removeEventListener("pointerdown", click);
        summaryOv.remove();
        resolve();
      };
      window.addEventListener("pointerdown", click);
    });
  }

  function makeBiasChartOverlay(args) {
    return new Promise((resolve) => {
      const { iR, totalBlocks, biasReproSec, biasHistory, distChar, responseHistogramTrials } = args;

      const ov = makeOverlay();
      ov.style.background = `rgb(${C.BACKGROUND_GREY},${C.BACKGROUND_GREY},${C.BACKGROUND_GREY})`;
      ov.style.color = "#111";
      ov.style.justifyContent = "flex-start";
      ov.style.padding = "24px";

      // Layout: title row, then two-panel grid (bias chart left / dist
      // guide + response histogram right).
      const w = window.innerWidth;
      const h = window.innerHeight;
      const biasYMin = -0.25;
      const biasYMax = 0.25;
      const xMaxBlock = 12;

      const biasCanvas = document.createElement("canvas");
      const histCanvas = document.createElement("canvas");
      // Render at DPR for HiDPI sharpness.
      const dpr = window.devicePixelRatio || 1;
      const panelW = Math.min(w * 0.42, 600);
      const panelH = Math.min(h * 0.45, 360);
      [biasCanvas, histCanvas].forEach((c) => {
        c.width = Math.round(panelW * dpr);
        c.height = Math.round(panelH * dpr);
        c.style.width = panelW + "px";
        c.style.height = panelH + "px";
        c.style.background = "rgba(255,255,255,0.85)";
        c.style.border = "1px solid #333";
      });
      const bctx = biasCanvas.getContext("2d");
      const hctx = histCanvas.getContext("2d");
      bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      hctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // ── Bias chart ──
      // Replicates draw_repro_progress_screen "Bias" panel: bar chart with
      // y-axis -0.25..+0.25, x-axis 1..12 blocks, dark-yellow bars (red if
      // outside ymax range), green zero-line.
      const padL = 50,
        padR = 16,
        padT = 30,
        padB = 36;
      const plotW = panelW - padL - padR;
      const plotH = panelH - padT - padB;
      const barColor = "rgb(180,120,20)";
      const outlierColor = "rgb(210,35,35)";
      bctx.fillStyle = "#111";
      bctx.font = "16px system-ui";
      bctx.fillText("Bias", padL, 20);
      // y ticks
      bctx.strokeStyle = "rgba(0,0,0,0.15)";
      bctx.fillStyle = "#444";
      bctx.font = "11px system-ui";
      for (let yt = -0.2; yt <= 0.2 + 1e-9; yt += 0.1) {
        const yy =
          padT + plotH - ((yt - biasYMin) / (biasYMax - biasYMin)) * plotH;
        bctx.beginPath();
        bctx.moveTo(padL, yy);
        bctx.lineTo(padL + plotW, yy);
        bctx.stroke();
        bctx.fillText(yt.toFixed(1), 8, yy + 4);
      }
      // bars
      const binW = plotW / xMaxBlock;
      const barW = binW * 0.42;
      const zeroY = padT + plotH - ((0 - biasYMin) / (biasYMax - biasYMin)) * plotH;
      for (let b = 0; b < xMaxBlock; b++) {
        const v = biasHistory[b];
        if (!Number.isFinite(v)) continue;
        const xc = padL + (b + 0.5) * binW;
        const x0 = xc - barW / 2;
        const x1 = xc + barW / 2;
        const clamped = Math.max(biasYMin, Math.min(biasYMax, v));
        const y =
          padT + plotH - ((clamped - biasYMin) / (biasYMax - biasYMin)) * plotH;
        const out = Math.abs(v) > biasYMax;
        bctx.fillStyle = out ? outlierColor : barColor;
        bctx.fillRect(
          x0,
          Math.min(zeroY, y),
          x1 - x0,
          Math.abs(zeroY - y),
        );
      }
      // zero line
      bctx.strokeStyle = "rgb(80,220,120)";
      bctx.lineWidth = 2;
      bctx.beginPath();
      bctx.moveTo(padL, zeroY);
      bctx.lineTo(padL + plotW, zeroY);
      bctx.stroke();
      // x ticks (block numbers)
      bctx.fillStyle = "#222";
      bctx.font = "11px system-ui";
      for (let b = 0; b < xMaxBlock; b++) {
        const xc = padL + (b + 0.5) * binW - 4;
        bctx.fillText(String(b + 1), xc, padT + plotH + 14);
      }
      bctx.fillText("Block", padL + plotW / 2 - 14, panelH - 6);

      // ── Response histogram ──
      // Replicates the bottom-right "Response" panel: aligned x-axis to
      // stimulus distribution (0.4..1.8), bins of 0.2 width, normalized
      // probability bars, with stimulus span [0.6..1.6] dotted-line guides.
      const xMin = 0.4,
        xMax = 1.8;
      const binEdges = [];
      for (let v = xMin; v <= xMax + 1e-9; v += 0.2) binEdges.push(v);
      const counts = new Array(binEdges.length - 1).fill(0);
      const valid = (responseHistogramTrials || []).filter((v) =>
        Number.isFinite(v),
      );
      for (const v of valid) {
        const idx = Math.max(
          0,
          Math.min(counts.length - 1, Math.floor((v - xMin) / 0.2)),
        );
        counts[idx] += 1;
      }
      const sum = counts.reduce((s, c) => s + c, 0);
      const probs = counts.map((c) => (sum > 0 ? c / sum : 0));
      const maxProb = Math.max(...probs, 1e-9);

      const hPadL = 50,
        hPadR = 16,
        hPadT = 30,
        hPadB = 36;
      const hPlotW = panelW - hPadL - hPadR;
      const hPlotH = panelH - hPadT - hPadB;
      hctx.fillStyle = "#111";
      hctx.font = "16px system-ui";
      hctx.fillText("Response", hPadL, 20);
      hctx.fillStyle = barColor;
      const hBinW = hPlotW / counts.length;
      for (let i = 0; i < counts.length; i++) {
        const x = hPadL + i * hBinW;
        const barH = (probs[i] / maxProb) * hPlotH;
        hctx.fillRect(x + hBinW * 0.05, hPadT + hPlotH - barH, hBinW * 0.9, barH);
      }
      // stimulus-span dotted vlines at 0.6 and 1.6
      hctx.strokeStyle = "rgb(140,140,140)";
      hctx.setLineDash([4, 4]);
      for (const v of [0.6, 1.6]) {
        const x = hPadL + ((v - xMin) / (xMax - xMin)) * hPlotW;
        hctx.beginPath();
        hctx.moveTo(x, hPadT);
        hctx.lineTo(x, hPadT + hPlotH);
        hctx.stroke();
      }
      hctx.setLineDash([]);
      // x ticks
      hctx.fillStyle = "#222";
      hctx.font = "11px system-ui";
      for (const v of [0.4, 0.6, 0.8, 1.0, 1.2, 1.4, 1.6, 1.8]) {
        const x = hPadL + ((v - xMin) / (xMax - xMin)) * hPlotW - 8;
        hctx.fillText(v.toFixed(1), x, hPadT + hPlotH + 14);
      }
      hctx.fillText("Reproduced θ (s)", hPadL + hPlotW / 2 - 40, panelH - 6);

      // Header + biasTxt
      const header = document.createElement("div");
      header.style.marginBottom = "6px";
      const biasNum = Number.isFinite(biasReproSec)
        ? `${biasReproSec >= 0 ? "+" : ""}${biasReproSec.toFixed(3)} s`
        : "(no responses)";
      header.innerHTML = `
        <h2 style="margin:0 0 4px;font-size:22px">Block ${iR + 1} / ${totalBlocks} — bias ${biasNum}</h2>
        <p style="margin:0;font-size:13px;opacity:0.75">5초 강제 휴식 후 카운트다운이 시작됩니다.</p>`;
      ov.appendChild(header);

      // 2x1 grid
      const grid = document.createElement("div");
      Object.assign(grid.style, {
        display: "flex",
        gap: "20px",
        margin: "12px 0",
        flexWrap: "wrap",
        justifyContent: "center",
      });
      grid.appendChild(biasCanvas);
      grid.appendChild(histCanvas);
      ov.appendChild(grid);

      resolve(ov);
    });
  }

  // ───────────────────────────────────────── top-level
  let participantSubject; // alias for clarity in logs
  let participantBookingId;

  async function main() {
    // Coerce subject to a finite integer; without this a stringified or
    // floating-point subject silently corrupts the dist-pattern formula
    // (mod 4 of "9" works but mod 4 of "abc" returns NaN).
    const subjNum = Math.trunc(Number(EP.subject));
    if (!Number.isFinite(subjNum) || subjNum < 0) {
      throw new Error(`EP.subject is not a non-negative integer: ${String(EP.subject)}`);
    }
    participantSubject = subjNum;
    participantBookingId = EP.bookingId;
    __hooks__.emit("bootstrap", {
      subjectNum: subjNum,
      bookingId: participantBookingId,
      sessionIndex: EP.sessionIndex ?? null,
    });

    // 1. Calibration → ppd
    const calib = await runCalibration();
    ppd = calib.pxPerDeg;
    __hooks__.emit("calibration:done", {
      pxPerDeg: calib.pxPerDeg,
      pxPerCm: calib.pxPerCm,
      distanceCm: calib.distanceCm,
    });

    // 2. Refresh-rate gate (60 Hz strict per Q2)
    const hzResult = await refreshRateGate();
    measuredRefreshHz = hzResult.fps;
    __hooks__.emit("refreshGate:result", {
      fps: hzResult.fps,
      ok: hzResult.ok,
      bypassed: !!hzResult.bypassed,
      sampleCount: hzResult.sampleCount,
    });

    // 3. Resolve session day (1..5)
    const sessionInfo = await resolveSessionIndex();
    const day = sessionInfo.day;
    const distChar = distForSession(subjNum, day);
    __hooks__.emit("sessionResolved", { day, distChar, source: sessionInfo.source });

    // 4. Load stimulus distribution → 15-quantile lookup
    const stimulus = await loadStimulusJson();
    const distKey = distChar === "U" ? "U" : distChar === "A" ? "L" : "R";
    const stmDist15 = quantile15(stimulus.samples[distKey]);

    // 5. Seed PRNG, generate full schedule
    const seedHex = await uint32FromString(participantBookingId);
    const rng = mulberry32(seedHex);
    const schedule = generateAllSchedules(rng, distChar, stmDist15, day);
    __hooks__.emit("scheduleGenerated", {
      seed: seedHex,
      blocks: schedule.length,
      totalRetries: schedule.reduce((s, b) => s + (b.attempts || 1) - 1, 0),
    });

    // Show canvas, hide all overlays.
    canvas.style.display = "block";
    resizeCanvas();
    clearCanvas(C.BACKGROUND_GREY);

    // 6. Master instructions
    await instructionsAtSessionStart(distChar, day, schedule.length);
    __hooks__.emit("sessionInstructions:done", { distChar, day });

    const sessionMeta = {
      experimentLabel: "TimeExpOnline1_demo",
      subjectNumber: participantSubject,
      bookingId: participantBookingId,
      day,
      distChar,
      distSourceQ: sessionInfo.source,
      ppd: calib.pxPerDeg,
      pxPerCm: calib.pxPerCm,
      distanceCm: calib.distanceCm,
      cardWidthPx: calib.cardWidthPx,
      calibAt: calib.measuredAt,
      refreshHz: hzResult.fps,
      refreshOk: !hzResult.bypassed && hzResult.ok,
      refreshSamples: hzResult.sampleCount,
      refreshBypassed: !!hzResult.bypassed,
      schedulePrngSeed: seedHex,
      scheduleAlgorithm: "mulberry32",
      paradigmVersion: "main_duration.m@2026-04-22",
      paradigmCommit: "main_duration.m ver.3 26.02.22",
      blockCount: schedule.length,
      trialsPerBlock: C.TRIALS_PER_BLOCK,
      schedule, // full pre-generated schedule (seed Q6: keep)
    };

    // Bias chart needs the cumulative history across blocks.
    const biasHistory = new Array(schedule.length).fill(NaN);

    // Block loop.
    for (let iR = 0; iR < schedule.length; iR++) {
      await blockIntroScreen(iR, schedule.length, distChar);

      const sched = schedule[iR];
      // tblockinit captured at top of block (after the intro screen
      // dismissed). Mirrors par.CurrentStims.tblockinit at
      // instruction_Duration.m:35.
      const tblockinit = EP.clock.now();
      __hooks__.emit("block:start", {
        iR, totalBlocks: schedule.length, tblockinit,
      });

      // Anchor `tend` chaining to the first trial's start, same as MATLAB.
      const runtimeStartMs = tblockinit;
      const trials = [];
      for (let iT = 0; iT < sched.Stm.length; iT++) {
        const tr = await runTrial(iR, iT, sched, runtimeStartMs);
        trials.push(tr);
        expPlatformLog(
          `R=${iR + 1}/${schedule.length} T=${iT + 1} Stm=${tr.Stm.toFixed(2)} Est=${
            Number.isFinite(tr.Est) ? tr.Est.toFixed(2) : "miss"
          } err=${Number.isFinite(tr.Error) ? tr.Error.toFixed(2) : "miss"}`,
        );
      }
      const blockend = EP.clock.now();

      // bias = signed mean error over valid (non-NaN) trials. Matches
      // Summary_Duration.m:34 (`sum(errors(idx0)/length(...))`).
      const validErr = trials.map((t) => t.Error).filter(Number.isFinite);
      const biasRepro =
        validErr.length > 0 ? validErr.reduce((s, v) => s + v, 0) / validErr.length : NaN;
      __hooks__.emit("block:bias", {
        iR, biasRepro, valid: validErr.length, missed: trials.length - validErr.length,
      });

      const blockMetadata = {
        block_index: iR,
        biasRepro,
        // Legacy NaN fields kept for downstream tooling parity with MATLAB
        // Summary_Duration.m:58-61 (these are explicitly NaN in the lab
        // pipeline; analyst recomputes from `Error`).
        sdErrRepro: null,
        varWithinStimRepro: null,
        logSlope: null,
        logR2: null,
        trialsValid: validErr.length,
        trialsMissed: trials.length - validErr.length,
        tblockinit,
        blockend,
        blockdur: blockend - tblockinit,
        // Only block 0 carries the full session meta to keep later blocks lean.
        ...(iR === 0 ? { session: sessionMeta } : {}),
      };

      let submitOk = false;
      let attempts = 0;
      while (!submitOk) {
        attempts += 1;
        try {
          await EP.submitBlock({
            blockIndex: iR,
            trials,
            blockMetadata,
            completedAt: new Date().toISOString(),
            isLast: iR === schedule.length - 1,
          });
          submitOk = true;
          __hooks__.emit("block:submitted", {
            iR, isLast: iR === schedule.length - 1, retryAttempts: attempts - 1,
          });
        } catch (err) {
          expPlatformLog(
            "submitBlock failed: " + (err && err.message ? err.message : String(err)),
          );
          if (attempts >= 3) {
            __hooks__.emit("error", {
              phase: "submitBlock", error: err && err.message ? err.message : String(err),
            });
            throw err;
          }
          const ov = makeOverlay();
          ov.innerHTML = `
            <h2>저장 실패</h2>
            <p>블록 ${iR + 1} 저장에 실패했습니다 (${
              err && err.message ? err.message : "unknown"
            }).<br>인터넷 연결을 확인한 뒤 클릭해 다시 시도해 주세요.</p>`;
          await waitForClick();
          ov.remove();
        }
      }

      biasHistory[iR] = biasRepro;
      const responseHistogramTrials = trials.map((t) => t.Est);
      await blockSummaryScreen(
        iR,
        schedule.length,
        iR === schedule.length - 1,
        biasRepro,
        distChar,
        biasHistory,
        responseHistogramTrials,
      );
      __hooks__.emit("block:summary:done", { iR });
    }

    // Goodbye screen.
    canvas.style.display = "none";
    const ov = makeOverlay();
    ov.innerHTML = `
      <h1>실험이 끝났습니다</h1>
      <p>참여해 주셔서 감사합니다. 결과가 안전하게 저장되었습니다.</p>
      <p style="opacity:0.7;font-size:13px">
        Day ${day} 완료. 내일 (가능하면 같은 시각) 다시 와주세요.
      </p>`;
    __hooks__.emit("completed", { totalBlocks: schedule.length });
  }

  main().catch((err) => {
    console.error("[TimeExpOnline1_demo] fatal:", err);
    expPlatformLog("fatal: " + (err && err.message ? err.message : String(err)));
    const ov = makeOverlay();
    ov.innerHTML = `
      <h2 style="color:#ff8c8c">오류가 발생했습니다</h2>
      <p>${err && err.message ? err.message : String(err)}</p>
      <p style="opacity:0.7;font-size:13px">
        실험 운영자에게 이 화면을 알려주세요. 콘솔에 상세 로그가 남아 있습니다.
      </p>`;
  });
})();
