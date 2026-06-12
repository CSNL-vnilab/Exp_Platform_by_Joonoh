# Online Experiment Runtime — Survival Blueprint

Synthesis of 6-lens diagnosis (authoring · run-shell · data-ingest · lifecycle-deploy · screener-eligibility · gap-vs-matlab), cross-checked against source in `/Users/csnl/Documents/claude/lab-reservation-main`. Every claim below is file:line-verified.

**Verdict:** the *transport + ingest core* is production-grade (signed/hashed token gate, `rpc_ingest_block` monotonic ordering + rate limit under row lock, PII scrub, pilot isolation, completion mint/verify). The *authoring → trust → egress* path is not. A researcher can today configure counterbalancing + attention filters, get a green "ready" signal, activate, and collect data that is silently neither counterbalanced nor attention-filtered — with no error anywhere. That single failure class (config silently dropped + integrity checks client-side) is what blocks publishable use.

---

## 1) Current status at a glance

| Capability | Status | Evidence |
|---|---|---|
| Token auth (HMAC sign + hash gate, 14d expiry, timing-safe) | **complete** | `src/lib/experiments/run-token.ts:50-107` |
| Block ingest: monotonic order + rate limit + row lock | **complete** | `block/route.ts:200-235` (`rpc_ingest_block`); migration 00023 |
| PII scrub (recursive, depth-capped) + pilot prefix isolation | **complete** | `block/route.ts:38-64,275-280` |
| Completion code mint (retry on 23505) + verify loop | **complete** | `block/route.ts:321-359` |
| Sandbox/postMessage boundary | **complete** | `run-shell.tsx` (bridge) |
| Online screener: author → answer → **server**-grade → record | **complete** | `screener/route.ts:48-79,150-196` |
| Cross-study exclusion + dup check at **booking** time | **complete** | migration 00045; `OnlineRuntimeConfig.exclude_experiment_ids` types:91-94 |
| **Phase-2 config persists** (preflight/counterbalance/attention/exclude/SRI) | **BROKEN** | type declares all 5 (`types/database.ts:55-94`); zod schema omits all 5 (`validation.ts:209-238`), plain `z.object()` no `.passthrough()` → stripped on INSERT/UPDATE |
| Attention checks graded server-side | **BROKEN** | graded in browser `run-shell.tsx:1158-1167`; `correct_answer` shipped via SSR (`page.tsx:9-12` self-documents the leak) |
| Counterbalanced condition assigned on happy path | **BROKEN** | `rpc_assign_condition` only in `session/route.ts:120-127`; run-shell never fetches `/session`; SSR reads `condition_assignment` raw (`page.tsx:199`) → null for fresh bookings |
| Screener pass/fail enforced at ingest | **BROKEN** | `block/route.ts` does zero screener/eligibility check; valid token + curl bypasses screen |
| Screener correct-answers hidden from participant | **BROKEN** | `/session` strips via `publicScreenerUI` (`session/route.ts:161`), but SSR run page ships raw `validation_config` (`page.tsx:222`, consumed `run-shell.tsx:993`) |
| Analysis-ready CSV reachable from UI | **BROKEN** | `data-export-csv/route.ts` exists but no UI link; the "CSV 다운로드" button is a client-side booking-list dump (`bookings-manager.tsx:185-192,277`); `data-export` button only `window.open`s first 10 block JSONs (`:287,313`) |
| Storage listing pagination | **BROKEN** | `.list(experimentId, { limit: 1000 })` no offset loop (`data-export-csv/route.ts:68,82,86,95`) → silent loss >1000 |
| Multi-session storage path (TimeExpOnline1 5-day) | **BROKEN** | path `{experiment_id}/{subject_number}/block_{N}.json` (migration 00023:347; `block/route.ts:280`); all sessions in a group share subject_number → day-2 block_0 collides, `upsert:false` rolls back permanently |
| Link revocation | **BROKEN** | `token_revoked_at` read by every gate (page/block/session/attention) but only ever written `null` (`reissue-token/route.ts:70`); never set → no revoke path |
| Activation gate asserts online readiness | **partial** | `status/route.ts:49-59` checks only `code_repo_url` + `data_path`; no entry_url/screener/counterbalance assertion |
| Screener `validation_config` constrained | **partial** | stored as unconstrained object; malformed config can pass everyone at grade time (`screener/route.ts:48-79`) |
| Exclusion / dedup re-checked at /run | **partial** | enforced booking-time only; dup match limited to `status='confirmed'` → mid/post-run re-enroll possible |
| Preflight psychophysics rigor (refresh/DPR/visual-angle) | **partial/missing** | `preflight` type has only min_width/height/keyboard/audio (`types:68-75`); no refresh-rate/DPR; pushed onto researcher JS |
| `sessionIndex` exposed to bridge | **missing** | bridge exposes `subject`/`condition` only (`run-shell.tsx:241`); multi-session can't auto-resolve the day |
| entry_url versioning / rollback / pinning | **missing** | mid-study edit silently re-points all in-flight + future participants |
| In-block resume | **partial** | refresh mid-block discards partial; relies on researcher JS reading `blocks_submitted` |
| On-demand / immediate online run | **partial** | online forced through offline calendar-slot picker |

