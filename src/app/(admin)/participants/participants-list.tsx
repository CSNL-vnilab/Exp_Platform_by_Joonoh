"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ClassBadge } from "@/components/class-badge";
import { PromoEmailModal } from "@/components/promo-email-modal";
import { BlacklistRequestModal } from "@/components/blacklist-request-modal";
import { formatDateKR } from "@/lib/utils/date";
import type { ParticipantClass } from "@/types/database";

interface ParticipantListRow {
  id: string;
  // PII open to every authenticated lab member (2026-05-19 directive).
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  public_code: string | null;
  lab_code: string;
  // Server returns the full participant_classes snapshot, not just the
  // enum — the row carries the reason etc. so the UI can surface it
  // for blacklisted entries.
  class: {
    class: ParticipantClass;
    reason: string | null;
    assigned_kind: string | null;
    valid_from: string;
    valid_until: string | null;
    completed_count: number;
  } | null;
  completed_count: number;
  last_booking_at: string | null;
  last_participated_at: string | null;
  experiment_names: string[];
}

const PAGE_SIZE = 20;

type ModeTab = "offline" | "online" | "all";

const MODE_TABS: Array<{ value: ModeTab; label: string; hint: string }> = [
  { value: "offline", label: "오프라인", hint: "오프라인·하이브리드 모집 참여자" },
  { value: "online", label: "온라인", hint: "온라인 실험 참여자" },
  { value: "all", label: "전체", hint: "모드 구분 없음" },
];

const CLASS_FILTERS: Array<{ value: "" | ParticipantClass; label: string }> = [
  { value: "", label: "전체 클래스" },
  { value: "newbie", label: "뉴비" },
  { value: "royal", label: "로열" },
  { value: "blacklist", label: "블랙리스트" },
  { value: "vip", label: "VIP" },
];

function ExperimentCell({ names }: { names: string[] }) {
  if (!names || names.length === 0) return <span className="text-muted">-</span>;
  const head = names[0];
  const rest = names.length - 1;
  return (
    <span className="text-foreground" title={names.join(", ")}>
      {head}
      {rest > 0 && (
        <span className="ml-1 text-xs text-muted">+{rest}</span>
      )}
    </span>
  );
}

