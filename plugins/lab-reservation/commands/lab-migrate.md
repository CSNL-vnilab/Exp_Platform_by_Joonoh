---
description: Apply a Supabase migration to production, working around the project's migration-tracking drift. Reads the file and applies via `supabase db query --linked --file`.
---

Apply migration `$1` (default: the highest-numbered file in `supabase/migrations/`) to production Supabase. The full runbook lives in `skills/lab-supabase-migration/SKILL.md`; quick form:

1. **Pick the file** — `ls supabase/migrations/*.sql | tail -1` unless the user named one.

2. **Preflight SQL** — `head -40` it and skim for `||` string concat in `COMMENT ON …` (PG won't accept it; inline the string) and any other syntactic surprise.

3. **Apply directly via db query** — DO NOT run `supabase db push` first. This repo's `supabase_migrations.schema_migrations` table has historical drift; `db push` will demand `--include-all` and try to re-apply old `ALTER TABLE ADD COLUMN`s. Instead:

   ```bash
   supabase db query --linked --file supabase/migrations/<file>.sql
   ```

   This runs the DDL in one transaction without touching the tracking table.

4. **Stamp the tracker** so future `db push` runs don't re-attempt it:

   ```bash
   supabase migration repair --status applied <version>
   ```

   where `<version>` is the numeric prefix (e.g. `00062`).

5. **Spot-check** the schema landed — `supabase db query --linked "SELECT column_name FROM information_schema.columns WHERE table_name='<table>';"` for an ALTER TABLE, or `SELECT count(*) FROM pg_proc WHERE proname='<func>' AND prosrc LIKE '%<sentinel>%';` for a CREATE OR REPLACE FUNCTION.

Never auto-run `--include-all`. The 3 remote-only timestamp migrations (20260512071309 / 20260514043648 / 20260514044103) were already marked `reverted` once; if `migration list` shows them in the way again, that's a regression worth investigating, not a green light.
