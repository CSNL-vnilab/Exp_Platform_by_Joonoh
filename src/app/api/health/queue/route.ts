// GET /api/health/queue
//
// Operator probe — surfaces the depth of every integration_type's
// pending/failed queue plus the age of the oldest pending row. Lets
// an operator spot a backlog (SMTP outage, Notion 5xx, etc.) with a
// single curl rather than running ad-hoc Supabase SQL.
//
// Auth: same x-cron-secret / Bearer scheme as the cron endpoints
// (re-used because the GH Actions prod-smoke workflow can also probe
// it for free without leaking the queue depth to public).
//
// Response shape:
//   {
//     "ok": boolean,           // true iff every type has 0 failed + oldest_pending_age_sec < threshold
//     "checked_at": ISO,
//     "thresholds": { failed_warn: 5, oldest_pending_age_warn_sec: 1800 },
//     "queue": [
//       { integration_type, pending, failed, oldest_pending_age_sec, oldest_failed_age_sec }
//     ]
//   }
//
// `ok=false` is the operator's first-look signal — usually means
// SMTP is throwing, Notion is rate-limiting, or a cron stopped firing.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authorizeCronRequest } from "@/lib/auth/cron-secret";
import { createAdminClient } from "@/lib/supabase/admin";

// Threshold chosen so a healthy queue stays under it during normal
// operation: the outbox-retry cron fires every 30 min so a 30-min
// pending row is still inside one retry window. A row older than 30
// min that's still pending means either the cron stopped firing or
// the row is stuck on a permanent failure (5/5 attempts not yet
// exhausted but consistently bouncing).
const FAILED_WARN = 5;
const OLDEST_PENDING_AGE_WARN_SEC = 30 * 60;

interface QueueEntry {
  integration_type: string;
  pending: number;
  failed: number;
  oldest_pending_age_sec: number | null;
  oldest_failed_age_sec: number | null;
}

export async function GET(request: NextRequest) {
  if (!authorizeCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();

  // Pull every row with status in {pending, failed}. The partial index
  // idx_booking_integrations_status (migration 00013) covers this query.
  // Limit defensively to 10k — a backlog larger than that is itself
  // the alert, no need to scan the full table.
  const { data: rows, error } = await admin
    .from("booking_integrations")
    .select("integration_type, status, created_at")
    .in("status", ["pending", "failed"])
    .limit(10000);

  if (error) {
    return NextResponse.json(
      { error: "queue probe failed", detail: error.message },
      { status: 500 },
    );
  }

  const now = Date.now();
  const buckets = new Map<string, QueueEntry>();
  for (const r of rows ?? []) {
    const type = (r as { integration_type: string }).integration_type;
    const status = (r as { status: string }).status;
    const createdMs = new Date(
      (r as { created_at: string }).created_at,
    ).getTime();
    const ageSec = Math.floor((now - createdMs) / 1000);
    let bucket = buckets.get(type);
    if (!bucket) {
      bucket = {
        integration_type: type,
        pending: 0,
        failed: 0,
        oldest_pending_age_sec: null,
        oldest_failed_age_sec: null,
      };
      buckets.set(type, bucket);
    }
    if (status === "pending") {
      bucket.pending += 1;
      if (
        bucket.oldest_pending_age_sec === null ||
        ageSec > bucket.oldest_pending_age_sec
      ) {
        bucket.oldest_pending_age_sec = ageSec;
      }
    } else if (status === "failed") {
      bucket.failed += 1;
      if (
        bucket.oldest_failed_age_sec === null ||
        ageSec > bucket.oldest_failed_age_sec
      ) {
        bucket.oldest_failed_age_sec = ageSec;
      }
    }
  }

  const queue = Array.from(buckets.values()).sort((a, b) =>
    a.integration_type.localeCompare(b.integration_type),
  );

  const ok = queue.every(
    (b) =>
      b.failed <= FAILED_WARN &&
      (b.oldest_pending_age_sec ?? 0) <= OLDEST_PENDING_AGE_WARN_SEC,
  );

  return NextResponse.json({
    ok,
    checked_at: new Date().toISOString(),
    thresholds: {
      failed_warn: FAILED_WARN,
      oldest_pending_age_warn_sec: OLDEST_PENDING_AGE_WARN_SEC,
    },
    queue,
  });
}
