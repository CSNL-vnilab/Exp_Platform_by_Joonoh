# Online experiment designer guide

What an experimenter must provide — in what format, under what
constraints — to run a behavioral study through this platform's online
mode. Read this before writing your JS or filling the 실험 생성 form.

For **field-level classification** (required vs. recommended) see
`docs/experiment-field-requirements.md`. This guide focuses on the
**online-specific** contract.

Scope: `experiment_mode = "online"` or `"hybrid"`. Offline-only
experiments can skip most of this.

## 30-second TL;DR

You, the experimenter, supply:

1. A publicly-reachable JavaScript URL (CDN or static host) — no ZIP
   upload. The platform loads it inside a sandboxed iframe on
   `/run/[bookingId]`.
2. JS that calls the `window.expPlatform.submitBlock(payload)` bridge
   at the end of each block of trials.
3. (Optional) an SRI hash for the JS, counterbalance spec,
   attention-check questions, screener questions, preflight
   requirements, and an exclusion list for cross-study washouts.

The platform provides: participant identity, slot scheduling,
condition assignment, storage, rate-limiting, attention-check UI,
behavior-signal collection, completion-code minting, CSV export.

## 1. Form inputs (`/experiments/new` → 실행 방식)

| Field | UI label | Required? | Format |
|---|---|---|---|
| `experiment_mode` | 실행 방식 | 🔴 | `offline` / `online` / `hybrid` |
| `online_runtime_config.entry_url` | 실험 JS 진입 URL | 🔴 (online/hybrid) | `https://...` only. `data:` / `javascript:` rejected. |
| `online_runtime_config.entry_url_sri` | SRI hash | 🟢 | `sha384-…` / `sha256-…`. If present, browser refuses the script on hash mismatch. |
| `online_runtime_config.block_count` | 블록 수 | ⚪ | int. Shown to participant as progress hint. |
| `online_runtime_config.trial_count` | 총 시행 수 | ⚪ | int. Same. |
| `online_runtime_config.estimated_minutes` | 예상 소요 (분) | ⚪ | int ≤ 600. |
| `online_runtime_config.completion_token_format` | 완료 코드 포맷 | ⚪ | `uuid` (default) or `alphanumeric:N`, N ∈ [4,32] |
| `online_runtime_config.preflight` | 실행 전 점검 | ⚪ | `{min_width, min_height, require_keyboard, require_audio, instructions}` — enforced by the shell before handing control to your JS |
| `online_runtime_config.counterbalance_spec` | 조건 할당 | ⚪ | see §4 |
| `online_runtime_config.attention_checks` | 주의 체크 | ⚪ | see §6 |
| `online_runtime_config.exclude_experiment_ids` | 제외 실험 | ⚪ | UUID list. Participants who completed these studies cannot book this one (enforced both in `/api/bookings` and inside `book_slot` RPC — migration 00045). |

Online screeners are edited separately via the 온라인 스크리너 panel
at the bottom of the form.

## 2. Hosting your JS

- **No ZIP upload is supported** — `experiment.zip` upload is in the
  deferred list (see `docs/stream2-notes.md`).
- Host your file on any static CDN that serves `https://` with CORS
  (Cloudflare Pages, Vercel static, S3 + CloudFront, GitHub Pages).
- If you intend to iterate, version the URL
  (`my-exp.v3.js`) — a stale SRI hash blocks deploys.
- The script tag added by the shell sets
  `crossorigin="anonymous"`; your host must serve
  `Access-Control-Allow-Origin: *` (or the run-page origin).

## 3. The `expPlatform` bridge

Once the shell has the participant in the run page and preflight
passes, it loads your JS inside a sandboxed iframe. Your JS sees a
`window.expPlatform` object with:

