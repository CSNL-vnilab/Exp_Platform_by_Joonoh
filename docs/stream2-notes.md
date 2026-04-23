# Stream 2 Notes

Deferred / hard-to-implement items parked while iterating. Not a TODO for
the owning session — just a breadcrumb so the next agent doesn't repeat
discoveries.

## Blockers (not ours to fix)

- **Prod deploy blocked by `*/30 * * * *` cron** in `vercel.json`
  (`/api/cron/notion-retry`). Hobby plan caps at 1/day. Stream 1/3 owns
  notion-retry; either move it to GitHub Actions (mirror
  `.github/workflows/reminders-cron.yml`) or upgrade to Pro.
  Until resolved, phase-2 changes (migration 00032, preflight, screeners,
  condition assignment, pilot toggle, live dashboard) only land on local.
  Migration 00032 is already applied to remote Supabase.

## Hard to implement right now — noted, skipped

- **Attention-check injection by the shell.** Server-side counter +
  `reportAttentionFailure()` contract is live, but we don't force-render
  attention-check items between blocks in the sandbox iframe. Doing so
  cleanly requires a researcher-JS contract (pause/resume events) that
  would break existing jsPsych-style experiments. Keeping current
  behavior: researcher JS calls `window.expPlatform.reportAttentionFailure()`
  when it detects a failure in their own flow. The platform records and
  aggregates; researcher decides the threshold.

- **Biometric identity / device fingerprinting.** Out of scope for a
  university lab. Benchmark notes in the Prolific research report.

- **VPN/proxy geo enforcement.** Requires a paid IP-intelligence service
  (MaxMind, IPinfo). Skip until a real need shows up.

- **Server-to-server completion webhook** (for labs integrating with
  external Qualtrics / Gorilla / ...). Mint the signed webhook secret +
  POST pattern similar to run tokens; deferred until we have a consumer.

- **CSRF on researcher UPDATE/POST routes.** Next.js App Router + same-site
  cookies covers most cases but a strict CSRF token per researcher session
  would be nicer. Deferred — Supabase auth cookies are `SameSite=Lax`.

- **Rich consent form with e-signature.** We just have a checkbox + IRB
  URL. PDF rendering + signature capture + WORM storage is a multi-week
  effort; deferred until IRB formally asks.

- **jsPsych first-class integration (upload `experiment.zip`).** The
  runtime shell + block-ingestion contract already works with any JS that
  calls `expPlatform.submitBlock`; a convenience upload that unzips into
  Supabase Storage and auto-wires jsPsych's `on_finish` would make
  onboarding researchers far easier. Deferred — separate effort worth
  its own migration + route.
