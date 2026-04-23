import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ClassBadge } from "@/components/class-badge";
import { formatDateKR, formatTimeKR } from "@/lib/utils/date";
import type { ParticipantClass } from "@/types/database";

// Dashboard "pending work" card. Backed by the get_researcher_pending_work
// RPC (migration 00034) so the five widgets share one DB round-trip.

interface ClassChangeRow {
  participant_id: string;
  previous_class: ParticipantClass | null;
  new_class: ParticipantClass;
  changed_kind: "auto" | "manual";
  created_at: string;
}

interface PendingWork {
  obs_missing: number;
  notion_stuck: number;
  royal_queue: number;
  auto_completed_7d: number;
  class_changes_7d: ClassChangeRow[];
}

export async function PendingWorkCard({ userId: _userId }: { userId: string }) {
  // The RPC now sources auth.uid() itself (D2-1 IDOR fix, migration 00035).
  // We must call via the cookie-bound (user-scoped) client so auth.uid()
  // inside the function resolves to the caller — the admin client would
  // return null auth.uid() and the function returns {error: 'UNAUTHENTICATED'}.
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_researcher_pending_work");

  if (error) {
    console.error("[PendingWorkCard] rpc failed:", error.message);
    return null;
  }

  const work = (data ?? {
    obs_missing: 0,
    notion_stuck: 0,
    royal_queue: 0,
    auto_completed_7d: 0,
    class_changes_7d: [],
  }) as unknown as PendingWork;

  const tiles: Array<{
    label: string;
    value: number;
    tone: "default" | "danger" | "info" | "success";
    href?: string;
  }> = [
    {
      label: "관찰 미입력",
      value: work.obs_missing,
      tone: work.obs_missing > 0 ? "danger" : "success",
    },
    {
      label: "Notion 미동기화",
      value: work.notion_stuck,
      tone: work.notion_stuck > 0 ? "danger" : "success",
    },
    {
      label: "Royal 승급 대기",
      value: work.royal_queue,
      tone: work.royal_queue > 0 ? "info" : "default",
    },
    {
      label: "최근 7일 자동완료",
      value: work.auto_completed_7d,
      tone: "info",
    },
  ];

  return (
    <Card>
      <CardContent>
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold text-foreground">
            오늘 처리할 일
          </h2>
          <span className="text-xs text-muted">
            실시간 · RPC get_researcher_pending_work
          </span>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {tiles.map((t) => (
            <div
              key={t.label}
              className={`rounded-lg border p-3 ${toneBg(t.tone)}`}
            >
              <div className="text-xs text-muted">{t.label}</div>
              <div className={`mt-0.5 text-2xl font-bold ${toneText(t.tone)}`}>
                {t.value}
              </div>
            </div>
          ))}
        </div>

        {work.class_changes_7d.length > 0 && (
          <div className="mt-5">
            <div className="mb-2 flex items-baseline justify-between">
              <h3 className="text-sm font-semibold text-foreground">
                최근 7일 클래스 변경
              </h3>
              <span className="text-xs text-muted">
                {work.class_changes_7d.length}건
              </span>
            </div>
            <ul className="space-y-1.5">
              {work.class_changes_7d.slice(0, 6).map((c, i) => (
                <li
                  key={`${c.participant_id}-${c.created_at}-${i}`}
                  className="flex flex-wrap items-center gap-2 text-xs"
                >
                  <span className="tabular-nums text-muted">
                    {formatDateKR(c.created_at)} {formatTimeKR(c.created_at)}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <ClassBadge value={c.previous_class} compact />
                    <span className="text-muted">→</span>
                    <ClassBadge value={c.new_class} compact />
                  </div>
                  <Badge variant={c.changed_kind === "manual" ? "info" : "default"}>
                    {c.changed_kind === "manual" ? "수동" : "자동"}
                  </Badge>
                  <Link
                    href={`/participants/${c.participant_id}`}
                    className="text-primary hover:underline"
                  >
                    참여자 보기
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function toneBg(t: "default" | "danger" | "info" | "success"): string {
  return {
    default: "border-border bg-card",
    danger: "border-rose-200 bg-rose-50",
    info: "border-sky-200 bg-sky-50",
    success: "border-emerald-200 bg-emerald-50",
  }[t];
}

function toneText(t: "default" | "danger" | "info" | "success"): string {
  return {
    default: "text-foreground",
    danger: "text-rose-700",
    info: "text-sky-700",
    success: "text-emerald-700",
  }[t];
}
