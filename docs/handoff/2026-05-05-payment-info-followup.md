# Handoff: 2026-05-05 — payment-info follow-up + meta-tooling

## Quick state at handoff

- main HEAD: `319c075` (payment-info form pre-fill audit)
- Last applied prod migration: `00057_paid_offline_constraints.sql` (2026-05-04)
- Vercel deploy: green (verified `experiments` 200, `payment-info/[token]` 200)
- TimeExp1 (`fb1cc943-…`) payment panel state:
  - Sbj 5–9: `paid_offline` (오프라인 정산 — 발송 버튼 숨김)
  - Sbj 10/11/12: `pending_participant`, all bookings completed → "안내 메일 발송"
    버튼 활성. 양진희(11) 상태 확인 못 함 — 사용자가 본인 의사 결정.
  - Sbj 1–4: payment_info row 자체 없음 (booking_group_id null 또는 import
    누락). 사용자가 무시할지 결정 필요.

## What this session shipped (chronological)

| commit | what |
|---|---|
| `ee400a2` | per-group fee fix (× session_count → ×1) + `mark_group_completed` RPC + UI button + migration `00055` |
| `3a7d79c` | payment-info preview page (admin/owner-only iframe + 폼 URL with copy/open) |
| `9b916c8` | `paid_offline` enum status (migrations `00056` + `00057`) + 5 row backfill (Sbj5-9) |
| `319c075` | form pre-fill audit — only email + phone may be pre-filled |

All four committed-from-and-cherry-picked-to-main; remote and prod aligned.

## Hooks / harness / skills retro

### What worked

- **Multi-session AGENTS.md rules (7 items)** — kicked in twice when the working
  tree had untracked files from sibling sessions (`offline-code-analyzer.tsx`,
  `code-analysis-patch.ts`). Did not run any `git restore` / `git clean` /
  `git checkout .` per rule 7. Recovery via cherry-pick + targeted `git add`
  worked both times.
- **`scripts/apply-migration-mgmt.mjs`** — applied 00055/56/57 without
  config friction.
- **Migration status doc convention** (last-applied line in `docs/ops-playbook.md`)
  — bumped each time, gives the next session a single source of truth.
- **Test harness** (14 suites / 479 tests) — green throughout. The new
  `paid_offline` change didn't need new tests because the only schema
  invariant change was carving the value out of an existing CHECK; existing
  tests didn't hit it.

### What hurt

1. **Branch racing — twice** committed onto another session's feature branch
   (`docs/self-review-2026-05-04`, then `feat/analyzer-patch-zod`) because
   the other session ran `git checkout` between my commits. Each cost ~3
   minutes of cherry-pick + push + reset. **Fix**: a Claude hook that fails
   `git commit` when `git branch --show-current` ≠ `main` (with a documented
   override flag for the rare intentional case). See "Recommended improvements"
   below for the concrete path.

2. **`ALTER TYPE ADD VALUE` + same-tx use** — Postgres rejects use of a
   freshly-added enum value in the same transaction. `apply-migration-mgmt.mjs`
   sends the full SQL as one query, which is one transaction, which fails with
   `55P04 unsafe use of new value`. Worked around by splitting `00056`
   (enum-only) + `00057` (constraint redefine) and applying separately.
   **Fix**: pre-flight lint in `apply-migration-mgmt.mjs` that detects
   `ADD VALUE … 'X'` followed by any reference to `'X'` in the same file
   and refuses with a clear error message pointing at the split pattern.

3. **Vercel MCP returned 403** on `list_deployments` for both team IDs tried
   (`team_xVbGaXXJqpgaFjGsEZpbeXHs`, `team_MiIz4ckGpaoBCHbWoRcFuYHX`). Fell
   back to direct curl on the prod URL with status-code probing. **Fix**:
   either re-auth the Vercel MCP or document the curl-probe pattern as the
   primary verification path so future sessions don't waste a turn on it.

4. **No "preflight branch + remote" guard** — would have caught the two
   wrong-branch commits before they happened. See recommendations.

### What was unused (and probably should stay that way)

- `/loop`, `/ultrareview`, `/fast` skills — none invoked, none needed.
- `Agent` subagent dispatch — single-session work, focused scope, sequential
  dependencies. Subagents would have just added latency.

## Recommended improvements (next session can pick any)

### Priority A — branch-safety hook (45 min)

Add `.claude/settings.json` with a `PreToolUse` hook on `Bash` that intercepts
`git commit` and `git push` when:

- `git branch --show-current` ≠ `main`, OR
- Local `main` is behind `origin/main`

Blocks with a message like `BRANCH=feat/foo — switch to main first or pass
ALLOW_FEATURE_BRANCH=1`. Fast and prevents the cherry-pick dance entirely.

Files to touch:
- `.claude/settings.json` (new — see Claude Code hook docs for exact schema)
- `scripts/preflight-commit.sh` (new — single command the hook invokes)

### Priority B — migration linter (30 min)

In `scripts/apply-migration-mgmt.mjs`, before the POST:

```js
if (/ALTER TYPE\s+\w+\s+ADD VALUE[^;]*'(\w+)'/i.test(sql)) {
  const m = sql.match(/ADD VALUE[^;]*'(\w+)'/i);
  const newVal = m[1];
  // search for second use of the value AFTER the ADD VALUE statement
  const tail = sql.slice(sql.search(/ADD VALUE/i) + 10);
  if (new RegExp(`['"]${newVal}['"]`).test(tail)) {
    console.error(`Refusing: '${newVal}' added and used in the same migration. Postgres rejects this — split into two files.`);
    process.exit(2);
  }
}
```

### Priority C — pending UX (from earlier improvement plan)

These were deferred when stability/UX took precedence:

| code | what | rough effort |
|---|---|---|
| C-P0-3 | reschedule rejection wording (현재 문구가 약간 무뚝뚝) | 20m |
| C-P0-4 | no_show mailto deep-link in researcher email | 30m |
| C-P1-3 | SMS full URLs (현재 단축 도메인 사용 — 차단 위험) | 45m |
| C-P1-9 | payment panel resend tooltip ("새 토큰 발급됨" 등 명확화) | 15m |
| P0-Λ | 0원 banner — 참여비 0원 실험에서 정산 패널 자체를 숨김 처리 | 30m |

### Priority D — Sbj1-4 of TimeExp1 cleanup

These bookings exist (or did) but have no `participant_payment_info` row,
so the panel doesn't show them. Decision needed:

- (a) Leave as-is. Panel only shows 8 of 12 — researcher knows.
- (b) Backfill them with `status='paid_offline'` from day one (no token,
  no period — needs a special-case path in `backfill.ts`).
- (c) Investigate whether their `bookings.booking_group_id` is null. If
  so, the panel can never represent them; close as "out of scope".

Recommend (c) → (a). Cheapest. The researcher can mentally tally Sbj1-4
as "행정 처리 완료" without a row in the panel.

## Resume prompt for next session

Paste the block below into a fresh session. It's self-contained — references
files by path, includes the AGENTS.md hooks rule, and includes the four
candidate priorities so the session can pick by capacity.

```
Project: lab-reservation (Next.js 16 + Supabase). Continuing payment-info work
from session 2026-05-04. Read first:

1. AGENTS.md (multi-session rules — 7 items, especially rule 7 about
   never wiping another session's working tree)
2. docs/handoff/2026-05-05-payment-info-followup.md (full state + plan)
3. docs/ops-playbook.md "Migration log" section (last applied = 00057)

Quick context:
- main HEAD = 319c075. All payment-info hotfixes from yesterday deployed
  (per-group fee, mark_group_completed RPC, paid_offline status, form
  pre-fill audit, preview page).
- TimeExp1 panel: Sbj5-9 = paid_offline (자동), Sbj10/11/12 = pending,
  Sbj1-4 = no row (decision pending).

Pick ONE of these and execute it end-to-end (commit + push + verify):

A) Branch-safety Claude hook — fails git commit/push when not on main or
   when main is behind origin. .claude/settings.json + scripts/preflight-commit.sh.
   Eliminates the two cherry-pick recovery dances from yesterday.

B) Migration linter — pre-flight check in scripts/apply-migration-mgmt.mjs
   that refuses when ALTER TYPE ADD VALUE 'X' is followed by use of 'X' in
   the same file. Postgres rejects this; today we found out the hard way and
   split into 00056 + 00057.

C) Pending UX bundle (Phase 5b/c/d leftovers): C-P0-3 reschedule rejection
   wording, C-P0-4 no_show mailto, C-P1-3 SMS full URLs, C-P1-9 resend
   tooltip, P0-Λ 0원 banner. Pick the highest-value one or two.

D) TimeExp1 Sbj1-4 investigation — read those bookings rows, decide whether
   they have booking_group_id at all, and either leave (panel just shows 8
   of 12) or backfill with paid_offline-from-day-one path.

Constraints (durable):
- Pre-push: git fetch && git log HEAD..origin/main; pull if remote moved.
- 60s gap after pushes touching src/app/, src/lib/, supabase/migrations/,
  vercel.json (Vercel concurrency cancels in-flight builds).
- Verify branch with `git branch --show-current` before EVERY commit. If
  it's not `main` and the user didn't ask for a branch, switch back first.
- Never mass-restore/clean/checkout — see AGENTS.md rule 7. Untracked files
  you don't recognize belong to another session.
- Do not pre-fill the participant payment-info form with anything other
  than email + phone. Ever. (Hard rule from session 2026-05-04.)
- Status enum: pending_participant → submitted_to_admin → claimed (terminal)
  | paid (terminal, no UI path) | paid_offline (terminal, exempt from
  PII CHECK). Don't introduce a fifth without a clear reason.

Useful commands:
  npx tsc --noEmit                        # fast typecheck
  NEXT_TELEMETRY_DISABLED=1 npx next build  # full build
  node scripts/apply-migration-mgmt.mjs supabase/migrations/000XX_*.sql
  curl -sS -o /dev/null -w "%{http_code}\n" \
       https://lab-reservation-seven.vercel.app/api/experiments

Open with one sentence on what you're doing, then go.
```