---

## 2) Core gaps, prioritized (impact × effort)

Ordered for "what must be true before a real recruited study can run." Effort: S<½d, M≈1-2d, L≈3-5d.

| # | Gap | Impact | Effort | Why it gates production |
|---|---|---|---|---|
| **P0-1** | Phase-2 config silently stripped by zod | critical | **S** | Single root cause: counterbalance/attention/preflight/exclude/SRI all vanish on save. Fixing the schema is the keystone — every other integrity feature is downstream of config actually persisting. |
| **P0-2** | Attention `correct_answer` client-graded + leaked | critical | **M** | Anti-cheat is trivially defeated; integrity claim is false. Must move grading server-side and stop shipping the answer. |
| **P0-3** | Screener gate is client-only; ingest never checks eligibility | critical | **M** | Ineligible participant with a valid token curls past the screen into the dataset with a minted code. Screening must be an ingest-side guarantee, not a UX nudge. |
| **P0-4** | Multi-session storage-path collision | critical | **M** | The advertised 5-day TimeExpOnline1 paradigm *cannot complete* — day-2 block_0 permanently rolls back. Blocks the headline use case. |
| **P1-5** | Counterbalanced condition never assigned on happy path | high | **M** | `condition` is null for fresh bookings; any counterbalanced study collects unbalanced data. Needs one automatic delivery channel. |
| **P1-6** | Analysis-ready CSV unreachable + capped at 1000 + missing screener/attention/session columns | high | **M** | Data goes in but doesn't come out usable. Researcher can't make exclusion decisions or run analysis without manual URL-typing; silent loss past 1000 rows. |
| **P1-7** | Activation has no online readiness gate; green "ready" lies | high | **S** | A study can go live with stripped config and no screeners. The completeness signal must reflect reality. |
| **P2-8** | No working revoke; entry_url no versioning/pinning | medium | **M/L** | A compromised/wrong link can't be killed; a mid-study entry_url edit silently splits the cohort. Ops/lifecycle safety. |
| **P2-9** | sessionIndex not exposed; preflight lacks psychophysics rigor | medium | **M/L** | Multi-session falls back to self-report; timing studies get silent data-quality holes. |

**Security-first ordering rule (per directive):** P0-1 → P0-2 → P0-3 land before anything cosmetic. P0-1 is also a hard prerequisite for P0-2 (attention spec can't be enforced if it never persists) and P1-5 (counterbalance_spec can't be read if stripped).

---

## 3) Self-evolve execution plan (build → review loop)

Each step: target files / change direction / verification / risk. Security defects are first. Run a hostile review pass after each build step before moving on.

### Step A — P0-1: Persist Phase-2 config (KEYSTONE, do first)
- **Target:** `src/lib/utils/validation.ts:209-238` (the `online_runtime_config` zod object).
- **Change:** Add validated keys mirroring `OnlineRuntimeConfig` (`types/database.ts:55-94`): `entry_url_sri` (regex `^sha(256|384|512)-`), `preflight` (object), `counterbalance_spec` (discriminated union on `kind`), `attention_checks` (array; `correct_answer` required, `position` matches `^after_block:\d+$|^random$`), `exclude_experiment_ids` (uuid array). Do **not** just `.passthrough()` — validate, so malformed config is rejected at author time, not silently grading everyone (closes the partial screener finding too). Re-apply via `experimentEditSchema = experimentObjectSchema.partial()` (already derived at `:257`).
- **Verify:** Author a counterbalanced + attention experiment in the Phase-2 UI → save → re-fetch the row → assert all 5 keys present in `online_runtime_config`. Add a unit test feeding a full config through `experimentObjectSchema.parse` and asserting no key loss.
- **Risk:** **low.** Pure widening; offline path unaffected (config stays nullable). Watch the zod/v4 `.partial()` + refine interaction already documented at `:252-257`.

