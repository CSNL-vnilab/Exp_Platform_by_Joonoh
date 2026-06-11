import { notFound } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent } from "@/components/ui/card";
import { BookingsManager, type BookingRowView } from "@/components/bookings-manager";
import { PaymentPanel } from "@/components/payment-panel";
import { recommendAmount } from "@/lib/payments/amount";
import type { PaymentStatus } from "@/types/database";

export const dynamic = "force-dynamic";

export default async function BookingsPage({
  params,
}: {
  params: Promise<{ experimentId: string }>;
}) {
  const { experimentId } = await params;
  const supabase = await createClient();

  const { data: experiment } = await supabase
    .from("experiments")
    .select(
      "id, title, session_type, required_sessions, project_name, experiment_mode, lab_id",
    )
    .eq("id", experimentId)
    .single();

  if (!experiment) {
    notFound();
  }

  const { data: bookings } = await supabase
    .from("bookings")
    .select(
      `id, slot_start, slot_end, session_number, status, created_at, subject_number, participant_id,
       exclusion_flag, exclusion_reason, data_quality,
       participants (name, phone, email, gender, birthdate)`,
    )
    .eq("experiment_id", experimentId)
    .order("slot_start", { ascending: true });

  const baseRows = (bookings ?? []) as unknown as Array<
    BookingRowView & { participant_id: string }
  >;

  // Join current class (scoped to this experiment's lab) + existence of
  // booking_observations. These two lookups drive new row columns added in
  // this sprint; they're issued in parallel to keep SSR latency flat.
  const participantIds = Array.from(
    new Set(baseRows.map((r) => r.participant_id)),
  );
  const bookingIds = baseRows.map((r) => r.id);

  type ClassLookupRow = { participant_id: string; class: string };
  type ObservationLookupRow = { booking_id: string };

  const [classResult, observationResult] = await Promise.all([
    participantIds.length > 0 && experiment.lab_id
      ? supabase
          .from("participant_class_current")
          .select("participant_id, class")
          .eq("lab_id", experiment.lab_id)
          .in("participant_id", participantIds)
      : Promise.resolve<{ data: ClassLookupRow[] | null }>({ data: [] }),
    bookingIds.length > 0
      ? supabase
          .from("booking_observations")
          .select("booking_id")
          .in("booking_id", bookingIds)
      : Promise.resolve<{ data: ObservationLookupRow[] | null }>({ data: [] }),
  ]);

  const classByParticipant = new Map<string, string>(
    ((classResult.data ?? []) as ClassLookupRow[]).map((r) => [
      r.participant_id,
      r.class,
    ]),
  );
  const observedBookings = new Set<string>(
    ((observationResult.data ?? []) as ObservationLookupRow[]).map(
      (r) => r.booking_id,
    ),
  );

  // For online/hybrid experiments, join progress rows so the manager can
  // surface completion codes and verification state alongside each row.
  let rows: BookingRowView[] = baseRows.map((r) => ({
    ...r,
    current_class:
      (classByParticipant.get(r.participant_id) as BookingRowView["current_class"]) ??
      null,
    has_observation: observedBookings.has(r.id),
  }));
  if (rows.length > 0 && experiment.experiment_mode !== "offline") {
    const ids = rows.map((r) => r.id);
    const { data: progressRows } = await supabase
      .from("experiment_run_progress")
      .select(
        "booking_id, blocks_submitted, completion_code, completion_code_issued_at, verified_at, is_pilot, condition_assignment, attention_fail_count",
      )
      .in("booking_id", ids);
    const byBooking = new Map(
      (progressRows ?? []).map((p) => [p.booking_id, p]),
    );
    // Screener pass/fail counts — one query, aggregate client-side.
    const { data: screenerResp } = await supabase
      .from("experiment_online_screener_responses")
      .select("booking_id, passed")
      .in("booking_id", ids);
    const screenerAgg = new Map<string, { total: number; passed: number }>();
    for (const r of screenerResp ?? []) {
      const a = screenerAgg.get(r.booking_id) ?? { total: 0, passed: 0 };
      a.total += 1;
      if (r.passed) a.passed += 1;
      screenerAgg.set(r.booking_id, a);
    }
    rows = rows.map((r) => ({
      ...r,
      run_progress: byBooking.get(r.id)
        ? {
            blocks_submitted: byBooking.get(r.id)!.blocks_submitted,
            completion_code: byBooking.get(r.id)!.completion_code,
            completion_code_issued_at:
              byBooking.get(r.id)!.completion_code_issued_at,
            verified_at: byBooking.get(r.id)!.verified_at,
            is_pilot: byBooking.get(r.id)!.is_pilot ?? false,
            condition_assignment: byBooking.get(r.id)!.condition_assignment ?? null,
            attention_fail_count: byBooking.get(r.id)!.attention_fail_count ?? 0,
            screener_stats: screenerAgg.get(r.id) ?? null,
          }
        : null,
    }));
  }

  return (
    <div>
      <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Link
            href={`/experiments/${experimentId}`}
            className="text-sm text-muted hover:text-foreground"
          >
            &larr; 실험 상세로 돌아가기
          </Link>
          <h1 className="mt-1 text-2xl font-bold text-foreground">
            예약 관리 · {experiment.title}
          </h1>
        </div>
      </div>

      {rows.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted">아직 예약이 없습니다.</p>
          </CardContent>
        </Card>
      ) : (
        <BookingsManager
          experimentId={experimentId}
          experimentTitle={experiment.title}
          projectName={experiment.project_name ?? null}
          experimentMode={experiment.experiment_mode}
          rows={rows}
        />
      )}

      {/* Payment / 정산 panel — shows rows even if empty so researcher sees
          that the experiment has no payments yet */}
      <div className="mt-6">
        <PaymentSection experimentId={experimentId} />
      </div>
    </div>
  );
}

