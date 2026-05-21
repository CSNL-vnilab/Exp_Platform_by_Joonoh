---
description: How to apply a new Supabase migration to lab-reservation production despite the project's pre-existing migration-tracking drift. Use whenever you create or edit a file under supabase/migrations/. Triggers on terms like "supabase migration", "db push", "ALTER TABLE", "schema migration", "supabase repair".
---

# Lab-reservation Supabase migration runbook

## Background — why you can't just `supabase db push`

The `supabase_migrations.schema_migrations` table on this project has drift:
- Many tracked-LOCAL-not-tracked-REMOTE versions (00022, 00023, 00025–00059) were applied historically via Supabase Studio or direct DDL; they exist in the schema but were never registered in the tracking table.
- Three remote-only timestamp versions (`20260512071309`, `20260514043648`, `20260514044103`) were pushed by some other path and have no local files.
- `supabase db push` refuses to proceed past either type of drift, demanding `--include-all`. Running `--include-all` blindly re-attempts old `ALTER TABLE ADD COLUMN ... NOT NULL` statements and fails because the columns already exist.

So the working pattern for this repo is:

## The applied workflow (used for 00060, 00061, 00062)

1. **Author the migration file** at `supabase/migrations/000NN_<descriptive_name>.sql`.

2. **Syntax preflight.** Two known landmines in this repo:
   - PostgreSQL won't accept string concatenation (`'...' || '...'`) in `COMMENT ON TABLE/COLUMN IS ...`. Inline the string into a single literal.
   - `CREATE OR REPLACE FUNCTION` with the function's existing signature has to declare every `DECLARE` variable; copy the latest live body from the most-recent migration that touches it (e.g. `00045_book_slot_exclude_experiments.sql` for `book_slot`) and only add what's new.

3. **Apply via db query (skip the migration ordering check).** This is the move that bypasses the drift:
   ```bash
   supabase db query --linked --file supabase/migrations/000NN_<file>.sql
   ```
   It runs the DDL in a single transaction without consulting `schema_migrations`.

4. **Stamp the tracker as applied** so a future `db push` doesn't try to re-apply your migration:
   ```bash
   supabase migration repair --status applied 000NN
   ```

5. **(Only the first time) Acknowledge the legacy drift.** If `supabase migration list` still shows the 3 remote-only timestamps blocking everything:
   ```bash
   supabase migration repair --status reverted 20260512071309 20260514043648 20260514044103
   ```
   Done once on 2026-05-20; expected to remain in the reverted state going forward. If it regenerates, that's a regression worth investigating, not normal.

6. **Verify the schema landed.**
   - `ALTER TABLE ADD COLUMN`: `supabase db query --linked "SELECT column_name FROM information_schema.columns WHERE table_name='<table>' AND column_name='<col>';"`
   - `CREATE OR REPLACE FUNCTION`: `supabase db query --linked "SELECT count(*) FROM pg_proc WHERE proname='<func>' AND prosrc LIKE '%<sentinel-from-new-body>%';"`

7. **Commit the migration file** to `main` via the `lab-deploy-runbook` flow.

## Two-worktree pitfall

The supabase CLI link state lives at `/Users/csnl/Documents/claude/lab-reservation/supabase/.temp/` — that's the PRIMARY worktree. The MAIN worktree at `/Users/csnl/Documents/claude/lab-reservation-main` isn't linked. So:
- Author the file in `lab-reservation-main` (where you'll commit).
- Copy it to `lab-reservation/supabase/migrations/` for the CLI to find.
- Apply via `supabase db query --linked` from the primary worktree.
- Remove the copy from `lab-reservation/supabase/migrations/` afterward to keep the primary worktree on its analyzer-branch baseline (other session's expected state).

## When to NOT use this skill

- For pure data backfills (no schema change), write a script under `scripts/` instead of a migration. The migration files in this repo are schema-only.
- For `book_slot` RPC changes specifically, the function body is ~250 lines; copy the latest version verbatim from the most recent `book_slot`-touching migration and add your branch in the right place (see 00062 for the recruitment_target gate, 00045 for the exclude_experiment_ids gate).
