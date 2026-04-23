import { notFound } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { LiveSessionBoard } from "@/components/run/live-session-board";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function LiveSessionsPage({
  params,
}: {
  params: Promise<{ experimentId: string }>;
}) {
  const { experimentId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) notFound();

  const admin = createAdminClient();
  const { data: exp } = await admin
    .from("experiments")
    .select("id, title, experiment_mode, created_by, online_runtime_config")
    .eq("id", experimentId)
    .maybeSingle();
  if (!exp) notFound();

  const { data: profile } = await admin
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  const isAdmin = profile?.role === "admin";
  if (!isAdmin && exp.created_by !== user.id) notFound();

  if (exp.experiment_mode === "offline") {
    return (
      <div className="py-20 text-center text-sm text-muted">
        오프라인 실험은 실시간 대시보드를 지원하지 않습니다.
      </div>
    );
  }

  // Seed the client with current in-flight rows. Client subscribes to
  // Realtime and updates the board as events arrive.
  const { data: progressRows } = await admin
    .from("experiment_run_progress")
    .select(
      `booking_id, blocks_submitted, last_block_at, completion_code, verified_at,
       is_pilot, condition_assignment, attention_fail_count, behavior_signals,
       bookings!inner(subject_number, slot_start, status, participants(name))`,
    )
    .eq("bookings.experiment_id", experimentId);

  const initial = (progressRows ?? []).map((r) => {
    const b = r.bookings as unknown as {
      subject_number: number | null;
      slot_start: string;
      status: string;
      participants: { name: string } | null;
    };
    return {
      booking_id: r.booking_id,
      subject_number: b?.subject_number ?? null,
      participant_name: b?.participants?.name ?? "-",
      slot_start: b?.slot_start ?? null,
      status: b?.status ?? "confirmed",
      blocks_submitted: r.blocks_submitted,
      last_block_at: r.last_block_at,
      completion_code: r.completion_code,
      verified_at: r.verified_at,
      is_pilot: r.is_pilot,
      condition_assignment: r.condition_assignment,
      attention_fail_count: r.attention_fail_count,
      behavior_signals: (r.behavior_signals as Record<string, unknown>) ?? {},
    };
  });

  const blockCount =
    (exp.online_runtime_config as { block_count?: number } | null)?.block_count ?? null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-2">
        <div>
          <Link
            href={`/experiments/${experimentId}`}
            className="text-sm text-muted hover:text-foreground"
          >
            &larr; 실험 상세
          </Link>
          <h1 className="mt-1 text-2xl font-bold text-foreground">
            실시간 세션 · {exp.title}
          </h1>
          <p className="mt-1 text-xs text-muted">
            참여자가 실험 중인 상황을 실시간으로 확인합니다. 5분 이상 블록 전송이 없으면 정체로
            표시됩니다.
          </p>
        </div>
      </div>
      <LiveSessionBoard
        experimentId={experimentId}
        blockCount={blockCount}
        initial={initial}
      />
    </div>
  );
}
