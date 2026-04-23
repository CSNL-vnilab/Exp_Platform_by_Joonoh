"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ClassBadge } from "@/components/class-badge";
import { formatDateKR } from "@/lib/utils/date";
import type { ParticipantClass, UserRole } from "@/types/database";

interface ParticipantListRow {
  id: string;
  // PII fields only populated when caller is admin. Non-admin researchers
  // get the pseudonymous view only.
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  public_code: string | null;
  lab_code: string;
  class: ParticipantClass | null;
  completed_count: number;
  last_booking_at: string | null;
}

interface Props {
  role: UserRole;
}

const PAGE_SIZE = 20;

const CLASS_FILTERS: Array<{ value: "" | ParticipantClass; label: string }> = [
  { value: "", label: "전체 클래스" },
  { value: "newbie", label: "뉴비" },
  { value: "royal", label: "로열" },
  { value: "blacklist", label: "블랙리스트" },
  { value: "vip", label: "VIP" },
];

export function ParticipantsList({ role }: Props) {
  const router = useRouter();
  const isAdmin = role === "admin";

  const [rows, setRows] = useState<ParticipantListRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [classFilter, setClassFilter] = useState<"" | ParticipantClass>("");
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
  }, [classFilter]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams();
      if (classFilter) q.set("class", classFilter);
      if (debouncedSearch) q.set("search", debouncedSearch);
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
  }, [classFilter, debouncedSearch, page]);

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

  return (
    <div className="space-y-4">
      <Card>
        <CardContent>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={
                isAdmin
                  ? "이름·전화·이메일·공개 ID 검색"
                  : "공개 ID 검색"
              }
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
                    <th className="px-4 py-3 font-medium text-muted">공개 ID</th>
                    {isAdmin && (
                      <th className="px-4 py-3 font-medium text-muted">이름</th>
                    )}
                    <th className="px-4 py-3 font-medium text-muted">클래스</th>
                    <th className="px-4 py-3 font-medium text-muted">완료 세션</th>
                    <th className="px-4 py-3 font-medium text-muted">최근 예약일</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr
                      key={r.id}
                      onClick={() => go(r.id)}
                      className="cursor-pointer border-b border-border last:border-b-0 hover:bg-card/50"
                    >
                      <td className="px-4 py-3 font-mono text-xs text-foreground">
                        {r.public_code ?? "-"}
                      </td>
                      {isAdmin && (
                        <td className="px-4 py-3 text-foreground">
                          {r.name ?? "-"}
                        </td>
                      )}
                      <td className="px-4 py-3">
                        <ClassBadge value={r.class} />
                      </td>
                      <td className="px-4 py-3 tabular-nums text-foreground">
                        {r.completed_count}
                      </td>
                      <td className="px-4 py-3 text-muted">
                        {r.last_booking_at ? formatDateKR(r.last_booking_at) : "-"}
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
    </div>
  );
}
