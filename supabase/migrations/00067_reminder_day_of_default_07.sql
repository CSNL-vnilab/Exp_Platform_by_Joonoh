-- Lower the default day-of reminder time from 09:00 → 07:00 KST.
--
-- Why: GitHub Actions free-tier cron (the dispatcher) gets throttled
-- to roughly every 1-4 hours under load — when the 09:00-KST sweep
-- window is skipped, reminders slip into the afternoon. Vercel Hobby
-- can't host a sub-daily cron and a paid upgrade is out of scope, so
-- the pragmatic mitigation is to schedule 2h earlier and let the
-- next cron tick pick it up around 09:00 KST.
--
-- Scope: changes the column default only; existing experiments keep
-- whatever value they already have (per 2026-05-29 user directive
-- "새 실험에만 적용 (기존 실험은 그대로)"). New experiments created
-- after this migration get 07:00 unless overridden in the form.

ALTER TABLE experiments
  ALTER COLUMN reminder_day_of_time SET DEFAULT '07:00';

COMMENT ON COLUMN experiments.reminder_day_of_time IS
  'KST time-of-day the day-of reminder gets scheduled for. Default 07:00 (was 09:00 until 00067) — see migration body for the cron-jitter rationale.';
