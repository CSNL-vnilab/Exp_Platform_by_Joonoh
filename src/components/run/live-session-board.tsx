"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { EmptyState } from "@/components/ui/empty-state";
import {
  ParticipantProgress,
  type ProgressTone,
} from "@/components/run/participant-progress";

interface Row {
  booking_id: string;
  subject_number: number | null;
  participant_name: string;
  slot_start: string | null;
  status: string;
  blocks_submitted: number;
  last_block_at: string | null;
  completion_code: string | null;
  verified_at: string | null;
  is_pilot: boolean | null;
  condition_assignment: string | null;
  attention_fail_count: number | null;
  behavior_signals: Record<string, unknown>;
}

// Realtime dashboard for in-flight online sessions. Subscribes to Supabase
// Realtime on experiment_run_progress; each payload event updates the row
// in-place. Idle threshold: 5 minutes since last_block_at flags a session
// as possibly stuck (network drop, tab closed, participant stepped away).
//
// This view is researcher-only (enforced by the page wrapper's auth check).

const IDLE_MS = 5 * 60 * 1000;

// Single source of truth for a row's lifecycle state, so the dot, label,
// row tint, and progress-bar fill all stay semantically in sync. Colour
// follows the app's semantic ramp (R3 convention), never colour alone —
// every state carries a text label too:
//   verified  → success  (확인됨)
//   completed → info     (완료 — 코드 발급, 확인 대기)
//   idle      → warning  (멈춤(응답 끊김) — attention, not error)
//   running   → info     (진행 중)
//   waiting   → neutral  (시작 전)
type SessionState = "verified" | "completed" | "idle" | "running" | "waiting";

function resolveState(row: Row, now: number): SessionState {
  if (row.verified_at) return "verified";
  if (row.completion_code) return "completed";
  if (row.blocks_submitted > 0) {
    const ms = row.last_block_at
      ? now - new Date(row.last_block_at).getTime()
      : Infinity;
    return ms > IDLE_MS ? "idle" : "running";
  }
  return "waiting";
}

const STATE_META: Record<
  SessionState,
  { label: string; dot: string; text: string; tone: ProgressTone }
> = {
  verified: { label: "확인됨", dot: "bg-success", text: "text-success-700", tone: "success" },
  completed: { label: "완료 (확인 대기)", dot: "bg-info-600", text: "text-info-700", tone: "success" },
  idle: { label: "멈춤(응답 끊김)", dot: "bg-warning-600", text: "text-warning-700", tone: "warning" },
  running: { label: "진행 중", dot: "bg-info-600", text: "text-info-700", tone: "info" },
  waiting: { label: "시작 전", dot: "bg-neutral-300", text: "text-neutral-500", tone: "neutral" },
};

