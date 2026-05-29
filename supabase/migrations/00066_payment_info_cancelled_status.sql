-- 00066 — extend payment_status with 'cancelled' for groups where every
--         booking ended up cancelled.
--
-- Background (hidden-couplings.md #25 / refactor-roadmap.md A2):
--
-- Today a participant_payment_info row is seeded as soon as the runtime
-- pipeline creates the booking_group and survives forever in
-- 'pending_participant' if even ONE booking in the group gets cancelled,
-- because notifyPaymentInfoIfReady requires every booking to be
-- 'completed' to fire. Two flows trip this:
--
--   1. Multi-session group where the participant self-cancels one
--      session via /booking-edit. The other 4 may complete, but the
--      "all completed" gate forever rejects dispatch — payment email
--      never goes out and the researcher has to notice + intervene
--      (which usually means a panicked Slack ping days later).
--
--   2. A booking_group where every session is eventually cancelled
--      (recruitment fell through, participant ghosted entirely). The
--      payment row sits pending in the admin dashboard's queue, looking
--      like outstanding work.
--
-- This migration only adds the enum value. Application-level logic to
-- (a) treat cancelled bookings as terminal-non-blocking for the
-- "ready to send" gate and (b) transition the payment_info row to
-- 'cancelled' when no non-cancelled bookings remain, ships in the same
-- commit (src/lib/services/payment-info-notify.service.ts).
--
-- Existing rows are untouched. Existing dashboards/queries that filter
-- by specific positive statuses ('pending_participant',
-- 'submitted_to_admin', 'claimed', 'paid', 'paid_offline') naturally
-- exclude 'cancelled' without further changes; the payment-claim /
-- export / panel UI all use positive filters and won't surface
-- cancelled rows.

ALTER TYPE payment_status ADD VALUE IF NOT EXISTS 'cancelled';

COMMENT ON TYPE payment_status IS
  'Lifecycle of a participant_payment_info row. Added 2026-05-29: '
  '''cancelled'' for groups whose bookings all ended up cancelled — '
  'distinguishes "never finished" from "still waiting on participant".';
