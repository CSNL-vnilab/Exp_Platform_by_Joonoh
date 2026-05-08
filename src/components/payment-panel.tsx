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
  // Auto-dispatch state for the participant-facing 정산 정보 입력 link
  // (migration 00051). null = not yet sent, ISO = first successful send.
  // Failed attempts surface as a small "발송 실패" badge.
  paymentLinkSentAt: string | null;
  paymentLinkAttempts: number;
  paymentLinkLastError: string | null;
  // True if every booking in this group is status='completed', meaning a
  // resend is meaningful right now (auto-dispatch triggers off the same
  // condition). Computed server-side off the bookings list.
  allBookingsCompleted: boolean;
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
  // Most recent payment_claim with email_sent_at IS NULL. NULL ⇒ either
  // no claims yet for this experiment, or every existing claim already
  // dispatched. Drives the "📧 행정 메일 발송" button.
  recentUnsentClaim: {
    id: string;
    claimedAt: string;
    participantCount: number;
    totalKrw: number;
  } | null;
  // From process.env.LAB_ADMIN_EMAIL — pre-populates the modal recipient
  // field. Researcher can override per-send (different deans, different
  // semester admin assignments).
  defaultAdminEmail: string;
}

// Shape of GET /payment-claim/[claimId]/email response — preview only,
// no attachment binaries.
interface EmailPreview {
  preview: {
    subject: string;
    to: string;
    replyTo: string | null;
    html: string;
    text: string;
    meta: {
      researcherName: string;
      participantCount: number;
      totalKrw: number;
      periodLabel: string;
      participantNames: string[];
      attachmentNames: string[];
    };
  };
  alreadySent: {
    sentAt: string;
    sentTo: string;
    messageId: string | null;
  } | null;
}

const STATUS_LABEL: Record<PaymentStatus, string> = {
  pending_participant: "참가자 입력 대기",
  submitted_to_admin: "제출됨",
  claimed: "청구 완료",
  paid: "청구 완료", // no UI path sets this; treated identically to claimed
  paid_offline: "정산 완료 (오프라인)",
};

const STATUS_CLASS: Record<PaymentStatus, string> = {
  pending_participant: "bg-amber-50 text-amber-800 border-amber-200",
  submitted_to_admin: "bg-blue-50 text-blue-800 border-blue-200",
  claimed: "bg-emerald-50 text-emerald-800 border-emerald-200",
  paid: "bg-emerald-50 text-emerald-800 border-emerald-200",
  paid_offline: "bg-slate-100 text-slate-700 border-slate-300",
};