```js
// Read-only properties
expPlatform.subject        // number — per-experiment subject index
expPlatform.experimentId   // string (UUID)
expPlatform.bookingId      // string (UUID)
expPlatform.config         // object — whatever you put in
                           //   online_runtime_config (trial counts,
                           //   counterbalance_spec, ...)
expPlatform.condition      // string | null — assigned by the server
                           //   (counterbalancing). See §4.
expPlatform.isPilot        // boolean — pilot run flag. Storage path
                           //   gains a _pilot/ prefix.
expPlatform.blocksSubmitted // number — server-side count. Use to
                           //   detect reloads mid-session.

// Async methods (return Promises)
expPlatform.submitBlock({
  blockIndex: 0,            // monotonic, must equal prior blocksSubmitted
  trials: [ { /* your trial rows */ } ],
  blockMetadata: { /* free-form, stored alongside */ },
  completedAt: new Date().toISOString(),
  isLast: false,            // set true on the final block to mint
                            //   the completion code
});
expPlatform.reportAttentionFailure();  // increments server counter
expPlatform.log("any string");         // debug trace; server-side no-op

// Clock — use these for timing-critical RT / latency measurements.
// See §11 for why this matters.
expPlatform.clock.now();               // performance.now() — sub-ms
expPlatform.clock.nextFrame();         // Promise<DOMHighResTimeStamp>
                                       //   resolves at the start of
                                       //   the next paint so stimulus
                                       //   onset is frame-aligned
```

Minimal working example:

```html
<!doctype html>
<script>
async function run() {
  const { subject, condition, config } = window.expPlatform;
  const blocks = config.block_count ?? 3;
  for (let b = 0; b < blocks; b++) {
    // run your trials here...
    const trials = [{ stim: "red",  rt_ms: 320, correct: true },
                    { stim: "blue", rt_ms: 410, correct: false }];
    await window.expPlatform.submitBlock({
      blockIndex: b,
      trials,
      isLast: b === blocks - 1,
    });
  }
  document.body.innerHTML = "감사합니다 — 참여가 완료되었습니다.";
}
// expPlatform is injected by the shell; wait for it.
if (window.expPlatform) run();
else window.addEventListener("expplatform:ready", run, { once: true });
</script>
```

**Three reference implementations live under `public/demo-exp/`** and
are served from the prod origin — point your experiment's `entry_url`
at one of them to try the flow end-to-end before writing your own:

| File | Entry URL | What it does |
|---|---|---|
| `hello-world.js` | `https://lab-reservation-seven.vercel.app/demo-exp/hello-world.js` | 3-trial single-block stub. Copy-paste starter. |
| `number-task.js` | `https://lab-reservation-seven.vercel.app/demo-exp/number-task.js` | Digit-span paradigm, 3 blocks × 5 trials, tablet-friendly. |
| `rating-task.js` | `https://lab-reservation-seven.vercel.app/demo-exp/rating-task.js` | Likert-rating paradigm with a slider UI. |

## 4. Counterbalancing

Fill `online_runtime_config.counterbalance_spec`:

```js
{ kind: "latin_square",   conditions: ["A", "B", "C"] }
{ kind: "block_rotation", conditions: ["A", "B"], block_size: 20 }
{ kind: "random",         conditions: ["control", "treatment"] }
```

First GET `/api/experiments/{id}/data/{bookingId}/session?t=<token>`
assigns a condition via `rpc_assign_condition()` and stores it on
`experiment_run_progress.condition_assignment`. Subsequent GETs return
the same assignment — stable across reloads. Read from
`expPlatform.condition`.

## 5. Block submission protocol

```
POST /api/experiments/{expId}/data/{bookingId}/block
Authorization: Bearer <run-token>
Content-Type: application/json

{ "block_index": 0, "trials": [...], "is_last": false }
```

Rules enforced server-side (route
`src/app/api/experiments/[experimentId]/data/[bookingId]/block/route.ts`):

- `block_index` ∈ [0, 999], monotonic — must equal current
  `experiment_run_progress.blocks_submitted`. Off-by-one →
  `HTTP 409 BLOCK_INDEX_MISMATCH`.
- `trials` array, max 10,000 entries.
- Rate limit: **1 req/sec burst + 100 req/min sustained** per
  booking. Over burst →
  `HTTP 429 RATE_LIMIT_BURST` / `RATE_LIMIT_MINUTE`. Shell
  auto-retries once at 1.5 s.
