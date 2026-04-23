# Next sprints — rolling plan

Updated continuously as work lands. Candidates are ordered by expected
leverage given the current infrastructure state (as of commit 146d859
on main).

## Shipped in this session (for context)

| # | Sprint | Status |
|---|---|---|
| D1 | Notion drift detection + race-safe retry worker | ✅ migrations 00031/00032, rate-limit wrapper |
| D2 | Operational dashboard pending-work widgets | ✅ migrations 00034/00035/00036 |
| D4 | DB audit + salt rotation | ✅ migrations 00033, scripts/db-audit.mjs (14 checks), scripts/salt-rotate.mjs + runbook |
| D5 | Researcher field requirement clarity | ✅ docs/experiment-field-requirements.md, ExperimentFormCompleteness sidebar on /new + /[id]/edit |
| D6 | Outbox retry generalisation (foundation) | ✅ migration 00037 generic claim_next_outbox_retry RPC; service layer deferred |
| D8 | Auto-promotion notification emails | ✅ migrations 00038/00040/00041, /api/cron/promotion-notifications with transient-retry + RLS disabled gate + researcher-scope tightening (only notifies researchers who ran the participant's sessions) |
| D8.5 | Class-delete audit trigger | ✅ migration 00039 — direct SQL DELETE on participant_classes now logs into audit trail |
| — | Notion rate-limit-aware fetch wrapper | ✅ src/lib/notion/rate-limit.ts; client.ts refactored |
| — | Background QC loop (db-audit + notion health) | ✅ scripts/qc-loop.mjs under Monitor |
| — | Ops playbook + rolling plan + MIN_SECRET_LENGTH consistency | ✅ |
| — | 2026 calendar backfill (Projects pages + SLab rows + linkage) | ✅ commit 129c087 |
| — | Consistency review round 2 (C1-C4 / H1-H5 resolved) | ✅ commit ba217dc |
| — | Projects page metadata fill (담당자/기간/상태/분류/참여자 수/코드 디렉토리) | ✅ commit ba217dc |
| — | In-app research-metadata reminder (dashboard + detail banner) + M12 stale-relation refetch | ✅ commit 961c5b2 |

## D6 — Outbox retry generalisation (high leverage)

**Status:** shipped — all four integration types (notion, gcal, sms,
email) have symmetric retry semantics under `/api/cron/outbox-retry`.

**What landed:**
- Foundation: migration 00037 (generic `claim_next_outbox_retry` RPC).
- Services: `notion-retry.service.ts` (pre-existing), `gcal-retry.service.ts`,
  `sms-retry.service.ts`, `email-retry.service.ts`.
- Route: `/api/cron/outbox-retry` dispatches on `integration_type`.
- Template extract: `buildConfirmationEmail` in `booking-email-template.ts`
  — pure helper shared by runtime pipeline AND the email retry.
- Review-fix migration: 00044 adds `outbox_retry_sweep` to the health
  enum so sweep summaries land.
- Health card: merged Notion/outbox sweep display.

**Retry semantics per type:**

| Type | Dedup guard | Replay token behaviour |
|---|---|---|
| notion / notion_survey | `bookings.notion_page_id IS NULL` | N/A |
| gcal | `bookings.google_event_id IS NULL` (best-effort; see M1 comment) | N/A |
| sms | no dedup (accepted — Solapi double-sends are a nuisance, not a disaster) | N/A |
| email | implicit via Gmail message-id history | runLinks + paymentLink omitted; preface explains why |

**Still TODO (not blocking):**
- Dashboard pending-work RPC gains `gcal_stuck`, `email_stuck`,
  `sms_stuck` counters so PendingWorkCard covers all retries, not just
  Notion. Small migration.
- Replace Vercel cron entry `notion-retry` → `outbox-retry` once the
  cutover is confirmed safe. Both routes share auth contract + pacing;
  the dashboard shows the more-recent sweep already.
- `notion-retry` route kept for backward compat; delete once cron
  flipped.

**Exit:** done except for the cron-config cutover.

## D7 — Multi-lab plumbing preparation

**Problem:** CSNL is hardcoded in ~6 places (api/participants routes,
identity service, docs). Adding Lab #2 today would require surgery in
every one.

**Plan:**
- New `lab_members(user_id uuid, lab_id uuid, role text)` table. Backfill
  every current researcher as a CSNL member.
- RLS policies on `participant_classes` / `participant_lab_identity` etc.
  check membership via the new table instead of the current
  "role IN ('admin','researcher')" blanket.
- Add `lab_id` query param to `/api/participants*` routes; default from
  caller's primary membership.
- Dashboard shows "내 소속 랩: CSNL" when exactly one, with switcher UI
  for >1.

**Exit:** adding Lab #2 is `INSERT INTO labs ...` + assign members; no
code changes.

## D8 — Researcher notification emails

**Problem:** Auto-promotion to Royal is invisible until researcher opens
the participant detail page. Outbox dead-letter is invisible unless they
check the dashboard. High-priority transitions should push.

**Plan:**
- `notification_rules` table: per-researcher preferences (e.g. "email me
  on Royal promotion", "email me daily digest of dead-letter rows").
- `/api/cron/notification-digest` (daily, 09:00 KST) sends a summary
  email via the existing gmail.ts helper.
- `recompute_participant_class` trigger also INSERTs a row into
  `pending_notifications` queue table, flushed by the digest cron.

**Exit:** researchers don't need to check dashboard to know about
state changes.

## D9 — Cross-study exclusion enforcement (shipped pending migration apply)

**Status:** code landed. Migration 00045 ready but not yet applied.

**What landed:**
- `supabase/migrations/00045_book_slot_exclude_experiments.sql` — DB-
  level enforcement inside `book_slot`. Reads
  `experiments.online_runtime_config->'exclude_experiment_ids'`, looks
  up the participant's confirmed/running/completed bookings on those
  experiments, returns `{error:'EXPERIMENT_EXCLUDED'}` when any match.
  Runs AFTER participant upsert (needs `v_participant_id`) and BEFORE
  blacklist check.
- `BOOKING_ERRORS.EXPERIMENT_EXCLUDED` in constants.ts with Korean
  participant-facing copy.
- `/api/bookings/route.ts` maps the new error code to HTTP 409; the
  existing app-layer pre-check now emits the same unified message
  (still there as a fast path ahead of the RPC).

**Still TODO:**
- Apply migration 00045 to prod Supabase.

**Exit:** researcher-declared exclusion actually binds, even for
callers that bypass the API route (direct SQL / admin tooling).

## D10 — Consent + withdrawal (IRB deferred from original plan)

User deferred this at the current sprint but it's real IRB debt.
Revisit when ready. Spec already drafted in the earlier plan.

## Open issues (not yet batched into a sprint)

- Notion webhook-based two-way sync (researcher edits Notion → DB
  reflects changes). Currently one-way; 10x leverage if done right.
- GCal freebusy cache still fully refreshes on every `invalidate`. Could
  be per-range invalidation.
- Experiments list page (`/experiments`) has no class filter; hard to
  find "which of my experiments have blacklisted participants trying to
  book."
- participant_class_audit grows unbounded — no retention policy. At 10
  class changes per day × 5 years = 18k rows. Not enormous, but add a
  30d retention+export-to-archive cron eventually.
- Stream 2 payments: migration 00024 still not applied to prod. Stream
  2's sprint needs to run.