export function LiveSessionBoard({
  experimentId,
  blockCount,
  initial,
}: {
  experimentId: string;
  blockCount: number | null;
  initial: Row[];
}) {
  const [rows, setRows] = useState<Row[]>(initial);
  const [now, setNow] = useState<number>(() => Date.now());

  // Drive the "idle" highlighting even when no Realtime event arrives.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  // Lock subscription to the specific booking_ids the server seeded us with
  // so we don't receive rows from other experiments (review C1). Realtime
  // filter only supports eq/in on a single column; we use booking_id IN
  // (…). The initial render's booking list is the universe of bookings
  // for this experiment — new bookings appearing later still reach us on
  // a page refresh, which is acceptable for a dashboard use case.
  useEffect(() => {
    const supabase = createClient();
    const allowed = new Set(initial.map((r) => r.booking_id));
    if (allowed.size === 0) return;
    const channel = supabase
      .channel(`live-run:${experimentId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "experiment_run_progress",
          filter: `booking_id=in.(${Array.from(allowed).join(",")})`,
        },
        (payload) => {
          const next = payload.new as Partial<Row> & { booking_id?: string };
          if (!next?.booking_id || !allowed.has(next.booking_id)) return;
          setRows((prev) => {
            const idx = prev.findIndex((r) => r.booking_id === next.booking_id);
            if (idx < 0) return prev;
            const merged = { ...prev[idx], ...next } as Row;
            const copy = prev.slice();
            copy[idx] = merged;
            return copy;
          });
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [experimentId, initial]);

  const sorted = useMemo(() => {
    return rows.slice().sort((a, b) => {
      const la = a.last_block_at ? new Date(a.last_block_at).getTime() : 0;
      const lb = b.last_block_at ? new Date(b.last_block_at).getTime() : 0;
      return lb - la;
    });
  }, [rows]);

  const stats = useMemo(() => {
    let running = 0;
    let idle = 0;
    let completed = 0;
    let verified = 0;
    for (const r of rows) {
      switch (resolveState(r, now)) {
        case "verified":
          verified++;
          break;
        case "completed":
          completed++;
          break;
        case "idle":
          idle++;
          break;
        case "running":
          running++;
          break;
      }
    }
    return { running, idle, completed, verified, total: rows.length };
  }, [rows, now]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <StatCard label="총 세션" value={stats.total} />
        <StatCard label="진행 중" value={stats.running} tone="info" dot="bg-info-600" />
        <StatCard label="멈춤(응답 끊김)" value={stats.idle} tone="warning" dot="bg-warning-600" />
        <StatCard label="코드 발급" value={stats.completed} tone="info" dot="bg-info-600" />
        <StatCard label="확인 완료" value={stats.verified} tone="success" dot="bg-success" />
      </div>

      {sorted.length === 0 ? (
        <EmptyState title="아직 시작한 참여자가 없습니다." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-card text-2xs tracking-wide text-muted uppercase">
                <th className="px-4 py-2.5 text-left font-medium">피험자</th>
                <th className="px-4 py-2.5 text-left font-medium">참여자</th>
                <th className="px-4 py-2.5 text-left font-medium">예약 시간</th>
                <th className="px-4 py-2.5 text-left font-medium">진행</th>
                <th className="px-4 py-2.5 text-left font-medium">마지막 신호</th>
                <th className="px-4 py-2.5 text-left font-medium">상태</th>
                <th className="px-4 py-2.5 text-left font-medium">플래그</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <Row key={r.booking_id} row={r} now={now} blockCount={blockCount} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  tone,
  dot,
}: {
  label: string;
  value: number;
  tone?: "info" | "warning" | "success";
  dot?: string;
}) {
  const color =
    tone === "info"
      ? "text-info-700"
      : tone === "warning"
        ? "text-warning-700"
        : tone === "success"
          ? "text-success-700"
          : "text-foreground";
  return (
    <div className="rounded-xl border border-border bg-white p-4">
      <div className="flex items-center gap-1.5 text-2xs text-neutral-500">
        {dot && (
          <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} aria-hidden />
        )}
        {label}
      </div>
      <div className={`mt-0.5 text-2xl font-bold tabular-nums ${color}`}>{value}</div>
    </div>
  );
}

function Row({
  row,
  now,
  blockCount,
}: {
  row: Row;
  now: number;
  blockCount: number | null;
}) {
  const lastMs = row.last_block_at
    ? now - new Date(row.last_block_at).getTime()
    : null;
  const state = resolveState(row, now);
  const meta = STATE_META[state];
  const idle = state === "idle";

  return (
    <tr
      className={`border-b border-border last:border-b-0 ${
        idle ? "bg-warning-50" : ""
      }`}
    >
      <td className="px-4 py-3 whitespace-nowrap tabular-nums text-foreground">
        {row.subject_number != null ? `피험자${row.subject_number}번` : "-"}
      </td>
      <td className="px-4 py-3 font-medium text-foreground">
        {row.participant_name}
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-xs tabular-nums text-muted">
        {row.slot_start
          ? new Intl.DateTimeFormat("ko-KR", {
              timeZone: "Asia/Seoul",
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            }).format(new Date(row.slot_start))
          : "-"}
      </td>
      <td className="px-4 py-3 align-middle">
        <ParticipantProgress
          submitted={row.blocks_submitted}
          total={blockCount}
          tone={meta.tone}
        />
      </td>
      <td className="px-4 py-3 text-xs tabular-nums text-muted">
        {lastMs === null
          ? "-"
          : lastMs < 60_000
            ? `${Math.round(lastMs / 1000)}s 전`
            : lastMs < 60 * 60_000
              ? `${Math.round(lastMs / 60_000)}m 전`
              : `${Math.round(lastMs / 3_600_000)}h 전`}
      </td>
      <td className="px-4 py-3">
        <span className={`inline-flex items-center gap-1.5 font-medium ${meta.text}`}>
          <span
            className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${meta.dot}`}
            aria-hidden
          />
          {meta.label}
        </span>
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap gap-1 text-2xs">
          {row.is_pilot && (
            <span className="rounded-full bg-warning-100 px-1.5 py-0.5 font-medium text-warning-700">
              파일럿
            </span>
          )}
          {row.condition_assignment && (
            <span className="rounded-full bg-neutral-100 px-1.5 py-0.5 font-medium text-neutral-700">
              {row.condition_assignment}
            </span>
          )}
          {typeof row.attention_fail_count === "number" &&
            row.attention_fail_count > 0 && (
              <span
                className="rounded-full bg-danger-100 px-1.5 py-0.5 font-medium text-danger-700"
                title="집중도 확인 문항에서 틀린 누적 횟수"
              >
                집중 실패 {row.attention_fail_count}회
              </span>
            )}
        </div>
      </td>
    </tr>
  );
}
