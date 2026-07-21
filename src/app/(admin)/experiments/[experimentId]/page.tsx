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

  // Resolve the linked location so the detail page shows the saved address
  // back to the researcher (previously invisible — the "saved but I can't
  // see it" half of the address bug).
  const { data: location } = experiment.location_id
    ? await supabase
        .from("experiment_locations")
        .select("*")
        .eq("id", experiment.location_id)
        .maybeSingle()
    : { data: null };

  // Per-status breakdown so backfilled experiments (all completed) don't
  // render as "확정 예약 0건". Mirrors the fix on /experiments listing.
  // participant_id is also pulled so we can compute the distinct-
  // headcount that the recruitment_target gate uses — same engaged
  // statuses, so participants whose every booking is 'cancelled' fall
  // out of the count automatically.
  const { data: rows } = await supabase
    .from("bookings")
    .select("status, participant_id")
    .eq("experiment_id", experimentId);
  const breakdown = { confirmed: 0, completed: 0, cancelled: 0, total: 0 };
  const recruitedSet = new Set<string>();
  for (const r of rows ?? []) {
    breakdown.total += 1;
    if (r.status === "confirmed") breakdown.confirmed += 1;
    else if (r.status === "completed") breakdown.completed += 1;
    else if (r.status === "cancelled") breakdown.cancelled += 1;
    if (
      r.participant_id &&
      (r.status === "confirmed" ||
        r.status === "running" ||
        r.status === "completed" ||
        r.status === "no_show")
    ) {
      recruitedSet.add(r.participant_id);
    }
  }

  return (
    <ExperimentDetail
      experiment={experiment}
      bookingCount={breakdown.confirmed}
      bookingBreakdown={breakdown}
      recruitedCount={recruitedSet.size}
      location={location}
    />
  );
}
