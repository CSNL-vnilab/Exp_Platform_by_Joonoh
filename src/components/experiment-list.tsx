"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { format } from "date-fns";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export interface ExperimentListRow {
  id: string;
  title: string;
  project_name: string | null;
  status: string;
  session_duration_minutes: number;
  session_type: "single" | "multi";
  required_sessions: number;
  participation_fee: number;
  start_date: string;
  end_date: string;
  created_at: string;
  notion_project_page_id?: string | null;
  description?: string | null;
  protocol_version?: string | null;
}

interface BookingBreakdown {
  confirmed: number;
  completed: number;
  cancelled: number;
  total: number;
}

const statusConfig: Record<
  string,
  { label: string; variant: "default" | "success" | "info" | "danger" }
> = {
  draft: { label: "초안", variant: "default" },
  active: { label: "진행 중", variant: "success" },
  completed: { label: "완료", variant: "info" },
  cancelled: { label: "취소", variant: "danger" },
};

type StatusFilter = "all" | "active" | "draft" | "completed" | "cancelled";
type Sort = "recent" | "oldest" | "title" | "starts";

interface Props {
  items: ExperimentListRow[];
  bookingCounts: Record<string, BookingBreakdown | number>;
}

function asBreakdown(v: BookingBreakdown | number | undefined): BookingBreakdown {
  if (typeof v === "number") return { confirmed: v, completed: 0, cancelled: 0, total: v };
  return v ?? { confirmed: 0, completed: 0, cancelled: 0, total: 0 };
}

export function ExperimentList({ items, bookingCounts }: Props) {
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [sort, setSort] = useState<Sort>("recent");
  const [query, setQuery] = useState("");

  const counts = useMemo(() => {
    const c = { all: items.length, active: 0, draft: 0, completed: 0, cancelled: 0 };
    for (const it of items) {
      if (it.status in c) c[it.status as keyof typeof c]++;
    }
    return c;
  }, [items]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = items.filter((it) => {
      if (filter !== "all" && it.status !== filter) return false;
      if (!q) return true;
      return (
        it.title.toLowerCase().includes(q) ||
        (it.project_name ?? "").toLowerCase().includes(q)
      );
    });
    list = [...list].sort((a, b) => {
      switch (sort) {
        case "oldest":
          return a.created_at.localeCompare(b.created_at);
        case "title":
          return a.title.localeCompare(b.title, "ko");
        case "starts":
          return a.start_date.localeCompare(b.start_date);
        case "recent":
        default:
          return b.created_at.localeCompare(a.created_at);
      }
    });
    return list;
  }, [items, filter, sort, query]);

  const tabs: Array<[StatusFilter, string, number]> = [
    ["all", "전체", counts.all],
    ["active", "진행 중", counts.active],
    ["draft", "초안", counts.draft],
    ["completed", "완료", counts.completed],
    ["cancelled", "취소", counts.cancelled],
  ];

  return (
    <div className="space-y-4">
      <Card>
        <CardContent>
          <div className="flex flex-wrap items-center gap-2">
            {tabs.map(([k, label, n]) => (
              <button
                key={k}
                type="button"
                onClick={() => setFilter(k)}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                  filter === k
                    ? "border-foreground bg-foreground text-white"
                    : "border-border text-muted hover:bg-card"
                }`}
              >
                {label} ({n})
              </button>
            ))}
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="제목·프로젝트 검색"
                className="w-56 rounded-lg border border-border bg-white px-3 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as Sort)}
                className="rounded-lg border border-border bg-white px-3 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
              >
                <option value="recent">최신 등록순</option>
                <option value="oldest">오래된 순</option>
                <option value="title">이름순</option>
                <option value="starts">시작일 순</option>
              </select>
            </div>
          </div>
        </CardContent>
      </Card>

      {visible.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted">
            조건에 맞는 실험이 없습니다.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((experiment) => {
            const status = statusConfig[experiment.status] ?? statusConfig.draft;
            const c = asBreakdown(bookingCounts[experiment.id]);
            const isBackfill = experiment.description?.startsWith("[백필]");
            return (
              <Link
                key={experiment.id}
                href={`/experiments/${experiment.id}`}
                className="block"
              >
                <Card className="h-full transition-shadow hover:shadow-md">
                  <CardContent>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <h3 className="truncate font-semibold text-foreground">
                          {experiment.title}
                        </h3>
                        {experiment.project_name && (
                          <p className="mt-0.5 text-xs text-muted">
                            {experiment.project_name}
                            {experiment.notion_project_page_id && (
                              <span
                                title="Notion Projects & Chores 페이지 연결됨"
                                className="ml-1 text-emerald-700"
                              >
                                · Notion 연동
                              </span>
                            )}
                          </p>
                        )}
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        <Badge variant={status.variant}>{status.label}</Badge>
                        {isBackfill && (
                          <span
                            title="캘린더에서 일괄 import된 과거 실험. 일부 메타데이터(protocol_version 등) 보완이 필요할 수 있습니다."
                            className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-800"
                          >
                            백필
                          </span>
                        )}
                        {experiment.protocol_version && (
                          <span
                            title={`protocol_version: ${experiment.protocol_version}`}
                            className="rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[10px] font-medium text-sky-800"
                          >
                            {experiment.protocol_version}
                          </span>
                        )}
                      </div>
                    </div>
                    <p className="mt-3 text-sm text-muted">
                      {format(new Date(experiment.start_date), "yyyy.MM.dd")} ~{" "}
                      {format(new Date(experiment.end_date), "yyyy.MM.dd")}
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
                      <span>
                        {experiment.session_duration_minutes}분/세션
                        {experiment.session_type === "multi" &&
                          ` · ${experiment.required_sessions}회차`}
                      </span>
                      <span title={`확정 ${c.confirmed} · 완료 ${c.completed} · 취소 ${c.cancelled}`}>
                        예약 {c.total}건
                        {c.completed > 0 && (
                          <span className="ml-1 text-sky-700">(완료 {c.completed})</span>
                        )}
                        {c.cancelled > 0 && (
                          <span className="ml-1 text-rose-600">(취소 {c.cancelled})</span>
                        )}
                      </span>
                    </div>
                    {experiment.participation_fee > 0 && (
                      <p className="mt-2 text-sm font-medium text-emerald-700">
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