- Total post-JSON payload ≤ Vercel function body limit (~4 MB); keep
  trials slim — don't ship stimulus images, ship references.
- On `is_last: true` the server mints a `completion_code` per your
  `completion_token_format` and writes it to the response and to
  `experiment_run_progress.completion_code`.

Each submitted block lands in Supabase Storage at
`experiment-data/{expId}/{subjectNumber}/block_{N}.json`
(or `experiment-data/{expId}/_pilot/{subjectNumber}/...` when
`is_pilot`).

## 6. Attention checks

Declared in `online_runtime_config.attention_checks`:

```js
[
  {
    kind: "yes_no" | "single_choice",
    question: "방금 문단의 주제는 '고양이'였나요?",
    options: ["예", "아니오"],        // single_choice only
    correct_answer: "아니오",
    position: "after_block:1" | "random",
  }
]
```

The **shell** (not your JS) renders these overlays on top of the
iframe at the configured position. If the participant gets it wrong,
the shell counts it and calls `reportAttentionFailure()` for you. You
can also call `reportAttentionFailure()` from your own JS if you run
your own attention checks inline.

At N failures (thresholds configurable per-experiment in a future
version; current hard-coded behavior: shell annotates the booking but
does not auto-abort) researchers decide post-hoc via the dashboard
`PendingWorkCard` "주의 실패" tile.

## 7. Behavior signals (automatic)

The shell captures these transparently — no action on your side.
Counters sum additively server-side, per booking, on every block
submit:

| Field | Meaning |
|---|---|
| `focus_loss` | `blur` events on the iframe (participant tab-clicked away). |
| `tab_switch` | `visibilitychange` → `document.hidden` transitions. |
| `paste_count` | `paste` events inside the iframe. |
| `frame_jitter_ms` / `frame_samples` | RAF deviation from 16.67 ms (60 Hz). Divide sum by samples for mean jitter per session — a proxy for throttled devices. |
| `key_count` / `key_iki_sum_ms` / `key_iki_sumsq_ms2` | Keystroke count + inter-keystroke interval (IKI) sum + sum-of-squares. Post-hoc mean = sum/count; variance = (sumSq − sum²/count) / count. Only `isTrusted` events counted — synthetic (bot) keystrokes are filtered. |
| `pointer_count` | `pointerdown` + `touchstart` count (again `isTrusted` only). |

Flushed to `behavior_signals` after every block submit. To surface in
your analysis, `SELECT behavior_signals FROM experiment_run_progress
WHERE booking_id = $1` or export via the researcher UI.

All listeners attach in the **capture phase**, so researcher-JS that
calls `stopPropagation()` during bubbling still gets counted.

## 8. Online screeners

Pre-task questions that gate participation. Configured via the 온라인
스크리너 editor (separate from `online_runtime_config`). Each question
has: `kind` ∈ {yes_no, numeric, single_choice, multi_choice}, a
`validation_config` shape matching the kind, an explicit pass/fail
answer. The public `/session` endpoint evaluates the participant's
answers and returns `{ passed: boolean, failed_questions: [...] }`
*before* your JS loads. Failed participants never see your task.

## 9. Pilot mode

Toggle via the 파일럿 badge on the booking row, or
`POST /api/experiments/{id}/pilot-toggle`. Effect:

- Run page shows a "파일럿" indicator to the participant.
- `is_pilot: true` stamped on `experiment_run_progress`.
- Storage path gets `_pilot/` prefix — deletable wholesale before
  analysis.
- CSV export has an opt-in to include pilot rows.

## 10. Limits

| Limit | Value | Source |
|---|---|---|
| Max trials per block | 10,000 | block route validator |
| Max block index | 999 | same |
| Max estimated_minutes | 600 | validation.ts |
| Block-ingest burst | 1 req/s per booking | DB RPC `rpc_ingest_block` |
| Block-ingest sustained | 100 req/min per booking | same |
| Run token TTL | 14 days | `src/lib/experiments/run-token.ts` |
| PII stripping recursion depth | 8 | block route |
| Parameter schema max | 50 entries | validation.ts |