### Step B — P0-2: Server-side attention grading + stop leaking answers
- **Targets:** `src/app/api/experiments/[experimentId]/data/[bookingId]/attention/route.ts` (grade here); `run-shell.tsx:1158-1167` (remove client compare); `page.tsx` (strip `correct_answer` before passing config to shell, mirror `publicScreenerUI` pattern from `session/route.ts:161-189`).
- **Change:** Shell POSTs `{check_id/index, answer}` to `/attention`; route loads the experiment's `attention_checks` from `online_runtime_config` server-side, compares, and calls `rpc_record_attention_failure` on miss (RPC already exists, used at `block/route.ts:253` and `screener/route.ts:166`). Strip `correct_answer` (and screener `accepted`/`required_answer`) from the SSR config so the browser never sees them.
- **Verify:** Open `/run`, inspect the serialized config in devtools → assert no `correct_answer`. Submit a wrong attention answer via direct POST → assert `attention_fail_count` increments server-side. Submit the "right" answer the participant could never have known → still graded correctly.
- **Risk:** **medium.** Must keep the off-by-one fix in mind — guide §6 says `position: "after_block:N"` 0-indexed and `correct_answer ∈ options` (guide:198-199,358); align injection index with the guide and re-scale the `random` placement probability (run-shell finding).

### Step C — P0-3: Eligibility gate at ingest
- **Target:** `block/route.ts` (after token+hash gates, before `rpc_ingest_block` at `:201`).
- **Change:** Before accepting block_0, assert all `required` screeners for the experiment have a `passed=true` row for this booking (query `experiment_online_screener_responses`). Reject with `SCREENER_NOT_PASSED` (409) otherwise. Optionally re-check `exclude_experiment_ids` here (closes P2 partial: exclusion only at booking-time). This makes screening an integrity guarantee, not a client phase.
- **Verify:** With a valid token but no passed screeners, `curl` block_0 → expect 409. Pass screeners → block_0 accepted. Confirm a legitimate run still completes end-to-end.
- **Risk:** **medium.** Don't break the happy path — gate only when `required` screeners exist; "screener lock relies on blocks_submitted>0" finding means you must enforce *before* block 0, not after.

### Step D — P0-4: Session-scoped storage path
- **Targets:** `block/route.ts:275-280` (path build); migration (new) to carry a session dimension; bridge in `run-shell.tsx`.
- **Change:** Include a session segment in the object path: `{experiment_id}/{pilot}/{subject_number}/session_{S}/block_{N}.json`. Source `S` from `booking.session_number` (multi-session bookings already carry `session_number` per `bookingRequestSchema` at `validation.ts:267`). Update `data-export-csv` listing + CSV columns to include session (ties into Step F).
- **Verify:** Seed a 2-session booking group, upload block_0 for session 1 and session 2 → both succeed, no rollback, distinct paths. Re-run the TimeExpOnline1 demo across 2 simulated days.
- **Risk:** **medium.** Path change is back-incompatible for any existing single-session data; keep a fallback read (no `session_` segment ⇒ treat as session 1) in the export reader. Scope test fixtures to a throwaway experiment id (multi-session collab rule).

### Step E — P1-5: Automatic condition delivery
- **Targets:** `page.tsx:107-128` (SSR progress fetch) OR `run-shell.tsx` mount.
- **Change:** Pick **one** channel. Cleanest: in the SSR page, if `progress.condition_assignment` is null and `counterbalance_spec` exists, call `rpc_assign_condition` (same RPC `session/route.ts:123`) before rendering, so `booking.condition` is populated deterministically and stored. Then either delete the now-redundant `/session` assignment branch or keep `/session` as the single channel and make run-shell fetch it on mount — but not both unguarded (avoid double-assign race; RPC is idempotent/stored-on-first-call, verify that).
- **Verify:** Fresh booking with a `counterbalance_spec` → open `/run` → `expPlatform.condition` is non-null and stable across reloads; distribution across N bookings matches the spec (latin_square/block_rotation/random).
- **Risk:** **medium.** Requires Step A done (spec must persist). Confirm `rpc_assign_condition` is idempotent under concurrent first-load.

