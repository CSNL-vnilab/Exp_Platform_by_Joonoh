---
description: Ship a change to main using the lab's isolated-worktree pattern (typecheck → lint → commit on feature branch → push branch:main → restore worktree).
---

Follow the deploy-runbook skill exactly (`skills/lab-deploy-runbook/SKILL.md`) — do NOT improvise. Default flow:

1. **Confirm you're working in the `main` worktree** at `/Users/csnl/Documents/claude/lab-reservation-main`. If the primary worktree is on another session's feature branch with their WIP, never co-opt that — develop in the main worktree which is meant for clean main work.

2. **tsc + eslint** on the files you touched. tsc must be clean; eslint warnings are tolerated but new errors are not.

3. **Branch + commit** with `ALLOW_FEATURE_BRANCH=1 git commit ...` and the repo's commit trailer (`Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`). State every DB-mutating action in the commit body per AGENTS.md rule 3.

4. **Fetch + verify fast-forward** against `origin/main` — abort if not FF-able and rebase instead.

5. **Push** with `ALLOW_FEATURE_BRANCH=1 git push origin <feature-branch>:main`. If `gh` auth fails, run `/lab-restore-env`.

6. **Restore worktree** to `main`, fast-forward, delete the temp branch (don't leave it lying around).

7. **Verify Vercel** by polling `vercel ls` until `● Ready`, then `vercel inspect <deployment>` to confirm the aliases include `lab-reservation-seven.vercel.app`.

Skip steps that the user has explicitly already done. Never silently delete a feature branch with `-D` before confirming the push landed — that's how we lost `922813b` once. Confirm `git log --oneline origin/main` shows your commit before pruning.
