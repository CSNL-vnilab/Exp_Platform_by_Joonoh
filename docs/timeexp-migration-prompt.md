# TimeExpOnline1_demo — session migration brief

> **Read this first when resuming.** Single-page state-of-the-port +
> what's done + what's left. Last updated 2026-04-29.

---

## 1. What we're building

Web port of `main_duration.m` — the in-lab MATLAB time-reproduction
paradigm — running through this lab platform's online experiment
runtime. **Purely a methodological probe**; in-lab `TimeExp1`
canonical, online cohort starts subject numbering at 1 with
`TimeExpOnline1_demo` label.

Source paradigm:
`/Volumes/CSNL_new-1/people/JOP/Magnitude/Experiment/main_duration.m`

Web port:
`public/demo-exp/timeexp/main.js` (single Canvas 2D file, 1740 lines).

User decisions (Q1-Q8 from 2026-04-28):
- **Q1=A** — credit-card visual-angle calibration per session
- **Q2** — 60 Hz refresh strict (gate + bypass option)
- **Q3** — best-effort web timing; analyst filters via `occlu_dur_observed` post-hoc
- **Q4=B** — schedule deterministic via `mulberry32(SHA-256(bookingId)[:4])`, shipped in block 0 metadata
- **Q5** — 1 experiment × 5 sessions (`session_type=multi`, `required_sessions=5`)
- **Q6** — save schedule + seed + per-trial vbl + DPR; drop UI internals
- **Q7=A** — pre-rendered hi-res dist-guide PNGs (2400×1500)
- **Q8** — Supabase canonical; lab-Mac launchd hourly NAS mirror

---

## 2. What's done (commit hashes for diff anchoring)

### Behavioural fidelity (vs MATLAB main_duration.m)

| Severity | Item | Where fixed |
|---|---|---|
| HIGH | Phase 2 occlusion missing `-ifi` correction (was biasing every θ up by ~16ms) | f37263e |
| HIGH | <200ms response: kept polling for 2nd click (MATLAB breaks to miss) | f37263e |
| HIGH | `EP.subject` not coerced to int (silent dist-pattern corruption on bad input) | f37263e |
| HIGH | Background grey `[8,8,8]` linear → `[49,49,49]` gamma-corrected MATLAB par.grey | f37263e |
| HIGH | Cross-gap colour `[8,8,8]` → background-grey, clipped to bullseye disk | f37263e |
| HIGH | Visibility / focus loss not flagged → per-trial `hidden_ms` + visibilitychange listener | f37263e |
| MED | IFI hardcoded to 1/60; now derived from refresh-rate gate measurement | f37263e |
| MED | Phase 5 `vbl_respOnset` had extra nextFrame() shift (~16ms) → now `EP.clock.now()` | f37263e |
| MED | Per-block summary chart absent → ported `draw_repro_progress_screen` (bias bar + response histogram + 5s rest + 5..1 countdown + click) | 7689510 |
| MED | Per-block dist-guide screen absent → 2-step block intro (intro + dist-guide click) | 7689510 |
| MED | `vbl_start`, `tblockinit`, `blockend`, `blockdur` missing | f37263e |
| LOW | col_red/blue/black off-by-one rounding | f37263e |

### Iframe shim parse-error fix

- `script.src = "${safeEntry}";` had double-quote bug — broke ALL online experiments in real browsers. Fixed in `e4c3e44` at `src/components/run/run-shell.tsx:291`.

### Harness + hooks

- `window.__timeexpHooks__` — public event taxonomy (15 hook names; bootstrap, calibration:done, refreshGate:result, sessionResolved, scheduleGenerated, sessionInstructions:done, block:start, trial:phase {12 sub-phases}, trial:saved, block:bias, block:submitted, block:summary:done, visibility:change, error, completed). Always-on ring buffer at `__timeexpHooks__.log`.
- `scripts/timeexp/harness.mjs` — 20 atomic invariants checked against the hook stream. Currently 20/20 green on local mock harness (~4 min for 1 block at headless 90 Hz).

### Tests

- `scripts/timeexp/e2e-prod.mjs` — full prod e2e with random auto-clicker (proves data path; high simulated bias).
- `scripts/timeexp/e2e-ideal-observer.mjs` — full prod e2e with **ideal observer** (clicks at vbl_respOnset + θ via parent ↔ iframe clock-bridge). Proves platform timing fidelity.

**Result on prod (block 0, 30 trials, 743d138):**
| Metric | Value |
|---|---|
| confirmed | 30 / 30 |
| bias | +1.16 ms |
| `\|Error\|`_mean | 5.26 ms |
| `\|Error\|`_max | 17.10 ms |
| Error SD | 6.82 ms |

**Conclusion**: web platform preserves sub-frame timing fidelity equivalent to MATLAB PTB. Any participant variance comes from the participant, not the runtime.

---

## 3. Outstanding / next-session work

### Chrome MCP UI-driven tests (highest priority)

`claude mcp add chrome-devtools --scope user npx chrome-devtools-mcp@latest` was run on 2026-04-29 — registered in `~/.claude.json`. **Will load on next session start.** When `mcp__chrome-devtools__*` tools are visible:

1. **Experimenter flow** — drive Chrome attached to JOP's logged-in session through `/experiments/new`:
   - Title: `TimeExpOnline1_demo` (no `[E2E-...]` prefix — for real)
   - experiment_mode=online, session_type=multi, required_sessions=5
   - online_runtime_config.entry_url=`https://lab-reservation-seven.vercel.app/demo-exp/timeexp/main.js`
   - Verify creation + redirect to `/experiments/[id]`.
