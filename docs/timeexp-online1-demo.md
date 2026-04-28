# TimeExpOnline1_demo — Web port of `main_duration.m`

A 5-day, online-deployable demo twin of the in-lab Magnitude/Duration
reproduction paradigm, hosted on this lab platform. Data lives on
Supabase + is mirrored periodically to the lab NAS.

> **Critical**: TimeExpOnline data is **never co-mingled** with the
> in-lab `TimeExp1` results under `/Volumes/CSNL_new/.../timeExp1/`.
> Subject numbering restarts at 1 for the online cohort. The web port
> is a methodological probe; the in-lab MATLAB version remains the
> publishable canonical pipeline.

Source paradigm: `/Volumes/CSNL_new/people/JOP/Magnitude/Experiment/main_duration.m`
(version 3, 2026-02-22). Web port: `public/demo-exp/timeexp/main.js`.

---

## 1. What this experiment does

One trial (~7.7 s):

```
cue + vm1 (0.3–0.8 s, visible motion) →
  occlusion θ (0.6–1.6 s, target) →
  vm2 (1.1 − vm1, visible motion) →
  cue2 + vm3 (0.3–0.8 s, second visible motion) →
  response window (≤ 2.5 s; first click = reproduced θ) →
  feedback (1.0 s, only on flagged trials) →
  ITI to fill 7.7 s
```

Each session has 10 (Day 1) or 12 (Days 2–5) blocks × 30 trials.
Stimulus distribution per session is determined by:

| Day | dist |
|---|---|
| 1 | U (uniform over [0.6, 1.6] s) |
| 2–5 | A (L-skew) or B (R-skew), per pattern `patList[subjNum % 4][day - 2]` where `patList = ["AABB","ABBA","BABA","BBAA"]` |

Faithful to the MATLAB version's `exp_info_duration.m:25-32` rule.

---

## 2. Architecture

```
participant browser (sandboxed iframe)
   │
   ▼
public/demo-exp/timeexp/main.js              ← entry_url; visual trial
   │
   ▼ window.expPlatform.submitBlock(...)     ← bridge to platform shell
   │
   ▼
src/app/api/experiments/.../data/.../block   ← Next.js route, validates,
   │                                            stores trial json
   ▼
Supabase Storage: experiment-data/{expId}/{subject}/block_{N}.json
   │
   ▼ (hourly launchd job on lab Mac)
/Volumes/CSNL_new/.../results/TimeExpOnline1_demo/{subject}/...
```

Auxiliary artefacts in `public/demo-exp/timeexp/`:

| File | Purpose |
|---|---|
| `main.js` | Single-file experiment (Canvas 2D, no deps). |
| `stimulus_30.json` | 3 distributions × 30 samples, plus skew-normal params. |
| `dist_guide_U.png` / `_A.png` / `_B.png` | Pre-rendered distribution-shape illustrations shown at session start. |

The JSON + PNGs are regeneratable from the MATLAB-side `Stimulus_30.mat`
via `scripts/timeexp/extract-stimulus-mat.py` and
`scripts/timeexp/render-dist-guides.py`. One-shot — re-run only when the
canonical .mat changes.

---

## 3. How decisions were taken (questions answered 2026-04-28)

| # | Topic | Choice |
|---|---|---|
| Q1 | Visual-angle preservation | Per-session credit-card calibration widget → DVA preserved within ±5 % per participant. Stored in sessionStorage; reused on browser refresh, cleared on new tab. |
| Q2 | Refresh rate | 60 Hz strict. Session-start gate measures 90 RAF samples; if median ∉ [50, 80] Hz the participant is asked to set their display to 60 Hz. Bypass available with a "data quality ↓" warning. |
| Q3 | Occlusion timing | Web best-effort: every trial's `vbl_occlu_end - vbl_occlu` recorded as `occlu_dur_observed`. Analyst filters post-hoc (suggest \|observed − θ\| > 20 ms drop). |
| Q4 | RNG | Schedule deterministic via `mulberry32(SHA-256(bookingId)[:4])`. Same booking → same schedule. Schedule + seed shipped in block 0's `blockMetadata.session.schedule` so analyst gets reproducibility from a single Storage fetch. |
| Q5 | Multi-session | Single experiment with `session_type=multi`, `required_sessions=5`. Researcher should book all 5 sessions same time daily for the participant; instructions text reinforces this. |
| Q6 | What to save | Excludes texture/UI internals; keeps full schedule + PRNG seed + per-trial vbl timestamps + dpr/inner_w/inner_h covariates. |
| Q7 | Distribution guide | Pre-rendered PNG at 2400×1500 px (~Retina-friendly). Source params and curve maths from `tex_template_Duration.m:make_dist_guide_texture`. |
| Q8 | Storage + backup | Supabase Storage canonical; lab Mac launchd job mirrors hourly to NAS; GH Actions hourly integrity-check workflow watches counts. |

Risk-acknowledgement notes (from same conversation):

