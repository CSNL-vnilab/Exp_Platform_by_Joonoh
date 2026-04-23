"use client";

import { useState, useTransition } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import type { PaymentStatus } from "@/types/database";

// Status machine after the user-level "지급 완료" tracking was removed:
//   pending_participant → submitted_to_admin → claimed (terminal)
//
// The 'paid' enum value stays in the schema for future use but no UI path
// flips rows there — 청구 is the researcher's final action, and the
// actual disbursement happens via 행정 선생님's email flow outside this app.

interface PaymentRow {
  id: string;
  bookingGroupId: string;
  participantName: string;
  bankName: string | null;
  status: PaymentStatus;
  amountKrw: number;
  amountOverridden: boolean;
  submittedAt: string | null;
  claimedAt: string | null;
  periodStart: string | null;
  periodEnd: string | null;
}

interface Props {
  experimentId: string;
  rows: PaymentRow[];
  exportHistory: Array<{
    id: string;
    exported_at: string;
    export_kind: "individual_form" | "upload_form" | "both" | "claim_bundle";
    participant_count: number;
    exported_by_name: string | null;
    file_name: string | null;
  }>;
}

const STATUS_LABEL: Record<PaymentStatus, string> = {
  pending_participant: "참가자 입력 대기",
  submitted_to_admin: "제출됨",
  claimed: "청구 완료",
  paid: "청구 완료", // no UI path sets this; treated identically to claimed
};

const STATUS_CLASS: Record<PaymentStatus, string> = {
  pending_participant: "bg-amber-50 text-amber-800 border-amber-200",
  submitted_to_admin: "bg-blue-50 text-blue-800 border-blue-200",
  claimed: "bg-emerald-50 text-emerald-800 border-emerald-200",
  paid: "bg-emerald-50 text-emerald-800 border-emerald-200",
};