export function ParticipantsList() {
  const router = useRouter();

  const [rows, setRows] = useState<ParticipantListRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Checkbox selection for the recruitment ("홍보") blast. Keyed by
  // participant id so it survives pagination — select-all only toggles
  // the rows visible on the current page.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [promoOpen, setPromoOpen] = useState(false);
  const [blacklistOpen, setBlacklistOpen] = useState(false);

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [classFilter, setClassFilter] = useState<"" | ParticipantClass>("");
  // 2026-05-20 user directive ("온라인/오프라인 DB 분기 = 같은 DB,
  // 모드별 뷰 분리"): default to offline so the canonical recruited
  // pool isn't polluted by online experiments (TimeExpOnline1 + E2E).
  const [mode, setMode] = useState<ModeTab>("offline");
  const [page, setPage] = useState(0); // 0-indexed

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Debounce search to avoid a fetch on every keystroke.
  useEffect(() => {
    const h = setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(0);
    }, 250);
    return () => clearTimeout(h);
  }, [search]);

  useEffect(() => {
    setPage(0);
    setSelectedIds(new Set());
  }, [classFilter, mode]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams();
      if (classFilter) q.set("class", classFilter);
      if (debouncedSearch) q.set("search", debouncedSearch);
      if (mode !== "all") q.set("mode", mode);
      q.set("limit", String(PAGE_SIZE));
      q.set("offset", String(page * PAGE_SIZE));
      const res = await fetch(`/api/participants?${q.toString()}`);
      if (!res.ok) {
        setError("목록을 불러오지 못했습니다.");
        return;
      }
      const body = (await res.json()) as {
        participants: ParticipantListRow[];
        total: number;
      };
      setRows(body.participants ?? []);
      setTotal(body.total ?? 0);
    } catch {
      setError("네트워크 오류가 발생했습니다.");
    } finally {
      setLoading(false);
    }
  }, [classFilter, debouncedSearch, mode, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const rangeLabel = useMemo(() => {
    if (total === 0) return "0건";
    const from = page * PAGE_SIZE + 1;
    const to = Math.min((page + 1) * PAGE_SIZE, total);
    return `${from}–${to} / 총 ${total}건`;
  }, [page, total]);

  function go(id: string) {
    router.push(`/participants/${id}`);
  }

  function toggleOne(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const pageIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const allPageSelected =
    pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));

  function togglePage() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allPageSelected) {
        for (const id of pageIds) next.delete(id);
      } else {
        for (const id of pageIds) next.add(id);
      }
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-1">
            {MODE_TABS.map((t) => (
              <button
                key={t.value}
                type="button"
                onClick={() => setMode(t.value)}
                title={t.hint}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                  mode === t.value
                    ? "border-foreground bg-foreground text-white"
                    : "border-border text-muted hover:bg-card"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="이름·전화·이메일·공개 ID 검색"
              className="w-64 rounded-lg border border-border bg-white px-3 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
            <select
              value={classFilter}
              onChange={(e) =>
                setClassFilter(e.target.value as "" | ParticipantClass)
              }
              className="rounded-lg border border-border bg-white px-3 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            >
              {CLASS_FILTERS.map((f) => (
                <option key={f.value || "all"} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
            <div className="ml-auto text-xs text-muted">{rangeLabel}</div>
          </div>
        </CardContent>
      </Card>

      {selectedIds.size > 0 && (
        <Card>
          <CardContent className="flex flex-wrap items-center gap-3 py-3">
            <span className="text-sm font-medium text-foreground">
              {selectedIds.size}명 선택됨
            </span>
            <button
              type="button"
              onClick={() => setSelectedIds(new Set())}
              className="text-xs text-muted underline-offset-2 hover:underline"
            >
              선택 해제
            </button>
            <div className="ml-auto flex items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setBlacklistOpen(true)}
              >
                블랙리스트 등록 신청
              </Button>
              <Button size="sm" onClick={() => setPromoOpen(true)}>
                홍보 메일 보내기
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {error && (
        <Card>
          <CardContent className="py-6 text-center text-sm text-danger">
            {error}
          </CardContent>
        </Card>
      )}

      {loading ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted">
            불러오는 중…
          </CardContent>
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted">
            조건에 맞는 참여자가 없습니다.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-card text-left">
                    <th className="w-10 px-4 py-3">
                      <input
                        type="checkbox"
                        aria-label="이 페이지 전체 선택"
                        checked={allPageSelected}
                        onChange={togglePage}
                        className="h-4 w-4 cursor-pointer accent-primary"
                      />
                    </th>
                    <th className="px-4 py-3 font-medium text-muted">공개 ID</th>
                    <th className="px-4 py-3 font-medium text-muted">이름</th>
                    <th className="px-4 py-3 font-medium text-muted">이메일</th>
                    <th className="px-4 py-3 font-medium text-muted">연락처</th>
                    <th className="px-4 py-3 font-medium text-muted">참여 실험</th>
                    <th className="px-4 py-3 font-medium text-muted">클래스</th>
                    <th className="px-4 py-3 font-medium text-muted">완료 세션</th>
                    <th className="px-4 py-3 font-medium text-muted">최근 참여일</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr
                      key={r.id}
                      onClick={() => go(r.id)}
                      className="cursor-pointer border-b border-border last:border-b-0 hover:bg-card/50"
                    >
                      <td
                        className="px-4 py-3"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          aria-label={`${r.name ?? r.public_code ?? "참여자"} 선택`}
                          checked={selectedIds.has(r.id)}
                          onChange={() => toggleOne(r.id)}
                          className="h-4 w-4 cursor-pointer accent-primary"
                        />
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-foreground">
                        {r.public_code ?? "-"}
                      </td>
                      <td className="px-4 py-3 text-foreground">
                        {r.name ?? "-"}
                      </td>
                      <td className="px-4 py-3 text-muted">
                        {r.email ?? "-"}
                      </td>
                      <td className="px-4 py-3 tabular-nums text-muted">
                        {r.phone ?? "-"}
                      </td>
                      <td className="px-4 py-3">
                        <ExperimentCell names={r.experiment_names ?? []} />
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-col gap-1">
                          <ClassBadge value={r.class?.class ?? null} />
                          {r.class?.class === "blacklist" && r.class.reason && (
                            <span
                              className="text-xs text-danger-700"
                              title={r.class.reason}
                            >
                              {r.class.reason}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 tabular-nums text-foreground">
                        {r.completed_count}
                      </td>
                      <td className="px-4 py-3 text-muted">
                        {r.last_participated_at
                          ? formatDateKR(r.last_participated_at)
                          : r.last_booking_at
                            ? formatDateKR(r.last_booking_at)
                            : "-"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Pagination */}
      {total > PAGE_SIZE && (
        <div className="flex items-center justify-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            이전
          </Button>
          <span className="text-xs text-muted">
            {page + 1} / {totalPages}
          </span>
          <Button
            size="sm"
            variant="secondary"
            disabled={page >= totalPages - 1}
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
          >
            다음
          </Button>
        </div>
      )}

      <PromoEmailModal
        open={promoOpen}
        onClose={() => setPromoOpen(false)}
        participantIds={[...selectedIds]}
        experimentMode={mode === "all" ? null : mode}
        onSent={() => {
          setSelectedIds(new Set());
          void load();
        }}
      />

      <BlacklistRequestModal
        open={blacklistOpen}
        onClose={() => setBlacklistOpen(false)}
        participantIds={[...selectedIds]}
        onSubmitted={() => {
          setSelectedIds(new Set());
          void load();
        }}
      />
    </div>
  );
}
