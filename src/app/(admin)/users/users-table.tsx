"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { fromInternalEmail } from "@/lib/auth/username";
import type { Profile, UserRole } from "@/types/database";

interface Props {
  profiles: Profile[];
  currentUserId: string;
}

export function UsersTable({ profiles, currentUserId }: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);

  async function patch(id: string, body: { role?: UserRole; disabled?: boolean }) {
    setBusyId(id);
    const res = await fetch(`/api/users/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusyId(null);
    if (!res.ok) {
      const j = await res.json().catch(() => ({ error: "업데이트 실패" }));
      toast(j.error ?? "업데이트에 실패했습니다", "error");
      return;
    }
    toast("변경사항이 저장되었습니다", "success");
    startTransition(() => router.refresh());
  }

  if (profiles.length === 0) {
    return (
      <Card>
        <p className="text-sm text-muted">등록된 사용자가 없습니다.</p>
      </Card>
    );
  }

  return (
    <Card>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="border-b border-border text-left text-xs uppercase text-muted">
            <tr>
              <th className="px-3 py-2">이름</th>
              <th className="px-3 py-2">ID</th>
              <th className="px-3 py-2">역할</th>
              <th className="px-3 py-2">상태</th>
              <th className="px-3 py-2">가입일</th>
              <th className="px-3 py-2 text-right">작업</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {profiles.map((p) => {
              const isSelf = p.id === currentUserId;
              const busy = busyId === p.id || pending;
              return (
                <tr key={p.id}>
                  <td className="px-3 py-3 font-medium text-foreground">
                    {p.display_name ?? "-"}
                    {isSelf && <span className="ml-2 text-xs text-muted">(나)</span>}
                  </td>
                  <td className="px-3 py-3 font-mono text-muted">
                    {fromInternalEmail(p.email) ?? p.email}
                  </td>
                  <td className="px-3 py-3">
                    <Badge variant={p.role === "admin" ? "info" : "default"}>
                      {p.role === "admin" ? "관리자" : "연구원"}
                    </Badge>
                  </td>
                  <td className="px-3 py-3">
                    {p.disabled ? (
                      <Badge variant="danger">비활성</Badge>
                    ) : (
                      <Badge variant="success">활성</Badge>
                    )}
                  </td>
                  <td className="px-3 py-3 text-muted">
                    {new Date(p.created_at).toLocaleDateString("ko-KR")}
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex justify-end gap-2">
                      {p.role === "researcher" ? (
                        <Button
                          variant="secondary"
                          disabled={busy || isSelf}
                          onClick={() => patch(p.id, { role: "admin" })}
                        >
                          관리자 승격
                        </Button>
                      ) : (
                        <Button
                          variant="secondary"
                          disabled={busy || isSelf}
                          onClick={() => patch(p.id, { role: "researcher" })}
                        >
                          연구원 강등
                        </Button>
                      )}
                      <Button
                        variant={p.disabled ? "secondary" : "danger"}
                        disabled={busy || isSelf}
                        onClick={() => patch(p.id, { disabled: !p.disabled })}
                      >
                        {p.disabled ? "활성화" : "비활성화"}
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
