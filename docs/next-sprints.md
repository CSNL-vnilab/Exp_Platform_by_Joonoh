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

**Problem:** Today only `notion` / `notion_survey` integration types have
an atomic claim + retry cron. `gcal`, `email`, `sms` failures in
`booking_integrations` sit in `failed` status forever — no worker. Real
impact: if Gmail refuses a confirmation send once (transient rate limit,
Greylisting, etc.), the participant never gets the email.

**Plan:**
- Generalise `claim_next_notion_retry` → `claim_next_outbox_retry(p_types integration_type[])`
  with the same FOR UPDATE SKIP LOCKED pattern. New migration 00037.
- Extract integration-specific retry services: gcal-retry.service.ts,
  email-retry.service.ts, sms-retry.service.ts — each with its own
  dedupe guard (e.g. GCal: check `bookings.google_event_id` not null
  before creating).
- `/api/cron/outbox-retry` replaces `/api/cron/notion-retry`, dispatches
  to the right service based on integration_type.
- Dashboard pending-work RPC gains `gcal_stuck`, `email_stuck`, `sms_stuck`
  counters. Rename tiles on PendingWorkCard accordingly.

**Exit:** every integration_type has symmetric retry semantics; dashboard
surfaces all four.

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

## D9 — Cross-study exclusion enforcement

**Problem:** Stream 3 added `OnlineRuntimeConfig.exclude_experiment_ids`
to the TypeScript type, but the booking pipeline doesn't enforce it.
Participants who did study A can still book study B even when A
excludes B.

**Plan:**
- Patch `book_slot` RPC to SELECT from `experiments` the
  `exclude_experiment_ids` of the target experiment's
  `online_runtime_config`, then check `EXISTS (SELECT 1 FROM bookings
   b WHERE b.participant_id = v_participant_id AND b.experiment_id =
   ANY(exclude_ids) AND b.status IN ('confirmed','completed','running'))`.
- New error code `EXPERIMENT_EXCLUDED`.
- Surface on public /book/:id page via the existing error banner.

**Exit:** researcher-declared exclusion actually binds.

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
