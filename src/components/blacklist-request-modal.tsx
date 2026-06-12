"use client";

import { useCallback, useEffect, useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

// Researcher-facing blacklist registration request modal. Opened from
// the 참여자 관리 selection bar once one or more participants are
// checked. Captures:
//   - 사유 (required, 2-500 chars) — shared across the batch.
//   - 연락처 끝4 (optional) — for admin identification at approval time.
// On submit POSTs /api/participants/blacklist-requests, which inserts
// one pending row per participant and fires an approval-request email
// (vnilab→vnilab, CC requester).

export function BlacklistRequestModal({
  open,
  onClose,
  participantIds,
  onSubmitted,
}: {
  open: boolean;
  onClose: () => void;
  participantIds: string[];
  onSubmitted?: () => void;
}) {
  const { toast } = useToast();
  const [reason, setReason] = useState("");
  const [phoneLast4, setPhoneLast4] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{
    created: number;
    skipped: Array<{ id: string; reason: string }>;
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    setReason("");
    setPhoneLast4("");
    setSubmitting(false);
    setResult(null);
  }, [open]);

  const submit = useCallback(async () => {
    const trimmed = reason.trim();
    if (trimmed.length < 2) {
      toast("사유는 2자 이상 입력해 주세요", "error");
      return;
    }
    const p4 = phoneLast4.trim().replace(/\D/g, "").slice(-4);
    if (phoneLast4.trim() && p4.length !== 4) {
      toast("전화번호 끝 4자리는 숫자 4자리여야 합니다", "error");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/participants/blacklist-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          participantIds,
          reason: trimmed,
          phoneLast4: p4 || undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        toast(body?.error ?? "요청 제출에 실패했습니다", "error");
        return;
      }
      setResult({
        created: body.created ?? 0,
        skipped: body.skipped ?? [],
      });
      const sk = (body.skipped ?? []).length;
      toast(
        `블랙리스트 등록 요청 — 신청 ${body.created ?? 0}건${sk > 0 ? ` · 제외 ${sk}건` : ""}`,
        (body.created ?? 0) > 0 ? "success" : "info",
      );
      onSubmitted?.();
    } catch {
      toast("네트워크 오류가 발생했습니다", "error");
    } finally {
      setSubmitting(false);
    }
  }, [reason, phoneLast4, participantIds, toast, onSubmitted]);

  return (
    <Modal open={open} onClose={onClose} title="블랙리스트 등록 신청">
      <div className="space-y-4">
        {result ? (
          <div className="space-y-3">
            <div className="rounded-lg border border-border bg-card p-4 text-sm">
              <p className="text-foreground">
                승인 대기로 등록된 요청{" "}
                <span className="font-semibold text-amber-700">
                  {result.created}건
                </span>
                {result.skipped.length > 0 && (
                  <>
                    {" · "}제외{" "}
                    <span className="font-semibold">
                      {result.skipped.length}건
                    </span>
                  </>
                )}
              </p>
              <p className="mt-2 text-xs text-muted">
                관리자가 승인하면 해당 참여자는 블랙리스트로 분류되며,
                향후 홍보 메일 발송에서 자동으로 제외됩니다. 승인 요청
                메일이 발신 계정에서 발송되었고, 신청자(본인) 이메일이
                참조(CC)로 포함됩니다.
              </p>
            </div>
            {result.skipped.length > 0 && (
              <div className="max-h-32 overflow-y-auto rounded-lg border border-border bg-card p-2 text-xs">
                {result.skipped.map((s) => (
                  <div key={s.id} className="text-muted">
                    · {s.id.slice(0, 8)} — {s.reason}
                  </div>
                ))}
              </div>
            )}
            <div className="flex justify-end">
              <Button onClick={onClose}>닫기</Button>
            </div>
          </div>
        ) : (
          <>
            <p className="text-sm text-muted">
              선택한 참여자 {participantIds.length}명을 블랙리스트로
              등록 신청합니다. 관리자 승인 후 적용됩니다.
            </p>
            <div>
              <label className="mb-1 block text-sm font-medium text-foreground">
                사유 <span className="text-danger-600">*</span>
              </label>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={4}
                maxLength={500}
                placeholder="예: 노쇼, 직전취소, 부적절한 행동 등 (2자 이상)"
                className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
              <p className="mt-1 text-xs text-muted">
                간단히 작성해 주세요. ({reason.trim().length}/500)
              </p>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-foreground">
                연락처 끝 4자리 (선택, 식별용)
              </label>
              <input
                value={phoneLast4}
                onChange={(e) => setPhoneLast4(e.target.value)}
                placeholder="예: 0988"
                maxLength={16}
                className="w-40 rounded-lg border border-border bg-white px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
              <p className="mt-1 text-xs text-muted">
                전체 번호를 입력해도 끝 4자리만 저장됩니다. 비워두면
                기존 연락처가 그대로 유지됩니다.
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={onClose} disabled={submitting}>
                취소
              </Button>
              <Button
                onClick={submit}
                disabled={submitting || reason.trim().length < 2}
              >
                {submitting ? "제출 중…" : `${participantIds.length}명 등록 신청`}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
