"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

type Status = "pending" | "approved" | "rejected";

interface RequestRow {
  id: string;
  participant_id: string;
  reason: string;
  phone_last4: string | null;
  status: Status;
  created_at: string;
  approved_at: string | null;
  rejected_reason: string | null;
  participant: { id: string; name: string | null; email: string | null } | null;
  requester: {
    id: string;
    display_name: string | null;
    contact_email: string | null;
  } | null;
}

const TABS: Array<{ value: Status | "all"; label: string }> = [
  { value: "pending", label: "대기" },
  { value: "approved", label: "승인됨" },
  { value: "rejected", label: "반려됨" },
  { value: "all", label: "전체" },
];

export function BlacklistRequestsList() {
  const { toast } = useToast();
  const [status, setStatus] = useState<Status | "all">("pending");
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [rejectFor, setRejectFor] = useState<string | null>(null);
  const [rejectText, setRejectText] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const q = status === "all" ? "all" : status;
      const res = await fetch(
        `/api/participants/blacklist-requests?status=${q}`,
      );
      if (!res.ok) {
        toast("목록을 불러오지 못했습니다", "error");
        return;
      }
      const body = (await res.json()) as { requests: RequestRow[] };
      setRows(body.requests ?? []);
    } catch {
      toast("네트워크 오류가 발생했습니다", "error");
    } finally {
      setLoading(false);
    }
  }, [status, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {
      pending: 0,
      approved: 0,
      rejected: 0,
    };
    for (const r of rows) c[r.status] = (c[r.status] ?? 0) + 1;
    return c;
  }, [rows]);

  const act = useCallback(
    async (id: string, action: "approve" | "reject", rejectedReason?: string) => {
      setBusy((b) => ({ ...b, [id]: true }));
      try {
        const res = await fetch(
          `/api/participants/blacklist-requests/${id}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action, rejectedReason }),
          },
        );
        const body = await res.json();
        if (!res.ok) {
          toast(body?.error ?? "처리 실패", "error");
          return;
        }
        toast(
          action === "approve"
            ? `승인 완료 (cascade-cancel ${body.cascade_cancelled_bookings ?? 0}건)`
            : "반려 완료",
          "success",
        );
        if (action === "reject") {
          setRejectFor(null);
          setRejectText("");
        }
        void load();
      } catch {
        toast("네트워크 오류가 발생했습니다", "error");
      } finally {
        setBusy((b) => ({ ...b, [id]: false }));
      }
    },
    [load, toast],
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardContent>
          <div className="flex flex-wrap items-center gap-2">
            {TABS.map((t) => (
              <button
                key={t.value}
                type="button"
                onClick={() => setStatus(t.value)}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                  status === t.value
                    ? "border-foreground bg-foreground text-white"
                    : "border-border text-muted hover:bg-card"
                }`}
              >
                {t.label}
                {t.value !== "all" && (
                  <span className="ml-1 text-2xs opacity-80">
                    ({counts[t.value] ?? 0})
                  </span>
                )}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted">
            불러오는 중…
          </CardContent>
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted">
            요청이 없습니다.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-card text-left">
                    <th className="px-4 py-3 font-medium text-muted">상태</th>
                    <th className="px-4 py-3 font-medium text-muted">참여자</th>
                    <th className="px-4 py-3 font-medium text-muted">이메일</th>
                    <th className="px-4 py-3 font-medium text-muted">끝4</th>
                    <th className="px-4 py-3 font-medium text-muted">사유</th>
                    <th className="px-4 py-3 font-medium text-muted">신청자</th>
                    <th className="px-4 py-3 font-medium text-muted">신청일</th>
                    <th className="px-4 py-3 font-medium text-muted"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b border-border last:border-b-0">
                      <td className="px-4 py-3">
                        <span
                          className={
                            r.status === "pending"
                              ? "rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800"
                              : r.status === "approved"
                                ? "rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800"
                                : "rounded-full bg-danger-100 px-2 py-0.5 text-xs font-medium text-danger-800"
                          }
                        >
                          {r.status === "pending"
                            ? "대기"
                            : r.status === "approved"
                              ? "승인됨"
                              : "반려됨"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-foreground">
                        {r.participant?.name ?? "-"}
                      </td>
                      <td className="px-4 py-3 text-muted">
                        {r.participant?.email ?? "-"}
                      </td>
                      <td className="px-4 py-3 font-mono tabular-nums text-muted">
                        {r.phone_last4 ?? "-"}
                      </td>
                      <td className="px-4 py-3 text-foreground" title={r.reason}>
                        <span className="line-clamp-2 max-w-md">{r.reason}</span>
                        {r.rejected_reason && (
                          <span className="mt-1 block text-xs text-danger-700">
                            반려 사유: {r.rejected_reason}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-muted">
                        {r.requester?.display_name ??
                          r.requester?.contact_email ??
                          "-"}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted">
                        {new Date(r.created_at).toLocaleString("ko-KR")}
                      </td>
                      <td className="px-4 py-3">
                        {r.status === "pending" && (
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              disabled={!!busy[r.id]}
                              onClick={() => void act(r.id, "approve")}
                            >
                              승인
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={!!busy[r.id]}
                              onClick={() => {
                                setRejectFor(r.id);
                                setRejectText("");
                              }}
                            >
                              반려
                            </Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Reject dialog (lightweight inline) */}
      {rejectFor && (
        <Card>
          <CardContent className="space-y-2 py-3">
            <p className="text-sm font-medium text-foreground">
              반려 사유 (선택)
            </p>
            <textarea
              value={rejectText}
              onChange={(e) => setRejectText(e.target.value)}
              rows={2}
              placeholder="신청자가 볼 수 있는 짧은 메모 (선택)"
              className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setRejectFor(null);
                  setRejectText("");
                }}
              >
                취소
              </Button>
              <Button
                size="sm"
                disabled={!!busy[rejectFor]}
                onClick={() =>
                  void act(rejectFor, "reject", rejectText.trim() || undefined)
                }
              >
                반려 확정
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
