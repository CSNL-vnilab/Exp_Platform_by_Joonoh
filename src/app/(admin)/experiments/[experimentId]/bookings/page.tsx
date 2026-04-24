import { notFound } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent } from "@/components/ui/card";
import { BookingsManager, type BookingRowView } from "@/components/bookings-manager";
import { PaymentPanel } from "@/components/payment-panel";
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

  const { data: paymentRows } = await admin
    .from("participant_payment_info")
    .select(
      "id, booking_group_id, bank_name, status, amount_krw, amount_overridden, submitted_at, claimed_at, period_start, period_end, participants(name)",
    )
    .eq("experiment_id", experimentId)
    .order("created_at", { ascending: true });

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
      participants: { name: string } | null;
    };
    return {
      id: row.id,
      bookingGroupId: row.booking_group_id,
      participantName: row.participants?.name ?? "-",
      bankName: row.bank_name,
      status: row.status,
      amountKrw: row.amount_krw,
      amountOverridden: row.amount_overridden,
      submittedAt: row.submitted_at,
      claimedAt: row.claimed_at,
      periodStart: row.period_start,
      periodEnd: row.period_end,
    };
  });

  const { data: history } = await admin
    .from("payment_exports")
    .select("id, exported_at, export_kind, participant_count, exported_by, file_name, profiles:exported_by(display_name)")
    .eq("experiment_id", experimentId)
    .order("exported_at", { ascending: false })
    .limit(10);

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
    />
  );
}
