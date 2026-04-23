"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";

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
      if (r.verified_at) verified++;
      else if (r.completion_code) completed++;
      else if (r.blocks_submitted > 0) {
        const ms = r.last_block_at
          ? now - new Date(r.last_block_at).getTime()
          : Infinity;
        if (ms > IDLE_MS) idle++;
        else running++;
      }
    }
    return { running, idle, completed, verified, total: rows.length };
  }, [rows, now]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <StatCard label="총 세션" value={stats.total} />
        <StatCard label="진행 중" value={stats.running} tone="emerald" />
        <StatCard label="정체" value={stats.idle} tone="amber" />
        <StatCard label="코드 발급" value={stats.completed} tone="sky" />
        <StatCard label="확인 완료" value={stats.verified} tone="violet" />
      </div>

      {sorted.length === 0 ? (
        <div className="rounded-xl border border-border bg-white p-10 text-center text-sm text-muted">
          아직 시작된 세션이 없습니다.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-card text-xs text-muted">
                <th className="px-4 py-3 text-left font-medium">Sbj</th>
                <th className="px-4 py-3 text-left font-medium">참여자</th>
                <th className="px-4 py-3 text-left font-medium">예약 시간</th>
                <th className="px-4 py-3 text-left font-medium">진행</th>
                <th className="px-4 py-3 text-left font-medium">마지막 전송</th>
                <th className="px-4 py-3 text-left font-medium">상태</th>
                <th className="px-4 py-3 text-left font-medium">플래그</th>
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
}: {
  label: string;
  value: number;
  tone?: "emerald" | "amber" | "sky" | "violet";
}) {
  const color =
    tone === "emerald"
      ? "text-emerald-600"
      : tone === "amber"
        ? "text-amber-600"
        : tone === "sky"
          ? "text-sky-600"
          : tone === "violet"
            ? "text-violet-600"
            : "text-foreground";
  return (
    <div className="rounded-xl border border-border bg-white p-4">
      <div className="text-xs text-muted">{label}</div>
      <div className={`mt-0.5 text-2xl font-bold ${color}`}>{value}</div>
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
  const idle =
    !row.verified_at &&
    !row.completion_code &&
    row.blocks_submitted > 0 &&
    (lastMs === null || lastMs > IDLE_MS);
  const statusLabel = row.verified_at
    ? "확인됨"
    : row.completion_code
      ? "완료 (확인 대기)"
      : row.blocks_submitted > 0
        ? idle
          ? "정체"
          : "진행 중"
        : "시작 전";
  const statusColor = row.verified_at
    ? "text-violet-700"
    : row.completion_code
      ? "text-sky-700"
      : idle
        ? "text-amber-700"
        : row.blocks_submitted > 0
          ? "text-emerald-700"
          : "text-muted";

  return (
    <tr
      className={`border-b border-border last:border-b-0 ${
        idle ? "bg-amber-50/40" : ""
      }`}
    >
      <td className="px-4 py-3 whitespace-nowrap text-foreground">
        {row.subject_number != null ? `Sbj${row.subject_number}` : "-"}
      </td>
      <td className="px-4 py-3 font-medium text-foreground">
        {row.participant_name}
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-xs text-muted">
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
      <td className="px-4 py-3 text-foreground">
        {row.blocks_submitted}
        {blockCount !== null ? `/${blockCount}` : ""} 블록
      </td>
      <td className="px-4 py-3 text-xs text-muted tabular-nums">
        {lastMs === null
          ? "-"
          : lastMs < 60_000
            ? `${Math.round(lastMs / 1000)}s 전`
            : lastMs < 60 * 60_000
              ? `${Math.round(lastMs / 60_000)}m 전`
              : `${Math.round(lastMs / 3_600_000)}h 전`}
      </td>
      <td className={`px-4 py-3 font-medium ${statusColor}`}>{statusLabel}</td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap gap-1 text-[10px]">
          {row.is_pilot && (
            <span className="rounded-full bg-amber-100 px-1.5 py-0.5 font-medium text-amber-700">
              파일럿
            </span>
          )}
          {row.condition_assignment && (
            <span className="rounded-full bg-purple-100 px-1.5 py-0.5 font-medium text-purple-700">
              {row.condition_assignment}
            </span>
          )}
          {typeof row.attention_fail_count === "number" &&
            row.attention_fail_count > 0 && (
              <span className="rounded-full bg-red-100 px-1.5 py-0.5 font-medium text-red-700">
                ⚠ {row.attention_fail_count}
              </span>
            )}
        </div>
      </td>
    </tr>
  );
}