## 11. Security & privacy invariants

**The platform strips PII-looking keys from trial payloads
automatically** (depth ≤ 8 recursion). Keys removed on sight (case
insensitive): `email`, `phone`, `birthdate`, `birthday`, `address`,
`ssn`, `rrn`. If you need to key on participant identity, use the
`subject` number — that's the platform-issued index, not PII.

Don't do these — they'll either break your study or trigger our
anti-bot machinery:

- Don't set cookies from your JS — the iframe is sandboxed and
  wouldn't see them on reload anyway. Use the `subject` / `bookingId`
  for state.
- Don't embed a string matching the honeypot token (see
  `src/components/run/run-shell.tsx` — any trial containing the trap
  word auto-flags the session as bot/LLM). The token text rotates; if
  you're templating a randomized list of distractors, sanity-check it.
- Don't bypass `submitBlock` with your own POST to the block
  endpoint — you'll miss the `condition` + `is_pilot` propagation the
  shell wraps in.
- Don't assume same-origin. The script runs in a different origin
  from the shell; `postMessage` is the only channel.

## 11b. Internal validity — what the platform does and doesn't defend

Web experiments trade laboratory control for scale. These are the
failure modes the platform actively detects, and the ones you as the
designer must still handle.

### Platform-provided defenses

| Threat | Mechanism | Where |
|---|---|---|
| Tab switch / focus loss | `visibilitychange` + `blur` counters in `behavior_signals` | shell, per-booking |
| Copy-paste bot | `paste` event counter + honeypot word in hidden aria element | shell + screener route |
| Fresh condition on reload | Condition assigned once per booking, locked in `experiment_run_progress.condition_assignment` | `/session` RPC |
| Resume after refresh | `blocksSubmitted` restored from server on page reload | `/session` GET |
| Synthetic input events | All keystroke / pointer counters require `isTrusted` | shell capture listeners |
| Frame-rate throttling | `frame_jitter_ms` / `frame_samples` sampled via RAF every frame | shell |
| Keystroke cadence | IKI sum + sum-of-squares (compute mean + variance post-hoc) | shell capture listeners |
| Cross-study carryover | `exclude_experiment_ids` enforced in `book_slot` RPC (migration 00045) | DB |

### Things you still have to defend against

