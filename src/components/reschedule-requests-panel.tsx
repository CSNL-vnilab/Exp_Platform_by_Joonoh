"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

export interface RescheduleRequest {
  id: string;
  participantName: string;
  sessionNumber: number | null;
  currentSlotStart: string | null;
  currentSlotEnd: string | null;
  requestedSlotStart: string;
  requestedSlotEnd: string;
  reason: string | null;
  requestedAt: string;
}

interface Props {
  experimentId: string;
  requests: RescheduleRequest[];
}

// KST formatter for a full slot label "07/21 14:00 ~ 15:00", collapsing the
// end to time-only when it shares the request's day.
function fmtSlot(startIso: string | null, endIso: string | null): string {
  if (!startIso) return "-";
  const start = new Date(startIso);
  const dateTime = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(start);
  if (!endIso) return dateTime;
  const end = new Date(endIso);
  const endTime = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(end);
  return `${dateTime} ~ ${endTime}`;
}

// Pending reschedule-requests approval queue. Renders nothing when empty so
// the page doesn't show a bare card. Each row: participant / 회차 / 기존 →
// 요청 슬롯 / 사유 + [승인] [반려]. Approve/Reject POST to the requests
// route; on success router.refresh() so the queue and the bookings table
// re-render. 409 (already-processed or slot-taken) surfaces the returned
// error and refreshes.
export function RescheduleRequestsPanel({ experimentId, requests }: Props) {
  const { toast } = useToast();
  const router = useRouter();
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [rejectFor, setRejectFor] = useState<string | null>(null);
  const [rejectText, setRejectText] = useState("");

  if (requests.length === 0) return null;

  async function act(
    id: string,
    action: "approve" | "reject",
    rejectedReason?: string,
  ) {
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      const res = await fetch(
        `/api/experiments/${experimentId}/reschedule-requests/${id}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, rejectedReason }),
        },
      );
      const body = (await res.json().catch(() => null)) as
        | { ok: true; action: string }
        | { error: string }
        | null;
      if (!res.ok || !body || "error" in body) {
        const msg =
          (body as { error?: string } | null)?.error ??
          `처리 실패 (HTTP ${res.status})`;
        toast(msg, "error");
        // 409 = already processed / slot taken — refresh so the stale row
        // drops out of the queue and the bookings table reflects reality.
        if (res.status === 409) router.refresh();
        return;
      }
      toast(action === "approve" ? "승인했습니다." : "반려했습니다.", "success");
      if (action === "reject") {
        setRejectFor(null);
        setRejectText("");
      }
      router.refresh();
    } catch {
      toast("네트워크 오류가 발생했습니다.", "error");
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  }

  return (
    <Card>
      <CardContent className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-foreground">
            일정 변경 요청 (승인 대기)
          </h2>
          <p className="mt-0.5 text-sm text-muted">
            참여자가 제출한 회차별 재조정 요청입니다. 승인하면 새 일정으로
            반영되고, 캘린더·리마인더·확정 메일이 갱신됩니다.
          </p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-card text-left">
                <th className="py-2.5 pr-3 font-medium text-muted">참여자</th>
                <th className="py-2.5 pr-3 font-medium text-muted">회차</th>
                <th className="py-2.5 pr-3 font-medium text-muted">기존 일정</th>
                <th className="py-2.5 pr-3 font-medium text-muted">요청 일정</th>
                <th className="py-2.5 pr-3 font-medium text-muted">사유</th>
                <th className="py-2.5 pr-3 font-medium text-muted">요청일</th>
                <th className="py-2.5 font-medium text-muted" />
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr
                  key={r.id}
                  className="border-b border-border/50 align-top last:border-b-0 hover:bg-neutral-100"
                >
                  <td className="py-2.5 pr-3 font-medium text-foreground">
                    {r.participantName}
                  </td>
                  <td className="py-2.5 pr-3 tabular-nums text-muted">
                    {r.sessionNumber != null ? `${r.sessionNumber}회차` : "-"}
                  </td>
                  <td className="py-2.5 pr-3 tabular-nums text-muted">
                    {fmtSlot(r.currentSlotStart, r.currentSlotEnd)}
                  </td>
                  <td className="py-2.5 pr-3 tabular-nums font-medium text-foreground">
                    {fmtSlot(r.requestedSlotStart, r.requestedSlotEnd)}
                  </td>
                  <td className="py-2.5 pr-3 text-muted">
                    {r.reason ? (
                      <span className="line-clamp-2 max-w-xs" title={r.reason}>
                        {r.reason}
                      </span>
                    ) : (
                      "-"
                    )}
                  </td>
                  <td className="py-2.5 pr-3 text-xs text-muted">
                    {new Date(r.requestedAt).toLocaleString("ko-KR")}
                  </td>
                  <td className="py-2.5">
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="primary"
                        disabled={!!busy[r.id]}
                        loading={!!busy[r.id]}
                        onClick={() => void act(r.id, "approve")}
                      >
                        승인
                      </Button>
                      <Button
                        type="button"
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
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {rejectFor && (
          <div className="rounded-lg border border-border bg-muted/10 p-3">
            <p className="text-sm font-medium text-foreground">
              반려 사유 (선택)
            </p>
            <textarea
              value={rejectText}
              onChange={(e) => setRejectText(e.target.value)}
              rows={2}
              placeholder="참여자에게 전달될 짧은 메모 (선택)"
              className="mt-2 w-full rounded-lg border border-border bg-white px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
            <div className="mt-2 flex justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={!!busy[rejectFor]}
                onClick={() => {
                  setRejectFor(null);
                  setRejectText("");
                }}
              >
                취소
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!!busy[rejectFor]}
                loading={!!busy[rejectFor]}
                onClick={() =>
                  void act(rejectFor, "reject", rejectText.trim() || undefined)
                }
              >
                반려 확정
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
