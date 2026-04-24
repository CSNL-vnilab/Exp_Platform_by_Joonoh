import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { authorizeCronRequest } from "@/lib/auth/cron-secret";
import {
  runBookingNotionRetry,
  runObservationNotionRetry,
  type ClaimedRow as NotionClaim,
} from "@/lib/services/notion-retry.service";
import {
  runGCalRetry,
  type GCalClaimedRow,
} from "@/lib/services/gcal-retry.service";
import {
  runSMSRetry,
  type SMSClaimedRow,
} from "@/lib/services/sms-retry.service";
import {
  runEmailRetry,
  type EmailClaimedRow,
} from "@/lib/services/email-retry.service";

// Unified outbox retry cron — D6 sprint.
//
// Replaces the narrower /api/cron/notion-retry by also handling
// gcal + sms failures. Uses the generic RPC `claim_next_outbox_retry`
// (migration 00037) with an explicit allowlist: `email` is NOT yet
// here because the confirmation-email HTML lives inside
// booking.service.runEmail() and hasn't been extracted into a
// replayable service (tracked in docs/next-sprints.md).
//
// Dispatch on integration_type after the claim — the RPC returns the
// next-oldest row across the allowlist. We pick the right service.
//
// Same auth + min-secret-length + rate-limit short-circuit contract as
// notion-retry. /api/cron/notion-retry stays callable for backward
// compatibility (the existing cron keeps working) until its cron entry
// is cut over.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_ROWS_PER_SWEEP = 30;
// 400ms between claims stays under the tightest upstream (Notion 3 rps);
// GCal/Solapi are more generous but we keep one shared pacing.
const MIN_DELAY_MS = 400;

// Integration types this cron will claim. Email was added after the
// confirmation-email HTML was extracted into booking-email-template.ts.
const ENABLED_TYPES = ["notion", "notion_survey", "gcal", "sms", "email"] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Outcome {
  booking_id: string;
  integration_type: string;
  attempts: number;
  ok: boolean;
  external_id?: string | null;
  error?: string | null;
  skipped_reason?: string;
}

type ClaimRow = {
  id: string;
  booking_id: string;
  integration_type: "notion" | "notion_survey" | "gcal" | "sms" | "email";
  attempts: number;
};

async function claimNext(
  supabase: ReturnType<typeof createAdminClient>,
): Promise<ClaimRow | null> {
  const { data, error } = await supabase.rpc("claim_next_outbox_retry", {
    p_types: [...ENABLED_TYPES],
  });
  if (error) {
    console.error("[OutboxRetry] claim rpc failed:", error.message);
    return null;
  }
  const rows = (data ?? []) as ClaimRow[];
  return rows[0] ?? null;
}

async function runOne(
  supabase: ReturnType<typeof createAdminClient>,
  claim: ClaimRow,
): Promise<Outcome> {
  if (claim.integration_type === "notion") {
    const r = await runBookingNotionRetry(supabase, claim as NotionClaim);
    return { ...r, integration_type: claim.integration_type };
  }
  if (claim.integration_type === "notion_survey") {
    const r = await runObservationNotionRetry(supabase, claim as NotionClaim);
    return { ...r, integration_type: claim.integration_type };
  }
  if (claim.integration_type === "gcal") {
    const r = await runGCalRetry(supabase, claim as GCalClaimedRow);
    return { ...r, integration_type: claim.integration_type };
  }
  if (claim.integration_type === "sms") {
    const r = await runSMSRetry(supabase, claim as SMSClaimedRow);
    return { ...r, integration_type: claim.integration_type };
  }
  if (claim.integration_type === "email") {
    const r = await runEmailRetry(supabase, claim as EmailClaimedRow);
    return { ...r, integration_type: claim.integration_type };
  }
  // L1 fix — if the RPC allowlist gets widened to a type we don't yet
  // dispatch (e.g. "email" flipped on without the service), FINALIZE
  // the row as failed so its `attempts` cap actually limits the noise.
  // Without this, the RPC keeps bumping attempts every sweep forever.
  await supabase.rpc("finalize_outbox_retry", {
    p_integration_id: claim.id,
    p_status: "failed",
    p_external_id: null,
    p_last_error: `unknown_integration_type:${claim.integration_type}`,
  });
  return {
    booking_id: claim.booking_id,
    integration_type: claim.integration_type,
    attempts: claim.attempts,
    ok: false,
    error: "unknown integration_type",
  };
}

async function handle(request: NextRequest) {
  const started = Date.now();
  try {
    if (!authorizeCronRequest(request)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const admin = createAdminClient();
    const processed: Outcome[] = [];
    let recovered = 0;
    let stillFailed = 0;
    let skipped = 0;

    let rateLimitedAt: string | null = null;
    for (let i = 0; i < MAX_ROWS_PER_SWEEP; i += 1) {
      if (i > 0) await sleep(MIN_DELAY_MS);
      const claim = await claimNext(admin);
      if (!claim) break;

      const outcome = await runOne(admin, claim);
      processed.push(outcome);
      if (outcome.ok) {
        if (outcome.external_id == null) skipped += 1;
        else recovered += 1;
      } else if (outcome.skipped_reason) {
        skipped += 1;
      } else {
        stillFailed += 1;
        // H2 fix — widened to cover real provider error strings:
        //   * GCal: "Rate Limit Exceeded", "rateLimitExceeded",
        //            "userRateLimitExceeded", "Quota exceeded for …"
        //   * Notion: "rate_limited" / "ThrottlerException" / 429
        //   * Solapi: "Daily limit exceeded", code starting with "Limit"
        if (
          typeof outcome.error === "string" &&
          /rate[\s_]?limit|429|too many|throttl|quota|userRateLimit|daily\s*limit/i.test(
            outcome.error,
          )
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

    // Log to notion_health_state under a distinct check_type so the
    // dashboard can distinguish Notion-only sweeps from unified sweeps.
    await admin.from("notion_health_state").insert({
      check_type: "outbox_retry_sweep",
      healthy: stillFailed === 0,
      report: summary as unknown as import("@/types/database").Json,
      duration_ms: Date.now() - started,
    });

    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    console.error("[OutboxRetryCron] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 },
    );
  }
}

export const GET = handle;
export const POST = handle;