| Threat | What you should do |
|---|---|
| **Display latency → RT drift** | Start timing with `await expPlatform.clock.nextFrame()` at stimulus-render time, not at the `setTimeout` call. Frame-lock your start and end marks. |
| **Browser zoom / DPR** | Query `window.devicePixelRatio` on load and either (a) force a fixed-pixel canvas, or (b) log the value and exclude post-hoc. Preflight records window size but not DPR. |
| **Audio autoplay policy** | Modern browsers (Safari, Chrome mobile) block `<audio>` playback until a user gesture. Gate your first audio trial behind a "준비됐습니다" button that calls `audio.play()` in its click handler. Call `audioContext.resume()` on the same gesture if using Web Audio. |
| **Fullscreen** | The iframe sandbox does **not** grant `allow-fullscreen`. If your paradigm needs it, don't rely on it — design around windowed presentation. |
| **Devtools / breakpoints** | No first-party detection (false-positive rate is too high). Accept some participants will snoop; honeypot + reCAPTCHA-free design is the current posture. If you suspect a study is targeted, run a small pilot and screen behavior_signals for outliers. |
| **Multi-session ordering** | Condition assignment is per-booking — it does **not** track whether the same participant saw Cond A before B in a prior session. If you care about within-subject carryover across sessions, write it into `blockMetadata` yourself (`expPlatform.bookingId` is stable; correlate across sessions via the lab's participant-identity system). |
| **Multi-monitor / extended display** | Not detected. `screen.isExtended` is available in modern browsers — call it in your own JS if you need to know. |
| **Network-throttled devices** | No client-side latency probe. If response-time accuracy matters, record `performance.timing.domContentLoadedEventEnd - performance.timing.navigationStart` as a trial covariate. |
| **Mid-trial device switch** | Not detected. If a participant switches from trackpad to mouse mid-block, you won't know. |
| **LLM participants** | Honeypot word + paste-count + keystroke cadence give you triangulating signals. Nothing is foolproof. A fast, mostly-zero-variance IKI stream with zero pastes is suspicious; so is a study completed with no pointer events at all. |

### Recommended trial-level covariates to log in `trials[n]`

- `stim_onset_ms` — from `expPlatform.clock.nextFrame()` at render time.
- `response_ms` — from `expPlatform.clock.now()` at response time, minus `stim_onset_ms`.
- `dpr` — `window.devicePixelRatio` at session start.
- `inner_w` / `inner_h` — `window.innerWidth` / `innerHeight` at session start (re-log on resize).
- `trial_isTrusted` — `event.isTrusted` on the response event.

These are free to log and save you from having to exclude data post-hoc when you realize a covariate was missing.

## 12. Validation failure modes

| Symptom | Likely cause |
|---|---|
| Form rejects `entry_url` | Not `https://` (or `data:` / `javascript:` rejected by both form and shell) |
| Script never loads, console: `integrity mismatch` | SRI hash doesn't match the file. Regenerate with `openssl dgst -sha384 -binary my-exp.js \| openssl base64 -A` |
| `HTTP 409 BLOCK_INDEX_MISMATCH` | You resubmitted an already-submitted block, or skipped one. Read `blocksSubmitted` and resume. |
| `HTTP 429 RATE_LIMIT_BURST` | You called `submitBlock` in a loop with no await. Serialize. |
| Completion code stays null | You never sent `is_last: true` on any block. |
| Storage file missing for block N | Transient Storage write failure; check `notion_health_state.check_type='block_ingest'`. |
| Participant gets "이 실험에는 참여하실 수 없습니다" | Cross-study exclusion hit via `exclude_experiment_ids` (migration 00045). |

## 13. Pre-launch checklist

- [ ] Entry URL served over `https://` with CORS.
- [ ] SRI hash matches the final (not-gonna-touch-it-again) version of the JS.
- [ ] `submitBlock` called once per block; `isLast: true` on the final one.
- [ ] Trial payload excludes PII. Run through `scripts/e2e-online-exp.mjs` against a staging booking to confirm — keys get stripped silently if you miss one.
- [ ] Counterbalance spec's `conditions` length matches what your JS expects.
- [ ] Attention checks' `correct_answer` is in the `options` array (single_choice).
- [ ] Preflight requirements (`min_width`, audio, keyboard) match what your task actually needs — too strict loses valid participants.
- [ ] Pilot mode tested: a pilot booking completes end-to-end and the file lands under `_pilot/`.
- [ ] Phase-2 E2E green against staging:
  `NEXT_PUBLIC_APP_URL=<staging> node scripts/e2e-online-phase2.mjs`.
- [ ] Exclusion list (if any) verified against Notion project list.

## 14. Debugging tools

- **E2E scripts**: `scripts/e2e-online-exp.mjs` (basic) and
  `scripts/e2e-online-phase2.mjs` (phase-2 features). Safe to run
  against prod with a throwaway experiment — they clean up after.
- **Local preview**: `/experiments/{id}/preview-run` — run your task
  against a preview booking without consuming a real slot.
- **Cron-auth smoke**: `node scripts/smoke-cron-auth.mjs` verifies
  the deploy didn't drop any cron endpoint.
- **Migration status**: `node scripts/migration-status.mjs` before
  any deploy.
- **Dashboard**: `PendingWorkCard` surfaces "주의 실패", "스크리너
  부결", "Notion 재시도 한계", "외부 연동 재시도/한계" tiles.

## 15. Out of scope (deferred)

These land later; design around them:

- First-class `experiment.zip` upload (Storage extract → auto-wire
  `on_finish`). jsPsych works today, just bring your own URL.
- Longitudinal scheduling (session N+1 in 7±1d window).
- Researcher Bearer tokens for programmatic study creation.
- WebGazer / eye-tracking integration.
- Webcam-based consent e-signature.

See `docs/stream2-notes.md` § "Hard to implement now — deferred" for
the full list.
