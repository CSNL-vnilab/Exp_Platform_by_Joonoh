import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { authorizeCronRequest } from "@/lib/auth/cron-secret";
import {
  buildResearcherGapInventory,
  renderInterviewEmail,
  sendInterviewEmail,
} from "@/lib/services/metadata-interview-email";

// Daily 09:00 KST DB-quality check + backfill-reminder cron.
//
// User directive 2026-05-26: 매일 9am 마다 DB quality 검토하고 백필
// 리마인드 요청. Pairs with the one-shot /metadata-fill page so each
// researcher gets a single calendar-grounded summary email pointing
// at the page that lets them fill every gap from one screen.
//
// Distinct from the existing weekly metadata-reminders cron (which
// uses a different email layout and a 7-day rate limit). Both crons
// share the metadata_reminder_log table so they coordinate via a
// 20-hour rate limit here — if the weekly cron fired in the last 20h,
// today's daily run skips that researcher.
//
// Auth: same CRON_SECRET contract as every other cron route. Reads
// every gap inventory; sends one email per researcher; writes one
// metadata_reminder_log row per email so the next day's run can
// detect "no progress" cleanly.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEDUP_WINDOW_HOURS = 20;

export async function POST(request: NextRequest) {
  const authError = authorizeCronRequest(request);
  if (authError) return authError;

  const admin = createAdminClient();

  // Inventory every researcher's gaps (uses the same logic the
  // /metadata-fill page does).
  const inventory = await buildResearcherGapInventory(admin);

  // Rate-limit: skip any researcher who got a metadata reminder in the
  // last 20h, whether from this cron or the weekly one — same log.
  const cutoffIso = new Date(
    Date.now() - DEDUP_WINDOW_HOURS * 3_600_000,
  ).toISOString();
  const { data: recent } = await admin
    .from("metadata_reminder_log")
    .select("researcher_user_id, sent_at")
    .gte("sent_at", cutoffIso);
  const recentlyNotified = new Set(
    ((recent ?? []) as Array<{ researcher_user_id: string }>).map(
      (r) => r.researcher_user_id,
    ),
  );

  const summary = {
    inventoried: inventory.length,
    sent: 0,
    skipped_rate_limit: 0,
    skipped_no_contact: 0,
    failed: 0,
    results: [] as Array<{
      researcher_user_id: string;
      display_name: string | null;
      contact_email: string | null;
      experiment_count: number;
      required_gaps: number;
      status: "sent" | "rate_limited" | "no_contact" | "failed";
      error?: string;
      message_id?: string;
    }>,
  };

  for (const g of inventory) {
    const requiredGaps = g.rows.reduce(
      (n, r) => n + r.requiredGaps.length,
      0,
    );
    const base = {
      researcher_user_id: g.profile.id,
      display_name: g.profile.display_name,
      contact_email: g.profile.contact_email,
      experiment_count: g.rows.length,
      required_gaps: requiredGaps,
    };

    if (recentlyNotified.has(g.profile.id)) {
      summary.skipped_rate_limit += 1;
      summary.results.push({ ...base, status: "rate_limited" });
      continue;
    }
    const contact = g.profile.contact_email?.trim();
    if (!contact || !/@/.test(contact)) {
      summary.skipped_no_contact += 1;
      summary.results.push({ ...base, status: "no_contact" });
      continue;
    }

    const res = await sendInterviewEmail(g);
    if (!res.success) {
      summary.failed += 1;
      summary.results.push({ ...base, status: "failed", error: res.error });
      continue;
    }

    // Log a denormalised snapshot so the next run can detect "no
    // progress" without re-rendering the whole template.
    const { error: logErr } = await admin.from("metadata_reminder_log").insert({
      researcher_user_id: g.profile.id,
      sent_at: new Date().toISOString(),
      email_to: contact,
      experiment_count: g.rows.length,
      gap_summary: {
        source: "db-quality-check",
        required_gaps: requiredGaps,
        rows: g.rows.map((r) => ({
          id: r.experiment.id,
          title: r.experiment.title,
          required: r.requiredGaps.map((x) => x.label),
          optional: r.optionalGaps.map((x) => x.label),
        })),
      },
    });
    if (logErr) {
      console.error(
        `[db-quality-check] log insert failed for ${g.profile.id}: ${logErr.message}`,
      );
    }

    summary.sent += 1;
    summary.results.push({
      ...base,
      status: "sent",
      message_id: res.messageId,
    });
  }

  return NextResponse.json(summary);
}

// GET — dry-run preview. Same inventory + rate-limit logic but no
// emails, no log writes. Useful for verifying production state from
// the browser / curl before flipping the cron on.
export async function GET(request: NextRequest) {
  const authError = authorizeCronRequest(request);
  if (authError) return authError;

  const admin = createAdminClient();
  const inventory = await buildResearcherGapInventory(admin);
  const cutoffIso = new Date(
    Date.now() - DEDUP_WINDOW_HOURS * 3_600_000,
  ).toISOString();
  const { data: recent } = await admin
    .from("metadata_reminder_log")
    .select("researcher_user_id, sent_at")
    .gte("sent_at", cutoffIso);
  const recentlyNotified = new Set(
    ((recent ?? []) as Array<{ researcher_user_id: string }>).map(
      (r) => r.researcher_user_id,
    ),
  );

  return NextResponse.json({
    mode: "dry-run",
    inventoried: inventory.length,
    would_send: inventory
      .filter((g) => !recentlyNotified.has(g.profile.id))
      .map((g) => ({
        display_name: g.profile.display_name,
        contact_email: g.profile.contact_email,
        experiment_count: g.rows.length,
        required_gaps: g.rows.reduce(
          (n, r) => n + r.requiredGaps.length,
          0,
        ),
        preview_subject: renderInterviewEmail(g).subject,
      })),
    would_skip_rate_limit: inventory
      .filter((g) => recentlyNotified.has(g.profile.id))
      .map((g) => g.profile.display_name),
  });
}
