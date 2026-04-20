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

  const { count } = await supabase
    .from("bookings")
    .select("id", { count: "exact", head: true })
    .eq("experiment_id", experimentId)
    .eq("status", "confirmed");

  return <ExperimentDetail experiment={experiment} bookingCount={count ?? 0} />;
}
