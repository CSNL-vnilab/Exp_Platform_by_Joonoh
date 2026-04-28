import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ExperimentList, type ExperimentListRow } from "@/components/experiment-list";

export const dynamic = "force-dynamic";

export default async function ExperimentsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: experiments } = await supabase
    .from("experiments")
    .select(
      "id, title, project_name, status, session_duration_minutes, session_type, required_sessions, participation_fee, start_date, end_date, created_at, notion_project_page_id, description, protocol_version",
    )
    .eq("created_by", user.id)
    .order("created_at", { ascending: false });

  const experimentIds = experiments?.map((e) => e.id) ?? [];
  // Per-status counts (not just "confirmed") so backfilled completed
  // experiments don't render as "예약 0건". Card surfaces all four
  // numbers so the researcher sees the real shape of the experiment's
  // booking history.
  const bookingCounts: Record<
    string,
    { confirmed: number; completed: number; cancelled: number; total: number }
  > = {};
  if (experimentIds.length > 0) {
    const { data: bookings } = await supabase
      .from("bookings")
      .select("experiment_id, status")
      .in("experiment_id", experimentIds);
    for (const b of bookings ?? []) {
      const c =
        bookingCounts[b.experiment_id] ??
        (bookingCounts[b.experiment_id] = {
          confirmed: 0, completed: 0, cancelled: 0, total: 0,
        });
      c.total += 1;
      if (b.status === "confirmed") c.confirmed += 1;
      else if (b.status === "completed") c.completed += 1;
      else if (b.status === "cancelled") c.cancelled += 1;
    }
  }

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">실험 관리</h1>
          <p className="mt-1 text-sm text-muted">
            내가 생성한 실험 {experiments?.length ?? 0}개
          </p>
        </div>
        <Link href="/experiments/new">
          <Button>새 실험 만들기</Button>
        </Link>
      </div>

      {!experiments || experiments.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted">등록된 실험이 없습니다.</p>
            <Link href="/experiments/new" className="mt-4 inline-block">
              <Button variant="secondary">첫 실험을 만들어보세요</Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <ExperimentList
          items={(experiments as unknown as ExperimentListRow[]) ?? []}
          bookingCounts={bookingCounts}
        />
      )}
    </div>
  );
}
