---
description: How to ship code changes to the lab-reservation production main branch without stepping on other Claude sessions' worktrees. Use whenever the user asks you to commit, push, deploy, or merge a code change in this repo. Triggers on terms like "push", "deploy", "main", "ship", "merge to main".
---

# Lab-reservation deploy runbook

The repo at `/Users/csnl/Documents/claude/lab-reservation` is a SHARED worktree. Multiple concurrent Claude sessions check out feature branches on it and leave dirty WIP. **Never commit / checkout / stash unscoped paths there.** All your work happens in the dedicated main worktree at `/Users/csnl/Documents/claude/lab-reservation-main`.

## Why this matters

- The pre-flight hook (`scripts/preflight-commit.sh`, configured in `.claude/settings.json`) refuses `git commit` and `git push` when (a) the current branch is not `main`, or (b) `git push` would land while local `main` is behind `origin/main`. Override with `ALLOW_FEATURE_BRANCH=1` only for *your own* feature branches.
- The shared dev worktree's working tree routinely carries other sessions' uncommitted code (`database.ts`, `gmail.ts`, `package.json`, ad-hoc scripts). `git checkout`, `git reset --hard`, `git stash` without explicit paths there will silently merge their files into your commit OR delete their WIP. Both are bad.
- Vercel's GitHub App auto-deploys from `main`. A push to `main` triggers a fresh build within seconds.

## The flow you use every time

1. **Work in the main worktree:** `cd /Users/csnl/Documents/claude/lab-reservation-main`. Its `node_modules` is symlinked to the primary repo's, so tsc/eslint Just Work.

2. **Fast-forward main, then branch off it:**
   ```bash
   git fetch origin --quiet
   git pull --ff-only origin main
   git checkout -b <feature-branch-name>
   ```
   Naming convention: `feat/` for features, `fix/` for bugfixes, `chore/` for docs/scripts. The branch is temporary — you delete it after pushing.

3. **Make edits in the main worktree.** Edit the files directly. The primary worktree's WIP stays untouched.

4. **Validate before committing.** tsc must be clean; eslint warnings on touched files are OK but new errors aren't:
   ```bash
   npx tsc --noEmit -p tsconfig.json
   npx eslint <touched-files>
   ```
   If `npx` isn't found, run `/lab-restore-env` first.

5. **Stage explicit paths only.** Never `git add -A` or `git add .` — you'd capture anything the other session left. Use `git add <file1> <file2> …`.

6. **Commit with the override + trailer:**
   ```bash
   ALLOW_FEATURE_BRANCH=1 git commit -F - <<'EOF'
   <type>(<scope>): <subject>

   <body — state every DB-mutating side-effect explicitly per AGENTS.md rule 3>

   Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
   EOF
   ```

7. **Re-fetch + verify fast-forward + push** to `main`:
   ```bash
   git fetch origin --quiet
   [ "$(git merge-base HEAD origin/main)" = "$(git rev-parse origin/main)" ] || { echo "origin/main moved — rebase"; exit 1; }
   ALLOW_FEATURE_BRANCH=1 git push origin <feature-branch>:main
   ```
   The push is a fast-forward of `origin/main` by exactly your commit(s). If gh auth blows up: `/lab-restore-env`. If credentials are gone entirely, the user has a PAT — use `https://<user>:<token>@github.com/...` inline (one-shot; never `git remote set-url`).

8. **Verify the commit landed BEFORE deleting the branch.** `-D` discards unmerged commits silently — we lost `922813b` once that way.
   ```bash
   git fetch origin --quiet
   git log --oneline origin/main -2   # YOUR commit should be on top
   git checkout main
   git pull --ff-only origin main
   git branch -D <feature-branch>     # safe now
   ```

9. **Wait for Vercel** — see `/lab-verify` and the `lab-deploy-runbook` Vercel section below.

## Vercel verification

`vercel ls` shows the latest deployment within seconds of the push. Status progresses `Building` → `Ready` (~1 min for this repo). To block on it without burning the 5-min cache window:

```bash
until vercel ls 2>&1 | sed -n '6p' | grep -qE "● Ready|● Error"; do sleep 8; done
```

Run with `run_in_background: true` (the harness blocks single long sleeps). Confirm aliases with `vercel inspect <deployment-url>` — production should be aliased to `lab-reservation-seven.vercel.app` and `lab-reservation-git-main-*`.

## DB-mutating scripts

Per AGENTS.md item 3, scripts under `scripts/` that write Supabase rows (`scripts/import-*.mjs`, `scripts/backfill-*.mjs`, `scripts/blacklist-*.mjs`, anything similar) must:
- Default to DRY-RUN; `--apply` to write.
- State the executed action in the commit body so `git log` reveals every prod write.
- Be idempotent on re-run.

## What to do when something is wrong

- **gh / node / supabase / vercel suddenly not found** → `/lab-restore-env`. They live in `/opt/homebrew/bin` and `/Applications/Codex.app/Contents/Resources`; the script reseats them.
- **`origin/main` moved between fetch and push** → re-fetch, rebase your single commit onto the new `origin/main` in a throwaway worktree (`git worktree add /Users/csnl/Documents/claude/<short-name> -b <branch> origin/main`), cherry-pick your commit, push. The pattern that worked in this repo: cherry-pick → fix any conflicts → push branch:main → remove worktree.
- **You committed but the push got blocked by the classifier and `git checkout main && git branch -D <feature>` ran anyway** → check `git reflog` immediately; the commit SHA is still reachable. `git branch <recovery-name> <SHA>` preserves it before GC.