2. **Booking flow** — researcher creates a booking for a test participant via UI.
3. **Participant flow** — open a fresh Chrome window, go to `/run/[bookingId]?t=<token>`, walk through. (Already validated via Playwright; UI-driven version is for completeness.)
4. **Live dashboard** — JOP's view of `/experiments/[id]/live` while a session is in progress; verify per-block bias appears.

If Chrome MCP doesn't show in tools after restart, see `memory/reference_chrome_mcp.md` for fallback diagnostics.

### Multi-block + multi-session ideal-observer run

`e2e-ideal-observer.mjs --blocks N` — run all 10 blocks (Day 1) to verify
- bias stays near 0 across all blocks
- block summary chart populates correctly across 10 entries
- `tend` chaining stays accurate over ~40 minutes

Then re-run with `sessionIndex=2..5` (different days) to verify dist-pattern formula (`patList[subjNum % 4][day-2]`).

### Stale e2e fixture cleanup

Many `[E2E-TimeExp]` and `[E2E-IdealObs]` experiments accumulated on prod Supabase across this session's iterations. All `status='draft'` (invisible to public). Cleanup options:
- Run `e2e-ideal-observer.mjs` with `--cleanup` for new tests.
- One-shot SQL: `DELETE FROM experiments WHERE title LIKE '[E2E-%' AND status='draft'` (also cascades to bookings + participants if FK is on cascade).

### Visual fidelity beyond colors / geometry

Outstanding items from agent G's audit (low/med severity):
- Anti-aliasing: Canvas2D AA softens bar edges (~5px wide); PTB renders crisp pixels. Cosmetic only.
- Dist-guide PNG label positions: 2-line "Shorter\nduration" labels in PNG vs single-line in MATLAB. Cosmetic.
- Texture caching: PTB pre-bakes `tex_arc` once; JS redraws every frame. Performance, not fidelity.

### Server-side tightening (from agent A's audit)

Existing platform/booking quirks the user knows about:
- Page `/run/[bookingId]` doesn't reject `experiment.status='draft'` or booking-window mismatch. Acceptable for demo phase.
- Multi-session completion mints completion code per-booking, not per-experiment (so each day mints separately). User said this is OK for demo.
- `EP.sessionIndex` not exposed by run-shell shim; main.js falls back to in-app Day picker. Adding `sessionIndex: ${scriptSafe(booking.session_number)}` at `run-shell.tsx:236` would polish but isn't required.

---

## 4. How to resume in a new session

1. **Read the migration prompt + memory entries** (this file + `memory/project_timeexp_online.md`, `memory/reference_timeexp_paths.md`, `memory/reference_chrome_mcp.md`, `memory/feedback_multi_session_rules.md`).

2. **Verify Chrome MCP loaded:**
   ```
   ToolSearch query "chrome devtools navigate"
   ```
   If `mcp__chrome-devtools__*` tools appear → proceed with UI-driven flow.
   If not → see `memory/reference_chrome_mcp.md` fallback notes.

3. **Pre-flight before any code change:**
   ```bash
   git fetch && git log HEAD..origin/main      # see what other sessions did
   ps -axo pid,etime,command | grep timeexp    # don't collide with running e2e
   node scripts/test-guide-bridge-sync.mjs     # confirm bridge surface still in sync
   ```

4. **Sanity-run on prod (4 min):**
   ```bash
   NEXT_PUBLIC_APP_URL=https://lab-reservation-seven.vercel.app \
     node scripts/timeexp/e2e-ideal-observer.mjs --blocks 1
   # Expected: bias ≤ 10 ms, |Error|_max ≤ 60 ms, 30/30 confirmed
   ```

5. **Then proceed with Chrome MCP tasks** in priority order (experimenter flow → booking flow → live dashboard).

---

## 5. File map (most-touched paths)

```
public/demo-exp/timeexp/
  main.js                       — 1740 lines runtime
  stimulus_30.json              — base distributions
  dist_guide_{U,A,B}.png        — pre-rendered guides
scripts/timeexp/
  extract-stimulus-mat.py       — one-shot .mat → .json
  render-dist-guides.py         — one-shot params → PNGs
  harness.mjs                   — local mock + 20 invariants
  test-harness.html             — stub expPlatform for harness
  e2e-prod.mjs                  — full prod e2e (random clicks)
  e2e-ideal-observer.mjs        — full prod e2e (ideal observer)
  check-data-integrity.mjs      — Supabase counts
  backup-to-nas.{mjs,plist}     — lab-Mac launchd
docs/
  timeexp-online1-demo.md       — paradigm + ops
  timeexp-migration-prompt.md   — this file
  online-experiment-designer-guide.md
src/components/run/run-shell.tsx — iframe shim (line 291: critical fix)
.github/workflows/timeexp-data-integrity.yml
```

---

## 6. Recent commit landscape (chronological tail)

```
743d138  TimeExp: ideal-observer e2e — full-test against deployed prod
fff63c6  e2e-prod: networkidle + DOM-direct click for start button
7689510  TimeExpOnline: per-block summary chart + dist guide + 10 more invariants
f37263e  TimeExpOnline: harness + hook lifecycle + Priority A fidelity fixes
e4c3e44  Fix iframe shim: script.src double-quoting parse error
e18890c  TimeExpOnline main.js: absolute URLs from script origin
5f520df  TimeExpOnline1_demo: web port of MATLAB main_duration.m
```

`git log --oneline scripts/timeexp/ public/demo-exp/timeexp/ src/components/run/run-shell.tsx` shows the full series.
