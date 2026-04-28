import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ExperimentDetail } from "@/components/experiment-detail";

export default async function ExperimentDetailPage({
  params,
}: {
  params: Promise<{ experimentId: string }>;
}) {
  const { experimentId } = await params;
  const supabase = await createClient();

  const { data: experiment } = await supabase
    .from("experiments")
    .select("*")
    .eq("id", experimentId)
    .single();

  if (!experiment) {
    notFound();
  }

  // Per-status breakdown so backfilled experiments (all completed) don't
  // render as "확정 예약 0건". Mirrors the fix on /experiments listing.
  const { data: rows } = await supabase
    .from("bookings")
    .select("status")
    .eq("experiment_id", experimentId);
  const breakdown = { confirmed: 0, completed: 0, cancelled: 0, total: 0 };
  for (const r of rows ?? []) {
    breakdown.total += 1;
    if (r.status === "confirmed") breakdown.confirmed += 1;
    else if (r.status === "completed") breakdown.completed += 1;
    else if (r.status === "cancelled") breakdown.cancelled += 1;
  }

  return (
    <ExperimentDetail
      experiment={experiment}
      bookingCount={breakdown.confirmed}
      bookingBreakdown={breakdown}
    />
  );
}
