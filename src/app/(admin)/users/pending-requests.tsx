"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";

export interface PendingRequest {
  id: string;
  username: string;
  display_name: string;
  requested_at: string;
}

export function PendingRequestsPanel({ requests }: { requests: PendingRequest[] }) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);

  async function act(id: string, action: "approve" | "reject") {
    setBusyId(id);
    const res = await fetch(`/api/registration-requests/${id}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: action === "reject" ? JSON.stringify({}) : undefined,
    });
    setBusyId(null);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      toast(j.error ?? "처리에 실패했습니다", "error");
      return;
    }
    toast(
      action === "approve" ? "연구원 계정이 생성되었습니다" : "요청을 거절했습니다",
      "success",
    );
    startTransition(() => router.refresh());
  }

  if (requests.length === 0) return null;

  return (
    <div className="mb-6">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-lg font-semibold text-foreground">승인 대기 요청</h2>
        <Badge variant="warning">{requests.length}건</Badge>
      </div>
      <Card>
        <div className="divide-y divide-border">
          {requests.map((r) => {
            const busy = busyId === r.id || pending;
            return (
              <div
                key={r.id}
                className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <div className="text-sm font-medium text-foreground">
                    {r.display_name}{" "}
                    <span className="font-mono text-muted">({r.username})</span>
                  </div>
                  <div className="text-xs text-muted">
                    {new Date(r.requested_at).toLocaleString("ko-KR")} 요청
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => act(r.id, "reject")}
                  >
                    거절
                  </Button>
                  <Button disabled={busy} onClick={() => act(r.id, "approve")}>
                    {busy ? "처리 중..." : "승인"}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
