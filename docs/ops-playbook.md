# Ops playbook

Single-entry reference for operating the Exp_Platform deployment.
Most recent update: 2026-04-24.

## Production surface

| Resource | URL / handle |
|---|---|
| Prod app | https://lab-reservation-seven.vercel.app |
| Vercel project | `vnilab-9610s-projects/lab-reservation` (project id `prj_rcNGgrYjknxVnebNN5xPa1rHkGtL`) |
| Supabase project | `qjhzjqkrbvsnwlbpilio` (region ap-northeast-2) |
| Notion DB | https://www.notion.so/3482a38e4f5f800298e7d7a07294ccd0 (SLab) |
| GitHub | https://github.com/CSNL-vnilab/Exp_Platform_by_Joonoh |
| Google Calendar | `dvjmpc33e56l0euaq4c0dekvu4@group.calendar.google.com` |
| Reference experiment | `fb1cc943-4419-49c9-8dbd-9314888280dd` |

## Day-to-day commands

```bash
# One-shot sanity audit of DB schema + constraints + trigger presence
node scripts/db-audit.mjs

# Idempotent Notion schema verify (no-op on healthy DB; reports drift)
node scripts/notion-setup.mjs

# End-to-end Notion write smoke test (creates 2 demo pages)
node scripts/notion-demo.mjs

# Continuous QC loop — db-audit + notion-setup every 20 min.
# Intended to run under the Monitor tool during active ops.
node scripts/qc-loop.mjs --interval=1200

# Apply a new migration to prod
node scripts/apply-migration-mgmt.mjs supabase/migrations/000XX_xxx.sql

# Dry-run salt rotation (requires migration 00033+)
node scripts/salt-rotate.mjs
node scripts/salt-rotate.mjs --confirm   # execute
```

## Deploy workflow

**GitHub push → Vercel auto-deploy is currently flaky.** Observed on
2026-04-23: pushes after commit `91wu4x3d7`'s deploy weren't triggering
new builds; production alias stuck ~2h behind HEAD. Root cause
unconfirmed (GitHub → Vercel webhook likely out of sync).

**Migration ordering rule (important):** apply any enum-extension or
`CREATE OR REPLACE FUNCTION` migration to prod Supabase **before**
deploying the code that depends on it. Deploying first opens a window
where the new code can 500 against the old schema (e.g. INSERTs with a
new enum value, RPCs with a new signature). Fast-path pre-checks at
the route layer sometimes mask this, but never rely on it. Run
`node scripts/migration-status.mjs` before every deploy; apply any
pending rows with `node scripts/apply-migration-mgmt.mjs <file>` in
filename order.

**Preferred deploy path for now:**

```bash
# From the repo root with .vercel/ populated
npx vercel --prod --yes
# Prints the new deployment URL; it is auto-aliased to
# lab-reservation-seven.vercel.app on success.
```

If the deploy completes but the production alias doesn't flip:

```bash
npx vercel promote <deployment-url> --yes
# Confirms alias swap; 409 if already live.
```

To verify prod matches local after a deploy:

```bash
NEXT_PUBLIC_APP_URL=https://lab-reservation-seven.vercel.app \
  node scripts/smoke-cron-auth.mjs
# All six cron endpoints must return 401 (auth active, route present).
# Exits 1 on any 404/500/200 — that means the deploy dropped the
# handler or auth regressed.
```

For a faster inline spot-check that also authenticates, keep the
curl loop handy:

```bash
for p in /api/notifications/reminders \
         /api/cron/auto-complete-bookings \
         /api/cron/notion-retry \
         /api/cron/notion-health \
         /api/cron/outbox-retry \
         /api/cron/promotion-notifications \
         /api/cron/metadata-reminders; do
  curl -sS -o /dev/null -w "%{http_code} $p\n" -X POST \
    "https://lab-reservation-seven.vercel.app$p" \
    -H "x-cron-secret: $CRON_SECRET"
done
```

All seven must be `200` or `401` — a `404` means the deploy missed that
route.

## Cron inventory

| Schedule | Path | Fallback |
|---|---|---|
| Daily 00:30 UTC (09:30 KST) | `/api/notifications/reminders` | `.github/workflows/reminders-cron.yml` every 15 min |
| Daily 17:15 UTC (02:15 KST+1d) | `/api/cron/auto-complete-bookings` | `.github/workflows/auto-complete-cron.yml` daily |
| Daily 16:00 UTC | `/api/cron/notion-health` | `.github/workflows/notion-health-cron.yml` daily |
| Every 30 min | `/api/cron/outbox-retry` | `.github/workflows/outbox-retry-cron.yml` every 30 min — unified retry cron covering notion/gcal/sms/email (D6). 00044 enum extension live on prod (2026-04-24). Succeeded the legacy `/api/cron/notion-retry` on 2026-04-24; recover deleted route via `git log --diff-filter=D -- src/app/api/cron/notion-retry/route.ts`. |
| Every 30 min | `/api/cron/promotion-notifications` | `.github/workflows/promotion-notifications-cron.yml` every 30 min — sends Royal-promotion emails to experiment owners (D8, migration 00038) |
| Weekly Mon 00:00 UTC (09:00 KST) | `/api/cron/metadata-reminders` | `.github/workflows/metadata-reminders-cron.yml` weekly — emails each researcher whose draft/active experiments are missing code_repo_url / data_path / pre_experiment_checklist. Dedup'd via `metadata_reminder_log` (migration 00048): at-most-one email per researcher per 7 days. |

Only the first two are declared in `vercel.json` (Vercel Hobby caps at
2 crons per project). Notion / outbox / promotion crons run exclusively
via GitHub Actions; same `CRON_SECRET` auth.

