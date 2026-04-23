import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDateKR, formatTimeKR } from "@/lib/utils/date";
import type { NotionDriftReport } from "@/lib/notion/schema";

// Dashboard card showing Notion integration health. Reads the latest row
// per check_type from `notion_health_current`. Deliberately silent when
// no rows exist yet (first deploy / before the cron has fired).

interface HealthRow {
  id: string;
  check_type: "schema_drift" | "retry_sweep" | "outbox_retry_sweep";
  healthy: boolean;
  schema_hash: string | null;
  report: NotionDriftReport | Record<string, unknown>;
  duration_ms: number | null;
  created_at: string;
}

export async function NotionHealthCard() {
  const admin = createAdminClient();
  const { data } = await admin.from("notion_health_current").select("*");
  const rows = (data ?? []) as unknown as HealthRow[];

  const drift = rows.find((r) => r.check_type === "schema_drift") ?? null;
  // Retry sweep tile shows whichever sweep ran most recently: the unified
  // outbox-retry cron (D6) supersedes the Notion-only one, but until the
  // cutover the older entry may still be the freshest. Pick the newer.
  const retryNotion = rows.find((r) => r.check_type === "retry_sweep") ?? null;
  const retryOutbox = rows.find((r) => r.check_type === "outbox_retry_sweep") ?? null;
  const retry =
    retryNotion && retryOutbox
      ? new Date(retryOutbox.created_at) > new Date(retryNotion.created_at)
        ? retryOutbox
        : retryNotion
      : (retryOutbox ?? retryNotion);

  // Staleness check — if the most recent row is older than 2× the
  // expected cadence (health: daily, retry: 30min), mark the tile
  // accordingly. Catches the Vercel Hobby-plan 2-cron-cap case where
  // our Vercel crons silently don't fire but we think they do.
  const STALE_DRIFT_MS = 2 * 24 * 60 * 60 * 1000; // 2 days
  const STALE_RETRY_MS = 2 * 60 * 60 * 1000; // 2 hours
  const now = Date.now();
  const driftStale = drift
    ? now - new Date(drift.created_at).getTime() > STALE_DRIFT_MS
    : false;
  const retryStale = retry
    ? now - new Date(retry.created_at).getTime() > STALE_RETRY_MS
    : false;

  return (
    <Card>
      <CardContent>
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold text-foreground">
            Notion 연동 상태
          </h2>
          <Link
            href="https://www.notion.so/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-medium text-primary hover:text-primary-hover"
          >
            Notion 열기 →
          </Link>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <DriftBlock row={drift} stale={driftStale} />
          <RetryBlock row={retry} stale={retryStale} />
        </div>

        {drift && !drift.healthy && isDriftReport(drift.report) && (
          <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            <p className="font-semibold">스키마 불일치 감지</p>
            <ul className="mt-1 list-inside list-disc text-xs">
              {drift.report.items
                .filter((i) => i.kind !== "unexpected")
                .slice(0, 6)
                .map((i, idx) => (
                  <li key={idx}>
                    <code>{i.name}</code>: {formatItem(i)}
                  </li>
                ))}
            </ul>
            <p className="mt-2 text-xs">
              <code className="rounded bg-white px-1">
                node scripts/notion-setup.mjs
              </code>
              를 실행하면 누락 컬럼이 자동 추가됩니다 (기존 데이터 보존).
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function isDriftReport(
  report: unknown,
): report is { items: NotionDriftReport["items"] } {
  return (
    typeof report === "object" &&
    report !== null &&
    "items" in report &&
    Array.isArray((report as { items: unknown }).items)
  );
}

function formatItem(i: NotionDriftReport["items"][number]): string {
  switch (i.kind) {
    case "missing":
      return `누락 (기대: ${i.expected})`;
    case "type_mismatch":
      return `타입 불일치 (기대: ${i.expected}, 실제: ${i.actual})`;
    case "select_options_changed":
      return `Select 옵션 변경 — ${i.details ?? ""}`;
    case "unexpected":
      return `추가 컬럼 (${i.actual})`;
    default:
      return i.details ?? "";
  }
}

function DriftBlock({
  row,
  stale,
}: {
  row: HealthRow | null;
  stale: boolean;
}) {
  if (!row) {
    return (
      <div className="rounded-lg border border-border bg-card p-3 text-sm">
        <div className="flex items-center gap-2">
          <Badge variant="default">미확인</Badge>
          <span className="text-muted">스키마 드리프트 검사</span>
        </div>
        <p className="mt-1 text-xs text-muted">
          아직 실행된 적 없음 · 24시간 후 첫 결과가 기록됩니다
        </p>
      </div>
    );
  }
  const report = row.report as { skipped?: boolean };
  const inactive = !!report.skipped;
  const badge = inactive
    ? { variant: "warning" as const, label: "비활성" }
    : row.healthy
      ? { variant: "success" as const, label: "정상" }
      : { variant: "danger" as const, label: "불일치" };
  return (
    <div className="rounded-lg border border-border bg-card p-3 text-sm">
      <div className="flex items-center gap-2">
        <Badge variant={badge.variant}>{badge.label}</Badge>
        <span className="text-muted">스키마 드리프트 검사</span>
        {stale && <Badge variant="warning">stale</Badge>}
      </div>
      <p className="mt-1 text-xs text-muted">
        {formatDateKR(row.created_at)} {formatTimeKR(row.created_at)}
        {row.schema_hash ? ` · hash ${row.schema_hash}` : ""}
      </p>
      {stale && (
        <p className="mt-1 text-xs text-amber-800">
          검사가 2일 이상 실행되지 않았습니다. 크론 상태를 확인하세요.
        </p>
      )}
    </div>
  );
}

function RetryBlock({
  row,
  stale,
}: {
  row: HealthRow | null;
  stale: boolean;
}) {
  if (!row) {
    return (
      <div className="rounded-lg border border-border bg-card p-3 text-sm">
        <div className="flex items-center gap-2">
          <Badge variant="default">미확인</Badge>
          <span className="text-muted">재시도 스윕</span>
        </div>
        <p className="mt-1 text-xs text-muted">
          아직 실행된 적 없음 · 30분 뒤 첫 결과가 기록됩니다
        </p>
      </div>
    );
  }
  const r = row.report as {
    attempted?: number;
    recovered?: number;
    still_failed?: number;
    skipped?: number;
  };
  return (
    <div className="rounded-lg border border-border bg-card p-3 text-sm">
      <div className="flex items-center gap-2">
        <Badge variant={row.healthy ? "success" : "warning"}>
          {row.healthy ? "정상" : `실패 ${r.still_failed ?? 0}건`}
        </Badge>
        <span className="text-muted">재시도 스윕</span>
        {stale && <Badge variant="warning">stale</Badge>}
      </div>
      <p className="mt-1 text-xs text-muted">
        {formatDateKR(row.created_at)} {formatTimeKR(row.created_at)} · 회복{" "}
        {r.recovered ?? 0} / 시도 {r.attempted ?? 0}
        {typeof r.skipped === "number" ? ` / skip ${r.skipped}` : ""}
      </p>
      {stale && (
        <p className="mt-1 text-xs text-amber-800">
          스윕이 2시간 이상 실행되지 않았습니다. 크론 상태를 확인하세요.
        </p>
      )}
    </div>
  );
}