export function PaymentPanel({
  experimentId,
  rows,
  exportHistory,
  recentUnsentClaim,
  defaultAdminEmail,
}: Props) {
  const { toast } = useToast();
  const [downloading, setDownloading] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState<string>("");
  const [pendingAction, startActionTransition] = useTransition();
  const [resending, setResending] = useState<string | null>(null);
  const [marking, setMarking] = useState<string | null>(null);
  const [backfilling, setBackfilling] = useState(false);
  // 행정 dispatch email state. activeClaimId is set when:
  //   (a) the page was server-rendered with a recentUnsentClaim, OR
  //   (b) a fresh claim just succeeded and surfaced X-Claim-Id.
  // Cleared after a successful send (server reload follows).
  const [activeClaimId, setActiveClaimId] = useState<string | null>(
    recentUnsentClaim?.id ?? null,
  );
  const [emailModal, setEmailModal] = useState<{
    claimId: string;
    preview: EmailPreview["preview"];
    recipient: string;
    sending: boolean;
  } | null>(null);

  // Backfill payment_info rows for booking_groups that ended up without
  // one (typically because bookings were imported via a script that
  // bypassed the post-booking pipeline). Idempotent — clicking on an
  // already-backfilled experiment just returns 0 inserted.
  async function handleBackfill() {
    if (
      !confirm(
        "이 실험의 모든 booking_group 에 대해 누락된 정산 정보 행을 생성합니다.\n" +
          "이미 행이 있는 경우는 건너뜁니다 (안전).\n\n진행할까요?",
      )
    )
      return;
    setBackfilling(true);
    try {
      const res = await fetch(
        `/api/experiments/${experimentId}/backfill-payment-info`,
        { method: "POST" },
      );
      const body = (await res.json().catch(() => null)) as {
        inserted?: number;
        alreadyHadRow?: number;
        groupsExamined?: number;
        skippedNoFee?: boolean;
        error?: string;
      } | null;
      if (!res.ok || !body) {
        toast(body?.error ?? "백필에 실패했습니다.", "error");
        return;
      }
      if (body.skippedNoFee) {
        toast("참여비 0원 실험은 백필이 필요 없습니다.", "info");
        return;
      }
      const ins = body.inserted ?? 0;
      const had = body.alreadyHadRow ?? 0;
      toast(
        ins > 0
          ? `${ins}건 백필 완료 (이미 있던 행: ${had})`
          : "추가로 만들 행이 없습니다.",
        ins > 0 ? "success" : "info",
      );
      if (ins > 0) {
        setTimeout(() => window.location.reload(), 600);
      }
    } catch {
      toast("네트워크 오류가 발생했습니다.", "error");
    } finally {
      setBackfilling(false);
    }
  }

  async function handleMarkCompleted(r: PaymentRow) {
    if (
      !confirm(
        `${r.participantName}님의 모든 회차를 '완료(completed)' 로 마킹할까요?\n\n` +
          "이미 'completed' 인 회차는 그대로 유지되며, " +
          "'confirmed' / 'running' 회차만 일괄 'completed' 로 바뀝니다. " +
          "이후 '안내 메일 발송' 버튼이 활성화됩니다.",
      )
    )
      return;
    setMarking(r.bookingGroupId);
    try {
      const res = await fetch(
        `/api/experiments/${experimentId}/payment-info/${r.bookingGroupId}/mark-completed`,
        { method: "POST" },
      );
      const body = (await res.json().catch(() => null)) as {
        success?: boolean;
        updated?: number;
        error?: string;
      } | null;
      if (!res.ok || !body?.success) {
        toast(body?.error ?? "마킹에 실패했습니다.", "error");
        return;
      }
      toast(
        body.updated
          ? `${body.updated}개 회차를 완료 처리했습니다.`
          : "이미 모든 회차가 완료 상태입니다.",
        body.updated ? "success" : "info",
      );
      setTimeout(() => window.location.reload(), 600);
    } catch {
      toast("네트워크 오류가 발생했습니다.", "error");
    } finally {
      setMarking(null);
    }
  }

  async function handleResend(r: PaymentRow) {
    const confirmMsg = r.paymentLinkSentAt
      ? `${r.participantName}님에게 정산 정보 입력 링크를 다시 발송할까요?\n\n기존에 발급된 링크는 만료되고 새 링크가 발송됩니다.`
      : `${r.participantName}님에게 정산 정보 입력 링크를 발송할까요?`;
    if (!confirm(confirmMsg)) return;
    setResending(r.bookingGroupId);
    try {
      const res = await fetch(
        `/api/experiments/${experimentId}/payment-info/${r.bookingGroupId}/resend`,
        { method: "POST" },
      );
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        toast(body?.error ?? "발송에 실패했습니다.", "error");
        return;
      }
      toast("정산 안내 메일을 발송했습니다.", "success");
      setTimeout(() => window.location.reload(), 600);
    } catch {
      toast("네트워크 오류가 발생했습니다.", "error");
    } finally {
      setResending(null);
    }
  }

  const claimable = rows.filter((r) => r.status === "submitted_to_admin");
  const totalClaimable = claimable.reduce((s, r) => s + r.amountKrw, 0);

  async function downloadBlob(
    url: string,
    key: string,
    method: "GET" | "POST" = "GET",
  ): Promise<{ ok: boolean; claimId: string | null }> {
    setDownloading(key);
    try {
      const res = await fetch(url, { method });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast(body?.error ?? "다운로드에 실패했습니다.", "error");
        return { ok: false, claimId: null };
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
      // payment-claim returns the new claim id in this header so the
      // 행정 메일 button can immediately scope to it without a server
      // round-trip.
      const claimId = res.headers.get("X-Claim-Id");
      return { ok: true, claimId };
    } catch {
      toast("네트워크 오류가 발생했습니다.", "error");
      return { ok: false, claimId: null };
    } finally {
      setDownloading(null);
    }
  }

  async function handleClaim() {
    if (claimable.length === 0) return;
    if (
      !confirm(
        `미청구 ${claimable.length}명의 참여자비를 청구하시겠습니까?\n총 ${totalClaimable.toLocaleString()}원\n\n번들이 다운로드된 후 "행정 메일 발송" 버튼이 활성화됩니다 (자동 전송 안 됨 — 미리보기 후 컨펌).\n\n실행 후에는 해당 참가자의 금액·정보를 수정할 수 없습니다.`,
      )
    )
      return;
    const { ok, claimId } = await downloadBlob(
      `/api/experiments/${experimentId}/payment-claim`,
      "claim",
      "POST",
    );
    if (ok) {
      toast(
        "청구 번들이 생성되었습니다. 행정 메일 발송 버튼으로 이어 보낼 수 있어요.",
        "success",
      );
      if (claimId) {
        setActiveClaimId(claimId);
      }
      // No automatic reload — the email button only works while the
      // X-Claim-Id is in state. After the email is sent OR after the
      // researcher opts out, we reload to refresh status chips.
    }
  }

  // ── 행정 dispatch email ──────────────────────────────────────────

  async function openEmailModal(claimId: string) {
    setDownloading("email-preview");
    try {
      const res = await fetch(
        `/api/experiments/${experimentId}/payment-claim/${claimId}/email`,
        { method: "GET" },
      );
      const body = (await res.json().catch(() => null)) as
        | EmailPreview
        | { error: string }
        | null;
      if (!res.ok || !body || "error" in body) {
        toast(
          (body as { error?: string } | null)?.error ??
            "메일 미리보기 생성 실패",
          "error",
        );
        return;
      }
      if (body.alreadySent) {
        if (
          !confirm(
            `이미 ${new Date(body.alreadySent.sentAt).toLocaleString("ko-KR")}\n${body.alreadySent.sentTo} 로 발송된 청구입니다.\n\n다시 보낼까요?`,
          )
        ) {
          return;
        }
      }
      setEmailModal({
        claimId,
        preview: body.preview,
        recipient: defaultAdminEmail || body.preview.to || "",
        sending: false,
      });
    } catch {
      toast("네트워크 오류가 발생했습니다.", "error");
    } finally {
      setDownloading(null);
    }
  }

  async function confirmAndSendEmail() {
    if (!emailModal) return;
    const recipient = emailModal.recipient.trim();
    if (!recipient || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipient)) {
      toast("올바른 이메일 주소를 입력해 주세요.", "error");
      return;
    }
    setEmailModal({ ...emailModal, sending: true });
    try {
      const res = await fetch(
        `/api/experiments/${experimentId}/payment-claim/${emailModal.claimId}/email`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ recipientEmail: recipient, confirm: true }),
        },
      );
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        toast(body?.error ?? "이메일 발송 실패", "error");
        setEmailModal({ ...emailModal, sending: false });
        return;
      }
      toast(`행정 선생님께 이메일을 발송했습니다 (${recipient})`, "success");
      setEmailModal(null);
      setActiveClaimId(null);
      setTimeout(() => window.location.reload(), 800);
    } catch {
      toast("네트워크 오류가 발생했습니다.", "error");
      setEmailModal({ ...emailModal, sending: false });
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
            {activeClaimId && (
              <button
                type="button"
                disabled={downloading !== null}
                onClick={() => openEmailModal(activeClaimId)}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                title={
                  recentUnsentClaim &&
                  recentUnsentClaim.id === activeClaimId
                    ? `청구 ${new Date(recentUnsentClaim.claimedAt).toLocaleString("ko-KR")} · ${recentUnsentClaim.participantCount}명 · ${recentUnsentClaim.totalKrw.toLocaleString()}원`
                    : "방금 생성된 청구"
                }
              >
                {downloading === "email-preview"
                  ? "미리보기 생성 중…"
                  : "📧 행정 메일 발송"}
              </button>
            )}
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
            <button
              type="button"
              disabled={backfilling}
              onClick={handleBackfill}
              title="import 등으로 누락된 booking_group 의 정산 정보 행을 한 번에 생성합니다 (안전, 멱등)."
              className="rounded-lg border border-border bg-white px-3 py-2 text-xs font-medium text-muted hover:bg-muted/30 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {backfilling ? "백필 중…" : "📋 정산 정보 백필"}
            </button>
          </div>
        </div>

        {rows.length === 0 ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            정산 정보 행이 없습니다. 참여자비가 있는 실험에서 행이 안 보이면
            상단의 <b>📋 정산 정보 백필</b> 버튼을 눌러 누락된 행을 생성해
            주세요. (이미 있는 행은 건너뜁니다.)
          </div>
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
                  <th className="py-2 pr-3 font-medium">안내 메일</th>
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
                      <td className="py-2 pr-3">
                        <DispatchCell
                          row={r}
                          experimentId={experimentId}
                          busy={resending === r.bookingGroupId}
                          onResend={() => handleResend(r)}
                          marking={marking === r.bookingGroupId}
                          onMarkCompleted={() => handleMarkCompleted(r)}
                        />
                      </td>
                      <td className="py-2">
                        {r.status !== "pending_participant" &&
                          r.status !== "paid_offline" && (
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
      {emailModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
          role="dialog"
          aria-modal="true"
          onClick={(e) => {
            // Click outside the modal closes it (only when not sending).
            if (e.target === e.currentTarget && !emailModal.sending) {
              setEmailModal(null);
            }
          }}
        >
          <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-base font-semibold text-foreground">
                  행정 선생님께 이메일 발송 — 미리보기
                </h3>
                <p className="mt-1 text-xs text-muted">
                  발송 버튼을 누르기 전까지 이메일은 보내지지 않습니다.
                  내용을 확인하고 수신자 주소가 정확한지 확인해 주세요.
                </p>
              </div>
              <button
                type="button"
                onClick={() => !emailModal.sending && setEmailModal(null)}
                disabled={emailModal.sending}
                className="text-muted hover:text-foreground disabled:opacity-50"
                aria-label="닫기"
              >
                ✕
              </button>
            </div>

            <div className="mt-4 space-y-3 text-sm">
              <label className="block">
                <span className="text-xs font-medium text-muted">
                  받는 사람 (행정 선생님 이메일)
                </span>
                <input
                  type="email"
                  value={emailModal.recipient}
                  onChange={(e) =>
                    setEmailModal({ ...emailModal, recipient: e.target.value })
                  }
                  disabled={emailModal.sending}
                  placeholder="admin@snu.ac.kr"
                  className="mt-1 w-full rounded-lg border border-border bg-white px-3 py-2 text-sm focus:border-primary focus:outline-none disabled:bg-muted/30"
                />
              </label>

              <div className="rounded-lg border border-border bg-muted/10 p-3">
                <div className="text-xs font-medium text-muted">제목</div>
                <div className="mt-0.5 text-sm font-semibold text-foreground">
                  {emailModal.preview.subject}
                </div>
              </div>

              <div className="rounded-lg border border-border bg-muted/10 p-3">
                <div className="text-xs font-medium text-muted">본문 (텍스트 미리보기)</div>
                <pre className="mt-1 whitespace-pre-wrap text-xs text-foreground font-sans">
                  {emailModal.preview.text}
                </pre>
              </div>

              <div className="rounded-lg border border-border bg-muted/10 p-3">
                <div className="text-xs font-medium text-muted">
                  첨부 파일 ({emailModal.preview.meta.attachmentNames.length}개)
                </div>
                <ul className="mt-1 space-y-0.5 text-xs text-foreground">
                  {emailModal.preview.meta.attachmentNames.map((n, i) => (
                    <li key={i}>📎 {n}</li>
                  ))}
                </ul>
              </div>

              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                <strong>발송 정보:</strong>
                <ul className="mt-1 space-y-0.5">
                  <li>• 발신: vnilab@gmail.com (랩 공용)</li>
                  {emailModal.preview.replyTo && (
                    <li>• Reply-To: {emailModal.preview.replyTo}</li>
                  )}
                  <li>• 실험자: {emailModal.preview.meta.researcherName}</li>
                  <li>
                    • 청구 합계:{" "}
                    {emailModal.preview.meta.totalKrw.toLocaleString("ko-KR")}원
                    ({emailModal.preview.meta.participantCount}건)
                  </li>
                  {emailModal.preview.meta.periodLabel && (
                    <li>• 기간: {emailModal.preview.meta.periodLabel}</li>
                  )}
                </ul>
              </div>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEmailModal(null)}
                disabled={emailModal.sending}
                className="rounded-lg border border-border bg-white px-4 py-2 text-sm font-medium text-foreground hover:bg-muted/30 disabled:opacity-50"
              >
                취소
              </button>
              <button
                type="button"
                onClick={confirmAndSendEmail}
                disabled={emailModal.sending}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {emailModal.sending ? "발송 중…" : "📧 발송"}
              </button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

function DispatchCell({
  row,
  experimentId,
  busy,
  onResend,
  onMarkCompleted,
  marking,
}: {
  row: PaymentRow;
  experimentId: string;
  busy: boolean;
  onResend: () => void;
  onMarkCompleted: () => void;
  marking: boolean;
}) {
  const submittedTerminal =
    row.status === "submitted_to_admin" ||
    row.status === "claimed" ||
    row.status === "paid";

  const previewHref = `/experiments/${experimentId}/payment-info/${row.bookingGroupId}/preview`;
  const previewLink = (
    <a
      href={previewHref}
      target="_blank"
      rel="noopener noreferrer"
      className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted hover:bg-muted/30"
      title="발송될 메일과 참여자 폼을 새 탭에서 미리보기"
    >
      👁 미리보기
    </a>
  );

  // 오프라인 정산은 메일 발송이 무의미. 별도 라벨로 표시.
  if (row.status === "paid_offline") {
    return (
      <span className="text-[11px] text-slate-500" title="플랫폼 외부에서 이미 지급된 건">
        — (오프라인 정산)
      </span>
    );
  }

  // After participant submits, the dispatch column is irrelevant (we have
  // their info). Show a calm "제출 완료" label so the column doesn't look
  // empty.
  if (submittedTerminal) {
    return <span className="text-[11px] text-emerald-700">제출 완료</span>;
  }

  if (row.paymentLinkSentAt) {
    const ts = new Date(row.paymentLinkSentAt);
    const niceDate = ts.toLocaleString("ko-KR", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    return (
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-foreground" title={`발송 완료: ${ts.toLocaleString("ko-KR")}`}>
          ✉️ {niceDate}
        </span>
        <button
          type="button"
          disabled={busy || !row.allBookingsCompleted}
          onClick={onResend}
          className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted hover:bg-muted/30 disabled:cursor-not-allowed disabled:opacity-40"
          title={
            row.allBookingsCompleted
              ? "재발송 (새 링크가 발급됩니다)"
              : "모든 세션이 완료되어야 재발송할 수 있습니다"
          }
        >
          {busy ? "발송 중…" : "재발송"}
        </button>
        {previewLink}
      </div>
    );
  }

  // Not yet sent. Show why (still waiting for completion / failed) + a
  // manual trigger when applicable. When sessions aren't done, offer a
  // shortcut "회차 완료 처리" button so the researcher doesn't have to
  // open the observation modal for every session — common in backfilled
  // experiments where the participant finished offline weeks ago.
  if (!row.allBookingsCompleted) {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-[11px] text-muted">세션 종료 대기</span>
        <div className="flex flex-wrap gap-1">
          <button
            type="button"
            disabled={marking}
            onClick={onMarkCompleted}
            title="이 그룹의 모든 회차를 한 번에 'completed' 로 마킹합니다."
            className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-800 hover:bg-amber-100 disabled:opacity-50"
          >
            {marking ? "마킹 중…" : "✓ 회차 완료 처리"}
          </button>
          {previewLink}
        </div>
      </div>
    );
  }

  if (row.paymentLinkLastError) {
    return (
      <div className="flex items-center gap-2">
        <span
          className="text-[11px] text-red-600"
          title={row.paymentLinkLastError}
        >
          발송 실패 ({row.paymentLinkAttempts}회)
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={onResend}
          className="rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-[10px] text-red-700 hover:bg-red-100 disabled:opacity-50"
        >
          {busy ? "발송 중…" : "다시 시도"}
        </button>
        {previewLink}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={onResend}
        className="rounded border border-primary/30 bg-primary/5 px-2 py-0.5 text-[11px] text-primary hover:bg-primary/10 disabled:opacity-50"
      >
        {busy ? "발송 중…" : "안내 메일 발송"}
      </button>
      {previewLink}
    </div>
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
