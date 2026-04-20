import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default async function DashboardPage() {
  const supabase = await createClient();

  // Fetch experiment counts by status
  const { data: experiments } = await supabase
    .from("experiments")
    .select("id, status");

  const totalExperiments = experiments?.length ?? 0;
  const activeExperiments =
    experiments?.filter((e) => e.status === "active").length ?? 0;
  const completedExperiments =
    experiments?.filter((e) => e.status === "completed").length ?? 0;

  // Fetch total bookings count
  const { count: totalBookings } = await supabase
    .from("bookings")
    .select("id", { count: "exact", head: true });

  const { count: confirmedBookings } = await supabase
    .from("bookings")
    .select("id", { count: "exact", head: true })
    .eq("status", "confirmed");

  const stats = [
    {
      label: "전체 실험",
      value: totalExperiments,
      color: "text-foreground",
    },
    {
      label: "진행 중",
      value: activeExperiments,
      color: "text-success",
    },
    {
      label: "완료",
      value: completedExperiments,
      color: "text-primary",
    },
    {
      label: "전체 예약",
      value: totalBookings ?? 0,
      color: "text-foreground",
    },
    {
      label: "확정 예약",
      value: confirmedBookings ?? 0,
      color: "text-success",
    },
  ];

  return (
    <div>
      <div className="mb-8 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-foreground">대시보드</h1>
        <Link href="/experiments/new">
          <Button>새 실험 만들기</Button>
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {stats.map((stat) => (
          <Card key={stat.label}>
            <CardContent>
              <p className="text-sm text-muted">{stat.label}</p>
              <p className={`mt-1 text-3xl font-bold ${stat.color}`}>
                {stat.value}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="mt-8">
        <Card>
          <CardContent>
            <h2 className="text-lg font-semibold text-foreground mb-4">
              빠른 링크
            </h2>
            <div className="flex flex-wrap gap-3">
              <Link href="/experiments/new">
                <Button variant="secondary" size="sm">
                  새 실험 만들기
                </Button>
              </Link>
              <Link href="/experiments">
                <Button variant="secondary" size="sm">
                  실험 목록 보기
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