All endpoints use `timingSafeEqual` on CRON_SECRET with `MIN_SECRET_LENGTH=32`.

## Outbox retry semantics

- Each booking gets four outbox rows on create (`gcal`, `notion`,
  `email`, `sms`). Initial attempt fires inline during the booking
  pipeline; failures leave `status='failed'` with `attempts=1`.
- `/api/cron/outbox-retry` (D6, supersedes the deleted `/api/cron/notion-retry`
  route as of 2026-04-24) handles **all four** integration types
  (notion / notion_survey / gcal / sms / email) via the generic
  `claim_next_outbox_retry(p_types[])` RPC (migration 00037) + service
  layer (`src/lib/services/{gcal,sms,email}-retry.service.ts`). Same
  400ms pacing, same auth, same 5-attempt cap. Dedup guards per type:
  notion via `notion_page_id IS NULL`, gcal via `google_event_id IS
  NULL`, email via sibling `booking_integrations` rows for the same
  `booking_group_id`. Sweep summary lands in
  `notion_health_state.check_type='outbox_retry_sweep'` (migration
  00044 extends the enum).
- Email-retry drops runLinks / paymentLink from the resent email —
  those carry HMAC tokens that would be invalidated by re-issue. A
  preface explains the context to the participant.

## Rate limits in play

- **Notion API**: 3 rps sustained / 10 rps burst per integration.
  `src/lib/notion/rate-limit.ts` reads `X-RateLimit-Remaining` +
  `X-RateLimit-Reset` + `Retry-After` on every response and
  pre-emptively sleeps. Retry cron also paces at 400ms between claims
  and short-circuits on 429.
- **Supabase Management API**: shared rate limit across operations;
  `scripts/apply-migration-mgmt.mjs` has hit 429 once this session.
  Back off 60-90s between consecutive invocations on first attempt.
- **Gmail API** (send): not rate-limited in our volume.
- **Solapi SMS**: not rate-limited in our volume.

## Security invariants (do not regress)

1. Participant PII never in Google Calendar event titles. Enforced via
   `calendarTitle()` in booking.service.ts; no direct PII fields used.
2. `labs.participant_id_salt` and `labs.participant_id_salt_previous`
   readable only by `service_role`. Verified by
   `scripts/db-audit.mjs` → `checkSaltPrivilege` + `checkSaltPreviousPrivilege`.
3. RLS must stay enabled on every public table. db-audit's `checkRls`
   is CRITICAL severity.
4. `get_researcher_pending_work()` uses `auth.uid()` internally; never
   accepts a user_id argument (IDOR defense, migration 00035).
5. Admin-bound routes (status transitions, class assignments) use
   `createAdminClient()` ONLY after verifying ownership / role via
   cookie-bound client.

## On-call runbook snippets

### Participant reports they can't book (PARTICIPANT_BLACKLISTED)

Check `participant_class_current` for that phone+email → confirm the
class. If correctly blacklisted, confirm the reason in
`participant_class_audit` and reach back via the researcher on the
experiment.

### Researcher reports "Notion rows aren't updating"

1. Run `node scripts/notion-setup.mjs` — re-verifies schema.
2. Check `notion_health_state` → latest `schema_drift` row. If
   `healthy=false`, the sidebar on `/dashboard` shows the diff.
3. Check `notion_health_state` → latest `retry_sweep`. If
   `still_failed > 0`, pull `booking_integrations` rows with
   `status='failed' AND attempts>=5` — those need human retry via the
   experiment detail page's "Notion 재동기화" button.

### Salt suspected compromise

Follow `docs/salt-rotation.md`. Dry-run first. After rotation run
`node scripts/db-audit.mjs` — `SALT` and `SALT_PREVIOUS` must both
stay OK.

### Experiment won't activate ("코드 저장소와 데이터 경로 필요")

The DB trigger enforces code_repo_url and data_path. Fill both in the
edit flow; sidebar shows "활성화 전 필수" tiles until they're set.

## Migration log (current prod state)

Run `node scripts/migration-status.mjs` before each deploy to see
which migrations on disk are newer than the marker below. The script
parses THIS doc's "Last applied" line and "NOT applied" blocks, so
keep those sections in sync when you apply a migration to prod.

Last applied to prod: `00051_payment_link_dispatch.sql` on
2026-04-30.

Staged for next deploy (apply after push):
- (none — all on-disk migrations applied as of 2026-04-30)

Full list: `ls supabase/migrations/`.

Stream 2's `00024_participant_payment_info.sql` is still on disk but
NOT applied to prod. Stream 2 owner runs their own migration.

## Cron cutover log — notion-retry → outbox-retry (completed 2026-04-24)

Historical record; preserved so rollback ordering is obvious.

Prereqs (met): migrations 00044 + 00046 on prod, outbox-retry route
deployed. Steps executed in order:

1. ✅ outbox-retry served 401 on the deployed URL.
2. ✅ Manual fire with the real secret wrote a
   `notion_health_state.check_type='outbox_retry_sweep'` row with the
   expected summary shape.
3. ✅ Uncommented `schedule:` in `.github/workflows/outbox-retry-cron.yml`.
4. ✅ Commented out `schedule:` in `.github/workflows/notion-retry-cron.yml`
   (later deleted with the route — step 5).
5. ✅ Deleted `src/app/api/cron/notion-retry/route.ts` + the legacy
   workflow file. The service file (`notion-retry.service.ts`) stays —
   outbox-retry imports from it.

**Rollback** if outbox-retry regresses: `git revert` the deletion commit
and the workflow cutover commit, or cherry-pick the route back from
`git log --diff-filter=D -- src/app/api/cron/notion-retry/route.ts`.
