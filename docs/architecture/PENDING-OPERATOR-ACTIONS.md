# Pending operator actions

> 2026-06-04 — post-auto-loop review handoff. The autonomous loop
> (Phase A + iter 1-39, see [`README.md`](./README.md)) finished every
> task that Claude could do safely without a human in the loop. The
> items below are the remainder — each needs a credential, a secret,
> or a `workflow`-scoped push that Claude's token doesn't have.
>
> Researcher decision (2026-06-04 review interview): **Claude preps the
> doable parts; the human executes the credentialed steps.** This file
> is that prep — work top to bottom.

---

## 1. Wire the Slack cron-failure alerts + the GCal orphan-reaper cron

**Why it's pending:** Claude's OAuth token lacks the `workflow` scope,
so any push that touches `.github/workflows/*.yml` is rejected by
GitHub. The composite action (`.github/actions/notify-cron-failure/`)
IS already on `main` (iter 1); only the per-workflow wiring + the new
reaper cron file are outstanding.

**What's prepared:** [`../ops/cron-slack-wiring.patch`](../ops/cron-slack-wiring.patch)
— a single patch with 10 changes:

- 9 existing cron workflows gain a final `if: failure()` step that
  calls the composite action (auto-complete, db-quality,
  metadata-reminders, notion-health, outbox-retry, prod-smoke,
  promotion-notifications, reminders, timeexp-data-integrity).
- 1 new file `gcal-orphan-reaper-cron.yml` (6-hourly, `grace_hours=12`).

**Apply (needs a `workflow`-scoped token / a human's normal push):**

```bash
git fetch origin && git checkout main && git pull   # get this patch
git apply docs/ops/cron-slack-wiring.patch
git add .github/workflows .github/actions
git commit -m "chore(cron): wire Slack failure alerts + gcal-orphan-reaper cron"
git push origin main
```

If the patch ever drifts (a workflow file changed upstream), regenerate
the intent from [`../cron-runbook.md`](../cron-runbook.md) §2 + §5 —
both already document the exact YAML blocks.

## 2. Register the Slack webhook secret

Without this the notify step is a silent no-op (the workflow still goes
red ✕ in the Actions tab — see `notify-cron-failure/action.yml`).

```bash
# Slack → Apps → Incoming Webhooks → pick the ops channel → copy URL
gh secret set SLACK_WEBHOOK_URL --body "https://hooks.slack.com/services/T.../B.../..."
```

Order doesn't matter vs step 1 — either can land first.

## 3. Migration marker — already reconciled

Confirmed in the 2026-06-04 review that migrations **00058-00067 are
applied to prod**. `docs/ops-playbook.md` § "Migration log" was frozen
at `00057` (2026-05-04) and has been advanced to the `00067` frontier
with that provenance. No action needed unless a later check shows
otherwise — the playbook documents the one-line
`SELECT enum_range(NULL::payment_status);` verification (the Phase A2
partial-cancel path depends on the `'cancelled'` value from `00066`).

---

## Quick prod health re-check (any time, read-only)

```bash
node scripts/smoke-all.mjs        # cron-auth + secret-audit + queue + pii
# or individually, with the cron secret:
curl -sS -H "x-cron-secret: $CRON_SECRET" \
  https://lab-reservation-seven.vercel.app/api/health/secret-audit | jq .
curl -sS -H "x-cron-secret: $CRON_SECRET" \
  https://lab-reservation-seven.vercel.app/api/health/queue | jq .
curl -sS -H "x-cron-secret: $CRON_SECRET" \
  https://lab-reservation-seven.vercel.app/api/health/rate-limit | jq .
```

`secret-audit` should report `anyFellThroughToServiceRole: false`
(all 5 token secrets set explicitly — see
[`../../DEPLOY.md`](../../DEPLOY.md) § Token-secret rotation 주의).
