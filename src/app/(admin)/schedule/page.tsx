import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ScheduleView } from "@/components/schedule/schedule-view";

export const dynamic = "force-dynamic";

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const params = await searchParams;
  const today = new Date();
  const kstToday = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(today);
  const defaultFrom = params.from ?? kstToday;
  // Default to 14 days ahead.
  const defaultTo =
    params.to ??
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(Date.now() + 14 * 86_400_000));

  const rangeStartIso = `${defaultFrom}T00:00:00+09:00`;
  const rangeEndIso = `${defaultTo}T23:59:59+09:00`;

  const admin = createAdminClient();

  const { data: rows } = await admin
    .from("bookings")
    .select(
      "id, slot_start, slot_end, session_number, subject_number, status, experiment_id, experiments(id, title, project_name, created_by), participants(name)",
    )
    .eq("status", "confirmed")
    .gte("slot_start", rangeStartIso)
    .lte("slot_start", rangeEndIso)
    .order("slot_start", { ascending: true });

  // Fetch researchers so we can show display names + colors.
  const creatorIds = Array.from(
    new Set(
      ((rows as unknown as Array<{ experiments: { created_by: string | null } | null }>) ?? [])
        .map((r) => r.experiments?.created_by)
        .filter((x): x is string => !!x),
    ),
  );
  let creators: Array<{ id: string; display_name: string | null }> = [];
  if (creatorIds.length > 0) {
    const { data } = await admin
      .from("profiles")
      .select("id, display_name")
      .in("id", creatorIds);
    creators = data ?? [];
  }

  return (
    <ScheduleView
      rows={(rows as unknown as ScheduleRowIn[]) ?? []}
      creators={creators}
      from={defaultFrom}
      to={defaultTo}
    />
  );
}

type ScheduleRowIn = {
  id: string;
  slot_start: string;
  slot_end: string;
  session_number: number;
  subject_number: number | null;
  status: string;
  experiment_id: string;
  experiments: { id: string; title: string; project_name: string | null; created_by: string | null } | null;
  participants: { name: string } | null;
};
