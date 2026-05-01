<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- BEGIN:multi-session-rules -->
# Multi-session collaboration rules

Multiple Claude sessions work on this repo concurrently — all pushing to
`main` directly. Treat the working tree as shared infrastructure:

1. **Before pushing, `git fetch && git log HEAD..origin/main`.** Pull
   first if remote moved. Force-push to `main` is forbidden.

2. **Production-affecting commits** (anything under `src/app/`, `src/lib/`,
   `supabase/migrations/`, `vercel.json`) deserve a 60-second pause after
   `git push`: Vercel concurrency cancels in-flight builds when a new
   push lands, and a back-to-back push that follows yours can leave the
   previous commit in `CANCELED` state on Vercel even though the code is
   in `main`.

3. **DB-mutating scripts** (`scripts/import-*.mjs`, `scripts/notify-*.mjs`,
   anything that writes Supabase rows) state the action explicitly in the
   commit message body so other sessions can spot the change in
   `git log`.

4. **Long-running e2e/smoke scripts** (`scripts/e2e-*.mjs`,
   `scripts/timeexp/e2e-*.mjs`, `scripts/smoke-from-source.mjs`):
   - Check `ps -axo pid,etime,command | grep "scripts/.*\.mjs"` before
     starting — another session may already have one running against the
     same Supabase + Vercel target.
   - These scripts seed/clean fixtures via the service-role client; two
     concurrent runs can step on each other's `subject_number` /
     `booking_group_id` allocations. Prefer to wait, or scope the new run
     to a different experiment id.

5. **Cron** runs in two places:
   - `vercel.json` is intentionally minimal (no scheduled crons — Vercel
     Hobby tier limits us to two and they're already covered by GH
     Actions).
   - `.github/workflows/*-cron.yml` is the source of truth for scheduled
     work. Every cron handler must remain idempotent (status markers,
     `WHERE status='pending'` filters, etc.) because GH Actions retries
     on transient failures.

6. **Vercel-GitHub link** is a GitHub App at
   <https://github.com/apps/vercel> + the project link in
   `.vercel/project.json`. If pushes stop auto-deploying, check the link
   first: `curl -s ".../v9/projects/{id}?teamId={team}" | jq .link` —
   `null` means the App has been removed and the project needs to be
   re-linked via `POST /v9/projects/{id}/link`.

7. **Never wipe another session's working tree.** The following
   destroy unstaged or untracked work that another session may be
   mid-edit on:
   - `git reset --hard <anything>`
   - `git checkout .` / `git checkout -- <path>`
   - `git restore --source=… <path>`
   - `git clean -f` / `git clean -fd`
   - `git stash` _without_ first verifying the only modified files are
     yours

   Before any of these, run `git status --short` and confirm every
   modified/untracked file traces back to your own session. If you see
   anything you don't recognize (different scope, different feature
   name in a recent commit message, a `.tsx`/`.ts` you never opened),
   STOP — those are another session's in-flight changes.

   If you must clear *only* your own work, use targeted forms:
   `git restore -- <specific file>`, `git stash push -- <specific file>`,
   `git checkout HEAD -- <specific file>`. Never the unscoped variants.

   The same rule applies to `git checkout <other-branch>` when staged
   or unstaged changes exist — that move can carry another session's
   files onto a branch they didn't intend, or worse, abort with
   conflicts that you then "resolve" by discarding their edits. Stash
   only your own paths first (see above) or commit on the current
   branch.
<!-- END:multi-session-rules -->
