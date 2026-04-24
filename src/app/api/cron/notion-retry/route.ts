import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { authorizeCronRequest } from "@/lib/auth/cron-secret";
import {
  claimNextRetry,
  runBookingNotionRetry,
  runObservationNotionRetry,
  type RetryOutcome,
} from "@/lib/services/notion-retry.service";

// Notion outbox retry cron.
//
// Post D1-review rewrite: atomic claim via `claim_next_notion_retry()`
// (migration 00032) serializes concurrent workers — overlapping Vercel
// cron + GH Actions backup invocations cannot race. Backoff is encoded
// in the DB function; this route is a thin loop that claims → runs →
// moves on until the queue returns null or MAX_ROWS_PER_SWEEP is hit.
//
// Each sweep writes exactly one `notion_health_state` row with
// check_type='retry_sweep' summarising counts. Dashboard reads that.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Per-cron-invocation cap so one slow Notion session doesn't blow past
// Vercel's per-request budget.
const MAX_ROWS_PER_SWEEP = 30;
// Notion API official limit: avg 3 requests/second per integration; single
// spikes over ~3 rps get 429'd. A booking-page retry makes 1-2 Notion
// requests; an observation PATCH makes 1. 400ms between claims stays
// safely under the threshold even when we burst.
const MIN_DELAY_MS = 400;

async function handle(request: NextRequest) {
  const started = Date.now();
  try {
    if (!authorizeCronRequest(request)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const admin = createAdminClient();
    const processed: RetryOutcome[] = [];
    let recovered = 0;
    let stillFailed = 0;
    let skipped = 0;

    let rateLimitedAt: string | null = null;
    for (let i = 0; i < MAX_ROWS_PER_SWEEP; i += 1) {
      if (i > 0) await sleep(MIN_DELAY_MS);
      const claim = await claimNextRetry(admin);
      if (!claim) break; // queue empty or all remaining rows in backoff

      const outcome =
        claim.integration_type === "notion_survey"
          ? await runObservationNotionRetry(admin, claim)
          : await runBookingNotionRetry(admin, claim);

      processed.push(outcome);
      if (outcome.ok) {
        if (outcome.external_id == null) skipped += 1;
        else recovered += 1;
      } else {
        stillFailed += 1;
        // Short-circuit on Notion's global rate-limit so we don't burn
        // all remaining attempts against a locked-out integration.
        // Notion returns 429 with a Retry-After header; the service
        // layer normalises error messages, so detect by message content.
        if (
          typeof outcome.error === "string" &&
          /rate_limited|429|too many|ThrottlerException/i.test(outcome.error)
        ) {
          rateLimitedAt = new Date().toISOString();
          break;
        }
      }
    }

    const summary = {
      attempted: processed.length,
      recovered,
      still_failed: stillFailed,
      skipped,
      rate_limited_at: rateLimitedAt,
      rows: processed,
    };

    await admin.from("notion_health_state").insert({
      check_type: "retry_sweep",
      healthy: stillFailed === 0,
      report: summary as unknown as import("@/types/database").Json,
      duration_ms: Date.now() - started,
    });

    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    console.error("[NotionRetryCron] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 },
    );
  }
}

export const GET = handle;
export const POST = handle;