export function PaymentPanel({ experimentId, rows, exportHistory }: Props) {
  const { toast } = useToast();
  const [downloading, setDownloading] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState<string>("");
  const [pendingAction, startActionTransition] = useTransition();

  const claimable = rows.filter((r) => r.status === "submitted_to_admin");
  const totalClaimable = claimable.reduce((s, r) => s + r.amountKrw, 0);

  async function downloadBlob(url: string, key: string, method: "GET" | "POST" = "GET") {
    setDownloading(key);
    try {
      const res = await fetch(url, { method });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast(body?.error ?? "다운로드에 실패했습니다.", "error");
        return false;
      }
      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const starMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i);
      const quotedMatch = disposition.match(/filename="([^"]+)"/i);
      const filename = starMatch
        ? decodeURIComponent(starMatch[1])
        : quotedMatch?.[1] ?? "download";
      const a = document.createElement("a");
      const href = URL.createObjectURL(blob);
      a.href = href;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(href);
      return true;
    } catch {
      toast("네트워크 오류가 발생했습니다.", "error");
      return false;
    } finally {
      setDownloading(null);
    }
  }

  async function handleClaim() {
    if (claimable.length === 0) return;
    if (
      !confirm(
        `미청구 ${claimable.length}명의 참여자비를 청구하시겠습니까?\n총 ${totalClaimable.toLocaleString()}원\n\n다운로드된 ZIP(엑셀 + 통장사본)을 행정 선생님께 이메일로 전달해 주세요.\n\n실행 후에는 해당 참가자의 금액·정보를 수정할 수 없습니다.`,
      )
    )
      return;
    const ok = await downloadBlob(
      `/api/experiments/${experimentId}/payment-claim`,
      "claim",
      "POST",
    );
    if (ok) {
      toast("청구 번들이 생성되었습니다. 이메일로 전달해 주세요.", "success");
      // Refresh so status chips update.
      setTimeout(() => window.location.reload(), 600);
    }
  }

  function startEdit(r: PaymentRow) {
    setEditing(r.bookingGroupId);
    setEditValue(String(r.amountKrw));
  }

  async function saveEdit(bookingGroupId: string) {
    const amount = Number(editValue.replace(/[,\s]/g, ""));
    if (!Number.isInteger(amount) || amount < 0) {
      toast("금액은 0 이상의 정수여야 합니다.", "error");
      return;
    }
    startActionTransition(async () => {
      const res = await fetch(
        `/api/experiments/${experimentId}/payment-info/${bookingGroupId}/amount`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ amountKrw: amount }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast(body?.error ?? "수정에 실패했습니다.", "error");
        return;
      }
      toast("금액이 수정되었습니다.", "success");
      setEditing(null);
      window.location.reload();
    });
  }

  return (
    <Card>
      <CardContent className="space-y-5 pt-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-foreground">
              참여자비 정산
            </h2>
            <p className="mt-0.5 text-sm text-muted">
              미청구 {claimable.length}명 · 총 {totalClaimable.toLocaleString()}원
              {rows.length > claimable.length &&
                ` · 전체 ${rows.length}명 중`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={downloading !== null || claimable.length === 0}
              onClick={handleClaim}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white shadow-sm hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {downloading === "claim"
                ? "번들 생성 중…"
                : `📦 참여자비 청구 (${claimable.length}명)`}
            </button>
            {rows.some(
              (r) => r.status === "submitted_to_admin" || r.status === "claimed" || r.status === "paid",
            ) && (
              <button
                type="button"
                disabled={downloading !== null}
                onClick={() =>
                  downloadBlob(
                    `/api/experiments/${experimentId}/payment-export/upload-form`,
                    "upload",
                  )
                }
                className="rounded-lg border border-border bg-white px-3 py-2 text-xs font-medium text-foreground hover:bg-muted/30 disabled:cursor-not-allowed disabled:opacity-50"
              >
                업로드 양식만
              </button>
            )}
          </div>
        </div>

        {rows.length === 0 ? (
          <p className="text-sm text-muted">
            참여비가 있는 확정 예약이 없습니다.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th className="py-2 pr-3 font-medium">참가자</th>
                  <th className="py-2 pr-3 font-medium">기간</th>
                  <th className="py-2 pr-3 font-medium">지급액</th>
                  <th className="py-2 pr-3 font-medium">은행</th>
                  <th className="py-2 pr-3 font-medium">상태</th>
                  <th className="py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const isEditable =
                    r.status === "pending_participant" ||
                    r.status === "submitted_to_admin";
                  const isEditing = editing === r.bookingGroupId;
                  return (
                    <tr
                      key={r.id}
                      className="border-b border-border/50 last:border-b-0"
                    >
                      <td className="py-2 pr-3 font-medium text-foreground">
                        {r.participantName}
                      </td>
                      <td className="py-2 pr-3 text-muted">
                        {r.periodStart ?? "-"}
                        {r.periodEnd && r.periodEnd !== r.periodStart
                          ? ` ~ ${r.periodEnd}`
                          : ""}
                      </td>
                      <td className="py-2 pr-3">
                        {isEditing ? (
                          <div className="flex items-center gap-1">
                            <input
                              type="text"
                              inputMode="numeric"
                              value={editValue}
                              onChange={(e) => setEditValue(e.target.value)}
                              className="w-24 rounded border border-border px-2 py-0.5 text-xs"
                              autoFocus
                            />
                            <span className="text-xs text-muted">원</span>
                            <button
                              type="button"
                              disabled={pendingAction}
                              onClick={() => saveEdit(r.bookingGroupId)}
                              className="rounded border border-primary bg-primary px-1.5 py-0.5 text-[11px] text-white disabled:opacity-50"
                            >
                              저장
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditing(null)}
                              className="text-[11px] text-muted hover:text-foreground"
                            >
                              취소
                            </button>
                          </div>
                        ) : (
                          <span
                            className={`inline-flex items-center gap-1 ${
                              isEditable
                                ? "cursor-pointer hover:underline"
                                : ""
                            }`}
                            onClick={() => isEditable && startEdit(r)}
                            title={isEditable ? "클릭하여 수정" : undefined}
                          >
                            <span className="text-foreground">
                              {r.amountKrw.toLocaleString()}원
                            </span>
                            {r.amountOverridden && (
                              <span className="text-[10px] text-amber-600">
                                (수동)
                              </span>
                            )}
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-muted">
                        {r.bankName ?? "-"}
                      </td>
                      <td className="py-2 pr-3">
                        <span
                          className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${STATUS_CLASS[r.status]}`}
                        >
                          {STATUS_LABEL[r.status]}
                        </span>
                      </td>
                      <td className="py-2">
                        {r.status !== "pending_participant" && (
                          <button
                            type="button"
                            disabled={downloading !== null}
                            onClick={() =>
                              downloadBlob(
                                `/api/experiments/${experimentId}/payment-export/individual/${r.bookingGroupId}`,
                                `ind-${r.bookingGroupId}`,
                              )
                            }
                            className="rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-muted/30 disabled:opacity-50"
                          >
                            개별
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {exportHistory.length > 0 && (
          <div className="rounded-lg border border-border bg-muted/10 p-3">
            <p className="mb-2 text-xs font-semibold text-foreground">
              최근 내보낸 기록 ({exportHistory.length})
            </p>
            <ul className="space-y-1 text-xs text-muted">
              {exportHistory.slice(0, 8).map((e) => (
                <li key={e.id}>
                  {new Date(e.exported_at).toLocaleString("ko-KR")} ·{" "}
                  {e.exported_by_name ?? "?"} ·{" "}
                  {labelForKind(e.export_kind)} · {e.participant_count}명
                  {e.file_name && (
                    <span className="text-[10px] text-muted/70">
                      {" "}
                      · {e.file_name}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function labelForKind(
  k: "individual_form" | "upload_form" | "both" | "claim_bundle",
): string {
  switch (k) {
    case "individual_form":
      return "개별 양식";
    case "upload_form":
      return "업로드 양식";
    case "both":
      return "통합 파일";
    case "claim_bundle":
      return "청구 번들";
  }
}