### Step F — P1-6: Real export path
- **Targets:** `data-export-csv/route.ts:68,82,86,95` (pagination); add UI button in `bookings-manager.tsx` near `:277`; widen CSV columns.
- **Change:** Loop `.list` with `{ limit, offset }` until exhausted (remove the silent 1000 cap). Add a "분석용 CSV" button wired to `data-export-csv`. Add columns: `session`, screener pass/fail, `attention_fail_count`, condition, and `block_metadata` (session schedule/calibration/seed). Provide a JSON-cell fallback for nested trial values instead of `[object Object]`; stop blanking researcher-supplied `trial_index`.
- **Verify:** Export an experiment with >1000 blocks → row count matches storage. Open CSV → session + screener + attention columns present; nested values are valid JSON cells.
- **Risk:** **medium.** Large exports may need streaming; cap memory. No data-path risk (read-only).

### Step G — P1-7: Online activation gate + honest completeness signal
- **Targets:** `status/route.ts:49-59`; completeness sidebar component.
- **Change:** When `experiment_mode !== 'offline'` and `nextStatus === 'active'`, additionally require: valid `entry_url`, and (if `counterbalance_spec`/`attention_checks` present) that they parsed under the new schema. Make the sidebar "ready to publish" signal reflect persisted config, not UI-local state — read back what actually saved.
- **Verify:** Try to activate an online experiment with stripped/missing entry_url → 400. With full config → activates. Sidebar shows red until config actually persists.
- **Risk:** **low.** Additive gate; does not touch offline activation.

### Step H — P2-8/9: Ops levers (revoke, pinning, sessionIndex, preflight) — after integrity is solid
- **Targets:** new revoke route (set `token_revoked_at` — the column + every read gate already exist, only the writer is missing); entry_url versioning column; bridge `sessionIndex` (`run-shell.tsx:241`); `preflight` refresh-rate/DPR fields (`types:68-75`).
- **Verify:** Revoke a token → `/run` shows revoked screen, ingest 401s. Expose `expPlatform.sessionIndex` → demo auto-resolves the day. Preflight blocks a sub-spec refresh rate.
- **Risk:** **medium/low.** Independent of the data path; sequence last.

---

## 4) Decisions the researcher (user) must make

These are policy choices, not engineering defaults — flag before building the dependent step:

1. **Timing-precision target (P2-9).** What rigor must preflight enforce — refresh-rate floor (e.g. ≥60 Hz), DPR/visual-angle calibration, fullscreen lock? Determines whether psychophysics studies are trustworthy or stay "researcher-JS owns it." *(Blocks Step H preflight scope.)*

2. **Data-retention / export format (P1-6).** One analysis-ready CSV (current `data-export-csv` shape) vs. long-format-per-trial vs. raw per-block JSON bundle? Should `block_metadata` (calibration/seed/session schedule) be a separate sidecar or inlined columns? Decides Step F column design.

3. **External-JS policy (entry_url / SRI).** Is `entry_url_sri` pinning **mandatory** for activation, or advisory? Mandatory SRI = reproducible cohort but friction on every researcher release; advisory = a swapped CDN payload can silently change the running experiment. *(Affects Step A validation strictness + Step G gate + Step H pinning.)*

4. **Multi-session identity model (P0-4).** Is `session_number` authoritative from the booking, or should the platform expose/resolve it from a schedule? Confirms how Step D sources the session segment and what `sessionIndex` means.

5. **Eligibility strictness at ingest (P0-3).** Should *all* screeners (not just `required`) gate block_0, and should `exclude_experiment_ids` be re-checked at /run (not only booking)? Defines the reject conditions in Step C and whether dup-prevention widens beyond `status='confirmed'`.

6. **Attention-fail policy.** Is a high `attention_fail_count` an auto-exclude (block ingest / withhold completion code) or a post-hoc filter the researcher applies during export? Determines whether Step B's server-grade just records or also gates.

---

### One-line maturity, consolidated
The online runtime's ingest/transport spine is publishable-grade; its authoring-trust-egress loop is not. Land P0-1 (schema), P0-2 (server attention), P0-3 (ingest eligibility), P0-4 (session path) — four small/medium, well-scoped fixes — and online studies created through this UI become trustworthy for single- and multi-session recruited research. Until then, only single-condition, no-attention-gating, single-session studies are safe.
