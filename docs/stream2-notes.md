# Stream 2 Notes

Working record of what's been shipped on the online-experiment stack and
what's deferred. Not a live TODO — just a breadcrumb so the next session
doesn't rediscover what's here.

## Shipped (cumulative)

**Phase 1** — runtime foundation
- Migration 00023: `experiment_mode`, `online_runtime_config`,
  `data_consent_required`, `experiment_run_progress`, storage bucket.
- RunShell with sandboxed iframe, signed HMAC tokens, column-level
  GRANTs, rate-limited block ingestion, completion-code verification.
- Reissue-token, data-export (signed URLs), verify endpoint.
- 17/17 E2E against real Supabase + Vercel.

**Phase 2** — researcher toolkit
- Migration 00032: `is_pilot`, `condition_assignment`,
  `attention_fail_count`, `behavior_signals`, `entry_url_sri`;
  `experiment_online_screeners` + `_responses`; RPCs
  `rpc_assign_condition`, `rpc_record_attention_failure`,
  `rpc_merge_behavior_signals`.
- Migration 00033: post-review hardening — rpc_assign_condition NULL
  on missing row; numeric-merge rejects NaN/Infinity.
- Shell phases: consent → screener → preflight → ready → running →
  completed → blocked. Each gate skips when empty.
- LLM honeypot (hidden DOM trap word, auto-flag on submission).
- rAF frame-jitter + focus-loss + paste + tab-switch telemetry,
  flushed per block into `behavior_signals`.
- Researcher preview (/experiments/:id/preview-run) — token-less,
  dry-run the full participant flow.
- Live session dashboard (/experiments/:id/live) with Supabase
  Realtime, idle detection, experiment-scoped filter.
- Form UI: preflight toggles, counterbalance spec, SRI, exclusion
  list, attention-check editor, embedded OnlineScreenerEditor.
- Bookings table: pilot/condition/attention/screener badges,
  pilot toggle pre-first-block.
- Cross-study exclusion enforced in /api/bookings for online-mode.
- Trial-level CSV export with optional pilot inclusion.

All migrations applied to remote Supabase. All E2E green on local.

## Hard to implement now — deferred

- **jsPsych first-class upload** (`experiment.zip` → Storage extract →
  auto-wire `on_finish`). Multi-day. Current contract (any JS that
  calls `expPlatform.submitBlock`) already works for jsPsych.
- **Longitudinal scheduling** (session N+1 in 7±1d window after N).
  Needs reminder-cron integration + new per-session scheduling table.
- **Researcher API tokens** (Bearer-auth external integrations).
  Separate table + admin UI + rate limiting. Scope creep.
- **Keystroke cadence / paste-shape telemetry** beyond current
  paste-count + tab-switch. Requires iframe-internal keyboard hooks,
  which collide with researcher JS ownership of the focus.
- **Attention-check auto-injection by the shell of Prolific-style
  IMCs inside the iframe**. The current attention-check modal OVERLAYS
  the iframe. Injecting WITHIN would need a researcher-JS contract
  (pause/resume) that would break existing paradigms.
- **Biometric identity / Onfido-style verification.** Out of scope —
  university-lab participant pool is institutionally trusted.
- **VPN/proxy enforcement** — needs paid IP-intel service.
- **Webcam / WebGazer eye-tracking.** jsPsych has it; calibration
  drop-off is brutal. Not worth the plumbing until a study needs it.
- **Rich consent form with e-signature + WORM storage.** Current
  consent checkbox + IRB URL is enough for most lab IRBs.

## Intentional non-goals (vs Prolific)

- Marketplace recruitment / anonymous participant pool.
- Reputation / approval-rate filters.
- Automated bonus payments (Stream 3 handles settlement via bank
  export).

## Review findings closed

- C1 live dashboard cross-experiment leakage → filter:booking_id=in(...)
- C2 rpc_assign_condition missing-row silent write → NULL return
- H1 rpc_merge_behavior_signals NaN/Infinity crash → skip bad samples
- H2/H3 attention route bumps before experiment_id verify → moved check
- H5 screener upsert cross-experiment hijack → validate id ownership
- H6 SRI attribute injection → setAttribute-only path
