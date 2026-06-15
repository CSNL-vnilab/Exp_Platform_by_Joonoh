-- 00074 — apply the payment_status enum value that 00066 declared but never
-- reached prod (migration drift). 00066 combined the ALTER with a COMMENT
-- whose prose tripped apply-migration-mgmt's 55P04 guard, so it was never
-- applied; meanwhile the app code (notifyPaymentInfoIfReady all-terminal
-- transition) has been failing in prod with "invalid input value for enum
-- payment_status" — leaving every all-cancelled group's settlement row stuck
-- pending/claimed (the reschedule/rebook tangle). This is the bare ADD VALUE
-- only, so it applies cleanly. Idempotent.
ALTER TYPE payment_status ADD VALUE IF NOT EXISTS 'cancelled';
