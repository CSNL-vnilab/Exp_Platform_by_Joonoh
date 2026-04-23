import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatDateKR, formatTimeKR } from "@/lib/utils/date";
import { NotionHealthCard } from "@/components/notion-health-card";
import { PendingWorkCard } from "@/components/pending-work-card";

export const dynamic = "force-dynamic";

interface UpcomingRow {
  id: string;
  slot_start: string;
  slot_end: string;
  session_number: number;
  subject_number: number | null;
  experiments: { id: string; title: string; project_name: string | null } | null;
  participants: { name: string } | null;
}

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const admin = createAdminClient();
  const nowIso = new Date().toISOString();
  const in7d = new Date(Date.now() + 7 * 86_400_000).toISOString();

  const { data: myExperiments } = await admin
    .from("experiments")
    .select("id, title, status, start_date, end_date, session_type, required_sessions")
    .eq("created_by", user.id)
    .order("created_at", { ascending: false });

  const expIds = (myExperiments ?? []).map((e) => e.id);

  const [{ data: upcoming }, { data: recent }, { data: myCounts }] = await Promise.all([
    admin
      .from("bookings")
      .select(
        "id, slot_start, slot_end, session_number, subject_number, experiments!inner(id, title, project_name, created_by), participants(name)",
      )
      .eq("experiments.created_by", user.id)
      .eq("status", "confirmed")
      .gte("slot_start", nowIso)
      .lte("slot_start", in7d)
      .order("slot_start", { ascending: true })
      .limit(20),
    admin
      .from("bookings")
      .select(
        "id, status, updated_at, created_at, experiments!inner(id, title, created_by), participants(name)",
      )
      .eq("experiments.created_by", user.id)
      .order("updated_at", { ascending: false, nullsFirst: false })
      .limit(6),
    expIds.length > 0
      ? admin
          .from("bookings")
          .select("experiment_id, status")
          .in("experiment_id", expIds)
      : Promise.resolve({ data: [] as { experiment_id: string; status: string }[] }),
  ]);

  const countsByExp: Record<string, { confirmed: number; total: number }> = {};
  for (const b of (myCounts as unknown as { experiment_id: string; status: string }[]) ?? []) {
    const k = b.experiment_id;
    if (!countsByExp[k]) countsByExp[k] = { confirmed: 0, total: 0 };
    countsByExp[k].total++;
    if (b.status === "confirmed") countsByExp[k].confirmed++;
  }

  const active = (myExperiments ?? []).filter((e) => e.status === "active");
  const upcomingRows = (upcoming as unknown as UpcomingRow[]) ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">대시보드</h1>
          <p className="mt-1 text-sm text-muted">최근 7일의 내 실험 현황</p>
        </div>
        <div className="flex gap-2">
          <Link href="/experiments/new">
            <Button>새 실험 만들기</Button>
          </Link>
          <Link href="/schedule">
            <Button variant="secondary">전체 일정 보기</Button>
          </Link>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Upcoming bookings */}
        <Card className="lg:col-span-2">
          <CardContent>
            <div className="mb-4 flex items-baseline justify-between">
              <h2 className="text-lg font-semibold text-foreground">다가오는 예약 (7일)</h2>
              <span className="text-xs text-muted">{upcomingRows.length}건</span>
            </div>
            {upcomingRows.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted">
                앞으로 7일 이내 확정된 예약이 없습니다.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {upcomingRows.map((b) => (
                  <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-foreground">
                        {b.experiments?.title ?? "(알 수 없는 실험)"}
                      </div>
                      <div className="mt-0.5 text-xs text-muted">
                        {formatDateKR(b.slot_start)} {formatTimeKR(b.slot_start)}
                        {"–"}
                        {formatTimeKR(b.slot_end)}
                        {" · "}
                        {b.participants?.name ?? "참여자"}
                        {b.subject_number != null ? ` · Sbj${b.subject_number}` : ""}
                        {b.session_number ? ` · ${b.session_number}회차` : ""}
                      </div>
                    </div>
                    {b.experiments?.id && (
                      <Link
                        href={`/experiments/${b.experiments.id}/bookings`}
                        className="text-xs font-medium text-primary hover:text-primary-hover"
                      >
                        예약 관리 →
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Recent activity */}
        <Card>
          <CardContent>
            <h2 className="mb-4 text-lg font-semibold text-foreground">최근 활동</h2>
            {(recent ?? []).length === 0 ? (
              <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted">
                활동 기록이 없습니다.
              </p>
            ) : (
              <ul className="space-y-3 text-sm">
                {(recent ?? []).map((b) => {
                  const r = b as unknown as {
                    id: string;
                    status: string;
                    updated_at: string | null;
                    created_at: string;
                    experiments: { id: string; title: string } | null;
                    participants: { name: string } | null;
                  };
                  const ts = r.updated_at ?? r.created_at;
                  const statusLabel =
                    r.status === "confirmed"
                      ? { t: "예약", v: "success" as const }
                      : r.status === "cancelled"
                        ? { t: "취소", v: "danger" as const }
                        : r.status === "completed"
                          ? { t: "완료", v: "info" as const }
                          : { t: r.status, v: "default" as const };
                  return (
                    <li key={r.id} className="flex items-start gap-2">
                      <Badge variant={statusLabel.v}>{statusLabel.t}</Badge>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-foreground">
                          {r.participants?.name ?? "참여자"}
                          {" · "}
                          {r.experiments?.title ?? ""}
                        </div>
                        <div className="text-xs text-muted">{formatDateKR(ts)} {formatTimeKR(ts)}</div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Pending work — D2 */}
      <PendingWorkCard userId={user.id} />

      {/* Notion integration health */}
      <NotionHealthCard />

      {/* Active experiments with fill rate */}
      <Card>
        <CardContent>
          <div className="mb-4 flex items-baseline justify-between">
            <h2 className="text-lg font-semibold text-foreground">내 진행 중 실험</h2>
            <span className="text-xs text-muted">{active.length}개</span>
          </div>
          {active.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted">
              진행 중인 실험이 없습니다.
            </p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {active.map((e) => {
                const c = countsByExp[e.id] ?? { confirmed: 0, total: 0 };
                return (
                  <li key={e.id}>
                    <Link
                      href={`/experiments/${e.id}`}
                      className="block rounded-lg border border-border bg-white p-4 transition-shadow hover:shadow-md"
                    >
                      <div className="mb-2 truncate text-sm font-semibold text-foreground">
                        {e.title}
                      </div>
                      <div className="mb-2 text-xs text-muted">
                        {e.start_date} ~ {e.end_date}
                        {" · "}
                        {e.session_type === "multi" ? `다중 ${e.required_sessions}회차` : "단일 세션"}
                      </div>
                      <div className="text-xs text-muted">
                        확정 <span className="font-semibold text-foreground">{c.confirmed}</span>
                        {c.total > 0 && (
                          <span>
                            {" / 취소·기타 "}
                            <span className="font-semibold text-foreground">{c.total - c.confirmed}</span>
                          </span>
                        )}
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