1. Fullscreen handled via on-screen instruction (`F11` / `⌃⌘F`); platform iframe sandbox does not grant `allow-fullscreen`.
2. Tab-switch / focus-loss already counted in `behavior_signals` by the platform shell; reproduced inside the runtime as `behavior_signals.tab_switch / focus_loss`.
3. Mouse responses are `pointerdown` + `event.timeStamp` (sub-ms). No polling.
4. **Online ≠ Offline.** TimeExpOnline data is its own experiment record (`TimeExpOnline1_demo`); subjects re-numbered from 1.

---

## 4. Bridge surface used

`window.expPlatform` (see `docs/online-experiment-designer-guide.md`):

- `subject` — used as MATLAB `subjNum` for the dist-pattern formula.
- `bookingId` — used as the PRNG seed source (SHA-256 prefix → uint32 → mulberry32).
- `sessionIndex` — if the platform passes it (multi-session), it's the day. Falls back to in-app self-report ("Day 1..5?") when undefined.
- `clock.now()` / `clock.nextFrame()` — frame-locked stimulus onset & response timing.
- `submitBlock({ blockIndex, trials, blockMetadata, isLast })` — saves trials + the full schedule (only block 0).
- `log()` — debug trace per block-trial line, mirrors MATLAB's `Summary_Trial_Duration.m` printf.

Behavior signals automatically captured by the shell (no explicit code in `main.js`):

- `focus_loss`, `tab_switch`, `paste_count`
- `frame_jitter_ms`, `frame_samples`
- `key_count`, `key_iki_sum_ms`, `key_iki_sumsq_ms2`, `pointer_count`

---

## 5. Per-trial saved fields

Mirrors MATLAB's `par.results.*` + `par.tp.*` per-trial namespaces:

| Field | MATLAB equivalent | Note |
|---|---|---|
| `Stm` | `par.Stm{iR}(iT)` | the occlusion duration θ in s |
| `Stm_pr` | `par.Stm_pr{iR}(iT)` | rho on 0.01:0.07:0.99 grid |
| `thetaLabel` | `par.thetaLabel{iR}(iT)` | 1..15 quantile index |
| `feedback` | `par.feedback{iR}(iT)` | 0/1 |
| `seed` | 0 (reproduction-only) | constant for Exp1 |
| `tvm1` / `tvm2` / `tvm3` | `par.trial.tvm*` | s |
| `occ_deg` | `par.trial.occ_deg{iR}(iT)` | rad |
| `speed1` / `speed2` | `par.trial.speed*` | rad/s |
| `start1` / `start2` | `par.trial.start*` | rad |
| `dir1` / `dir2` | `par.trial.dir*` | ±1 |
| `end1` / `occl_end` | `par.trial.end1` / `occl_end` | rad |
| `Est` | `par.results.Est{iR}(iT)` | response in s; NaN on miss |
| `Error` | `par.results.Error{iR}(iT)` | s; NaN on miss |
| `RT` | `par.results.RT{iR}(iT)` | s |
| `ResponseAngle` | `par.results.ResponseAngle{iR}(iT)` | rad; NaN on miss |
| `vbl_cue` / `vbl_occlu` / `vbl_occlu_end` / `vbl_cue2` / `vbl_respOnset` / `vbl_resp` | `par.tp.vbl_*` | DOMHighResTimeStamp ms (origin = navigation) |
| `occlu_dur_observed` | `par.tp.occlu_dur_observed{iR}(iT)` | s; sanity check vs `Stm` |
| `tend_target` / `tend_actual` | `par.tp.tend{iR}(iT)` | ms |
| `dpr`, `inner_w`, `inner_h`, `response_isTrusted` | (web-only covariates) | for post-hoc exclusions |

Block 0 carries the full session metadata in `blockMetadata.session`:

```jsonc
{
  "experimentLabel": "TimeExpOnline1_demo",
  "subjectNumber": 1,
  "bookingId": "...",
  "day": 1,
  "distChar": "U",
  "ppd": 47.3,
  "pxPerCm": 39.0,
  "distanceCm": 60,
  "calibAt": "2026-04-28T...",
  "refreshHz": 60.04,
  "refreshOk": true,
  "schedulePrngSeed": 1234567890,
  "scheduleAlgorithm": "mulberry32",
  "paradigmCommit": "main_duration.m ver.3 26.02.22",
  "schedule": [ /* 10 or 12 block schedules */ ]
}
```

---

## 6. Deployment

Standard online experiment deployment (`docs/online-experiment-designer-guide.md`):

1. Create a new experiment titled **`TimeExpOnline1_demo`** in `/experiments/new`.
2. Set:
   - `experiment_mode`: `online`
   - `session_type`: `multi`, `required_sessions`: `5`
   - `online_runtime_config.entry_url`: `https://lab-reservation-seven.vercel.app/demo-exp/timeexp/main.js`
   - SRI hash: optional. If set, regenerate when `main.js` changes.
   - Counterbalance / attention-checks / screeners: leave blank — the runtime owns them.
