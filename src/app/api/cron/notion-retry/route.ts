import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { timingSafeEqual } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
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

// Per-cron-invocation cap so one slow Notion session doesn't blow past
// Vercel's per-request budget.
const MAX_ROWS_PER_SWEEP = 50;
// Conservative lower bound on CRON_SECRET entropy. 32 chars ≈ 128 bits.
const MIN_SECRET_LENGTH = 32;

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function authorize(request: NextRequest): boolean {
  const expected = (process.env.CRON_SECRET ?? "").trim();
  if (!expected || expected.length < MIN_SECRET_LENGTH) return false;
  const custom = request.headers.get("x-cron-secret") ?? "";
  if (custom && safeCompare(custom, expected)) return true;
  const auth = request.headers.get("authorization") ?? "";
  if (auth.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    if (token && safeCompare(token, expected)) return true;
  }
  return false;
}

async function handle(request: NextRequest) {
  const started = Date.now();
  try {
    if (!authorize(request)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const admin = createAdminClient();
    const processed: RetryOutcome[] = [];
    let recovered = 0;
    let stillFailed = 0;
    let skipped = 0;

    for (let i = 0; i < MAX_ROWS_PER_SWEEP; i += 1) {
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
      }
    }

    const summary = {
      attempted: processed.length,
      recovered,
      still_failed: stillFailed,
      skipped,
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