async function PaymentSection({ experimentId }: { experimentId: string }) {
  const admin = createAdminClient();

  // Payment rows + the experiment's fee/session basis (drives the
  // recommendAmount() hint in the panel). Both independent → one
  // Promise.all keeps SSR latency flat.
  const [paymentRowsResult, feeResult] = await Promise.all([
    admin
      .from("participant_payment_info")
      .select(
        // payment_link_* columns added in migration 00051 — surface dispatch
        // state in the panel so researchers can see who got the email and
        // resend on failure.
        "id, booking_group_id, bank_name, status, amount_krw, amount_overridden, submitted_at, claimed_at, period_start, period_end, payment_link_sent_at, payment_link_attempts, payment_link_last_error, name_override, participants(name)",
      )
      .eq("experiment_id", experimentId)
      .order("created_at", { ascending: true }),
    admin
      .from("experiments")
      .select("participation_fee, required_sessions")
      .eq("id", experimentId)
      .maybeSingle(),
  ]);
  const { data: paymentRows } = paymentRowsResult;
  // experiments.participation_fee = TOTAL fee for the planned run;
  // required_sessions = the session count that fee was scoped to. Feeds
  // recommendAmount() as totalFeeKrw / plannedSessions. Defaults keep a
  // missing experiment row from poisoning the recommendation (helper
  // treats fee<=0 / sessions<=1 as "no adjustment").
  const experimentFee = (feeResult.data?.participation_fee as number | undefined) ?? 0;
  const plannedSessions =
    (feeResult.data?.required_sessions as number | undefined) ?? null;

  // Compute "all bookings in this group are completed" once for every
  // group surfaced. Used by the panel to disable the resend button when
  // the dispatch is not yet meaningful.
  const groupIds = (paymentRows ?? []).map(
    (r) => (r as unknown as { booking_group_id: string }).booking_group_id,
  );
  const allCompleted = new Map<string, boolean>();
  // Per-group session-status tally. completedSessions feeds
  // recommendAmount() (server-side — the panel never re-queries bookings);
  // the rest are carried so the panel can show "4/5회 완료" context.
  type SessionCounts = {
    completed: number;
    no_show: number;
    cancelled: number;
    planned: number;
  };
  const countsByGroup = new Map<string, SessionCounts>();
  if (groupIds.length > 0) {
    const { data: groupBookings } = await admin
      .from("bookings")
      .select("booking_group_id, status")
      .in("booking_group_id", groupIds);
    const byGroup = new Map<string, string[]>();
    for (const b of groupBookings ?? []) {
      const row = b as unknown as { booking_group_id: string | null; status: string };
      if (!row.booking_group_id) continue;
      const list = byGroup.get(row.booking_group_id) ?? [];
      list.push(row.status);
      byGroup.set(row.booking_group_id, list);
    }
    for (const gid of groupIds) {
      const statuses = byGroup.get(gid) ?? [];
      // Match notifyPaymentInfoIfReady's gate exactly (service line 286):
      // exclude 'cancelled' rows from the "all must be completed" check.
      // Previously the page required EVERY booking to be 'completed',
      // which meant a group with mixed completed+cancelled sessions
      // never satisfied the page-side gate and the "안내 메일 발송"
      // button never appeared — even though the helper would accept the
      // send. 2026-06-09 fix.
      // 2026-06-11 visual-QC fix: match notifyPaymentInfoIfReady's gate
      // EXACTLY — {cancelled, no_show} are both terminal-non-payable.
      // 8822dd2 updated the server gate but left this page on the old
      // cancelled-only rule, so a 4-completed + 1-no_show group showed
      // "세션 종료 대기" forever while the server was ready to send.
      const payable = statuses.filter(
        (s) => s !== "cancelled" && s !== "no_show",
      );
      allCompleted.set(
        gid,
        payable.length > 0 && payable.every((s) => s === "completed"),
      );
      // Tally the four buckets the amount hint cares about. Any status
      // that isn't completed/no_show/cancelled (e.g. confirmed/running)
      // counts as "planned/in-flight" — surfaced only for context, the
      // recommendation keys off `completed`.
      const counts: SessionCounts = {
        completed: 0,
        no_show: 0,
        cancelled: 0,
        planned: 0,
      };
      for (const s of statuses) {
        if (s === "completed") counts.completed += 1;
        else if (s === "no_show") counts.no_show += 1;
        else if (s === "cancelled") counts.cancelled += 1;
        else counts.planned += 1;
      }
      countsByGroup.set(gid, counts);
    }
  }

  const payments = (paymentRows ?? []).map((r) => {
    const row = r as unknown as {
      id: string;
      booking_group_id: string;
      bank_name: string | null;
      status: PaymentStatus;
      amount_krw: number;
      amount_overridden: boolean;
      submitted_at: string | null;
      claimed_at: string | null;
      period_start: string | null;
      period_end: string | null;
      payment_link_sent_at: string | null;
      payment_link_attempts: number;
      payment_link_last_error: string | null;
      name_override: string | null;
      participants: { name: string } | null;
    };
    const counts = countsByGroup.get(row.booking_group_id);
    const completedSessions = counts?.completed ?? 0;
    // Recommended amount is a *hint* — recommendAmount() never auto-
    // applies (see src/lib/payments/amount.ts). Computed here in the
    // server component so the client panel doesn't re-query bookings.
    // We only surface it when (a) the helper says it's adjusted vs. the
    // posted fee AND (b) it actually differs from what's stored now AND
    // (c) the row hasn't been manually overridden (researcher already
    // decided) — the panel decides final visibility, but we pass the
    // raw numbers so the gate stays in one place.
    const rec = recommendAmount({
      totalFeeKrw: experimentFee,
      plannedSessions,
      completedSessions,
    });
    return {
      id: row.id,
      bookingGroupId: row.booking_group_id,
      participantName: row.name_override?.trim() || row.participants?.name || "-",
      bankName: row.bank_name,
      status: row.status,
      amountKrw: row.amount_krw,
      amountOverridden: row.amount_overridden,
      submittedAt: row.submitted_at,
      claimedAt: row.claimed_at,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      paymentLinkSentAt: row.payment_link_sent_at,
      paymentLinkAttempts: row.payment_link_attempts ?? 0,
      paymentLinkLastError: row.payment_link_last_error,
      allBookingsCompleted: allCompleted.get(row.booking_group_id) ?? false,
      // Session tally + amount recommendation (carried as props; the
      // panel renders the "추천 N원 (x/y회 완료)" affordance off these).
      completedSessions,
      plannedSessions,
      recommendedKrw: rec.recommendedKrw,
      recommendedAdjusted: rec.adjusted,
    };
  });

  // Parallel fetch — payment_exports history (audit trail) + most
  // recent payment_claim with no dispatch email yet (drives the 📧
  // button). Both are independent of each other, so a single Promise.all
  // saves one round-trip on every page load.
  const [historyResult, claimResult] = await Promise.all([
    admin
      .from("payment_exports")
      .select(
        "id, exported_at, export_kind, participant_count, exported_by, file_name, profiles:exported_by(display_name)",
      )
      .eq("experiment_id", experimentId)
      .order("exported_at", { ascending: false })
      .limit(10),
    admin
      .from("payment_claims")
      .select("id, claimed_at, participant_count, total_krw, email_sent_at")
      .eq("experiment_id", experimentId)
      .is("email_sent_at", null)
      .order("claimed_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  const { data: history } = historyResult;
  const { data: claimRow } = claimResult;
  const recentUnsentClaim = claimRow
    ? {
        id: (claimRow as { id: string }).id,
        claimedAt: (claimRow as { claimed_at: string }).claimed_at,
        participantCount: (claimRow as { participant_count: number })
          .participant_count,
        totalKrw: (claimRow as { total_krw: number }).total_krw,
      }
    : null;

  const exportHistory = (history ?? []).map((h) => {
    const row = h as unknown as {
      id: string;
      exported_at: string;
      export_kind: "individual_form" | "upload_form" | "both" | "claim_bundle";
      participant_count: number;
      file_name: string | null;
      profiles: { display_name: string | null } | null;
    };
    return {
      id: row.id,
      exported_at: row.exported_at,
      export_kind: row.export_kind,
      participant_count: row.participant_count,
      exported_by_name: row.profiles?.display_name ?? null,
      file_name: row.file_name,
    };
  });

  return (
    <PaymentPanel
      experimentId={experimentId}
      rows={payments}
      exportHistory={exportHistory}
      recentUnsentClaim={recentUnsentClaim}
      defaultAdminEmail={process.env.LAB_ADMIN_EMAIL ?? ""}
    />
  );
}