3. Open one booking per participant per day (5 bookings/participant). Researcher should encourage same-time-daily — currently a soft convention, not enforced.
4. Smoke test:
   ```
   NEXT_PUBLIC_APP_URL=https://lab-reservation-seven.vercel.app \
     node scripts/e2e-online-phase2.mjs   # generic
   ```
5. Verify the three static assets are reachable:
   ```
   curl -sSI https://lab-reservation-seven.vercel.app/demo-exp/timeexp/main.js          | grep HTTP
   curl -sSI https://lab-reservation-seven.vercel.app/demo-exp/timeexp/stimulus_30.json | grep HTTP
   curl -sSI https://lab-reservation-seven.vercel.app/demo-exp/timeexp/dist_guide_U.png | grep HTTP
   ```

---

## 7. NAS backup ops

**Lab Mac side** — install the launchd job once:

```bash
# After cloning the repo on the lab Mac:
cp scripts/timeexp/backup-to-nas.plist \
   ~/Library/LaunchAgents/com.csnl.timeexp.backup.plist
# Edit EnvironmentVariables.EXPERIMENT_ID first.
launchctl load ~/Library/LaunchAgents/com.csnl.timeexp.backup.plist
launchctl start com.csnl.timeexp.backup

# Watch logs:
tail -f /tmp/timeexp-backup.out.log /tmp/timeexp-backup.err.log

# Manual one-shot:
EXPERIMENT_ID=<uuid> node scripts/timeexp/backup-to-nas.mjs
```

The script is idempotent — files already on the NAS with matching size
are skipped. Hourly cadence is fine for a daily experiment; bump to
15 min if data loss tolerance is tighter.

**Server side** — `.github/workflows/timeexp-data-integrity.yml` runs
hourly on GH Actions and exits non-zero on partial sessions or
unexpected block counts. Repo secrets required:

- `SUPABASE_URL` (mirror of `NEXT_PUBLIC_SUPABASE_URL`)
- `SUPABASE_SERVICE_ROLE_KEY`
- `TIMEEXP_EXPERIMENT_ID` (uuid of the prod experiment)

Failures appear in the Actions tab; surface via repo notifications.

---

## 8. Differences from `main_duration.m` (deliberate)

The web port is a behavioural twin, not a pixel-by-pixel clone. Known
deviations and why:

1. **Frame-driven motion → time-driven motion** (Q2 chose 60 Hz, but web RAF can deviate by 1–3 ms even on a 60 Hz panel). vm1/vm2/vm3 angles compute as `start + dir × speed × tvm × (now − phase_start) / (tvm)`, not `f / n_frames`. Identical end-points, smoother on near-60 Hz panels.

2. **No `Screen('FillPoly')`-style PTB primitives.** Bullseye, ring, bar, arc, gradient all reimplemented in Canvas 2D. Tested visually equivalent but a researcher running side-by-side renders may notice anti-aliasing differences (Canvas does default AA; PTB doesn't).

3. **No `SkipSyncTests=1` knob.** Web runtime cannot suppress vsync warnings; instead, it gates on measured FPS at session start.

4. **No `codebackup.zip`.** Source is git; reproducibility comes from `paradigmCommit` field + the schedule shipped with block 0.

5. **No `prevDayBest` lookup.** That field is empty in the new MATLAB pipeline anyway (per `summary.md` §4.4 — variability metrics moved to legacy and stay NaN). Will revisit if the analyst asks.

6. **Click debounce** kept the original 200 ms ignore window from `Duration_Occlusion.m:125`.

7. **Schedule generation** is structurally identical to `StimGenerator_Duration.m` — same loops, same fall-back logic, same feedback rule per dist. Only the underlying PRNG differs (mulberry32 vs MATLAB's Mersenne-twister). Both are seedable; both are recoverable from saved seed.

---

## 9. Recovery / rollback

- **Static asset rollback**: `git revert` the relevant commit; redeploy. Affects only new sessions; in-flight participants don't reload mid-block (the JS is loaded once at run start).
- **Schedule rederivation**: SHA-256 the booking uuid, take first 4 bytes as uint32, mulberry32(seed). Block 0 metadata also stores `schedulePrngSeed` directly.
- **NAS resync**: re-run `backup-to-nas.mjs` — idempotent, will only re-fetch missing or size-mismatched files.

---

## 10. Open follow-ups (non-blocking)

- Add `sessionIndex` to `EP` shim so participants don't have to self-report. Requires a small additive change in `src/components/run/run-shell.tsx` to expose `booking.session_index`. Filed for next round.
- Programmatic enforcement of "same time daily" booking constraint at the platform `/book` level. Currently soft (instruction only).
- Researcher-facing live dashboard: per-day completion table for active participants (Bias / blocks done / refreshHz). Probably implement under `/experiments/[id]/live`.
- Pixel-by-pixel comparison test: render each phase to a hidden canvas + diff against an in-lab Screen('GetImage') snapshot. Worth doing if the lab decides to publish the web cohort.
