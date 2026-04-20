import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { format } from "date-fns";

const statusConfig: Record<
  string,
  { label: string; variant: "default" | "success" | "info" | "danger" }
> = {
  draft: { label: "초안", variant: "default" },
  active: { label: "진행 중", variant: "success" },
  completed: { label: "완료", variant: "info" },
  cancelled: { label: "취소", variant: "danger" },
};

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
    .select("*")
    .eq("created_by", user.id)
    .order("created_at", { ascending: false });

  // Fetch booking counts per experiment
  const experimentIds = experiments?.map((e) => e.id) ?? [];
  let bookingCounts: Record<string, number> = {};

  if (experimentIds.length > 0) {
    const { data: bookings } = await supabase
      .from("bookings")
      .select("experiment_id")
      .in("experiment_id", experimentIds)
      .eq("status", "confirmed");

    if (bookings) {
      bookingCounts = bookings.reduce<Record<string, number>>((acc, b) => {
        acc[b.experiment_id] = (acc[b.experiment_id] ?? 0) + 1;
        return acc;
      }, {});
    }
  }

  return (
    <div>
      <div className="mb-8 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-foreground">실험 관리</h1>
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
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {experiments.map((experiment) => {
            const status = statusConfig[experiment.status] ?? statusConfig.draft;
            const count = bookingCounts[experiment.id] ?? 0;

            return (
              <Link
                key={experiment.id}
                href={`/experiments/${experiment.id}`}
                className="block"
              >
                <Card className="h-full transition-shadow hover:shadow-md">
                  <CardContent>
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="font-semibold text-foreground line-clamp-2">
                        {experiment.title}
                      </h3>
                      <Badge variant={status.variant}>{status.label}</Badge>
                    </div>
                    <p className="mt-3 text-sm text-muted">
                      {format(new Date(experiment.start_date), "yyyy.MM.dd")} ~{" "}
                      {format(new Date(experiment.end_date), "yyyy.MM.dd")}
                    </p>
                    <div className="mt-3 flex items-center gap-4 text-sm text-muted">
                      <span>{experiment.session_duration_minutes}분/세션</span>
                      <span>예약 {count}건</span>
                    </div>
                    {experiment.participation_fee > 0 && (
                      <p className="mt-2 text-sm font-medium text-primary">
                        참여비 {experiment.participation_fee.toLocaleString()}원
                      </p>
                    )}
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
