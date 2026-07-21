"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";

interface Props {
  experimentId: string;
  bookingGroupId: string;
  participantName: string;
}

// Shape of GET /api/experiments/{id}/reschedule-invite/{groupId} — a
// preview-only response (no send side effects). The route renders the same
// email the POST will dispatch so the researcher can eyeball recipient +
// subject + body before committing.
interface InvitePreview {
  preview: {
    to: string;
    cc?: string | null;
    subject: string;
    html: string;
  };
  participant: { name: string };
  editUrl: string;
}

// Per-participant "일정 재조정 안내 메일" invite. Click → GET preview →
// open a modal (recipient / subject / optional 메시지 / rendered HTML) →
// 발송 does a POST with { message, confirm:true }. Modeled on the
// payment-panel preview-then-send flow (useToast + Modal + Button).
export function RescheduleInviteButton({
  experimentId,
  bookingGroupId,
  participantName,
}: Props) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<InvitePreview | null>(null);

  async function openPreview() {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/experiments/${experimentId}/reschedule-invite/${bookingGroupId}`,
        { method: "GET" },
      );
      const body = (await res.json().catch(() => null)) as
        | InvitePreview
        | { error: string }
        | null;
      if (!res.ok || !body || "error" in body) {
        const msg =
          (body as { error?: string } | null)?.error ??
          `미리보기 생성 실패 (HTTP ${res.status})`;
        toast(msg, "error");
        return;
      }
      setPreview(body);
      setMessage("");
    } catch {
      toast("네트워크 오류가 발생했습니다.", "error");
    } finally {
      setLoading(false);
    }
  }

  async function handleSend() {
    setSending(true);
    try {
      const res = await fetch(
        `/api/experiments/${experimentId}/reschedule-invite/${bookingGroupId}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: message.trim() || undefined,
            confirm: true,
          }),
        },
      );
      const body = (await res.json().catch(() => null)) as
        | { ok: true; sentTo: string }
        | { error: string }
        | null;
      if (!res.ok || !body || "error" in body) {
        const msg =
          (body as { error?: string } | null)?.error ??
          `발송 실패 (HTTP ${res.status})`;
        toast(msg, "error");
        return;
      }
      toast("안내 메일을 발송했습니다.", "success");
      setPreview(null);
    } catch {
      toast("네트워크 오류가 발생했습니다.", "error");
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        loading={loading}
        disabled={loading}
        onClick={openPreview}
      >
        재조정 안내 메일
      </Button>

      <Modal
        open={preview !== null}
        onClose={() => {
          if (!sending) setPreview(null);
        }}
        title={`일정 재조정 안내 메일 — ${participantName}`}
      >
        {preview && (
          <div className="space-y-3 text-sm">
            <p className="text-xs text-muted">
              발송 버튼을 누르기 전까지 메일은 보내지지 않습니다. 수신자와
              내용을 확인해 주세요.
            </p>

            <div className="rounded-lg border border-border bg-muted/10 p-3">
              <div className="text-xs font-medium text-muted">받는 사람</div>
              <div className="mt-0.5 text-sm text-foreground">
                {preview.preview.to}
              </div>
              {preview.preview.cc && (
                <div className="mt-2 border-t border-border/60 pt-2">
                  <div className="text-xs font-medium text-muted">
                    참조 (담당 연구원)
                  </div>
                  <div className="mt-0.5 text-sm text-foreground">
                    {preview.preview.cc}
                  </div>
                </div>
              )}
            </div>

            <div className="rounded-lg border border-border bg-muted/10 p-3">
              <div className="text-xs font-medium text-muted">제목</div>
              <div className="mt-0.5 text-sm font-semibold text-foreground">
                {preview.preview.subject}
              </div>
            </div>

            <label className="block">
              <span className="text-xs font-medium text-muted">
                메시지 (선택 — 본문 상단에 추가됩니다)
              </span>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                disabled={sending}
                rows={3}
                placeholder="예: 다음 주 실험 일정을 다시 잡아주세요. 편하신 시간으로 예약하시면 됩니다."
                className="mt-1 w-full rounded-lg border border-border bg-white px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:bg-muted/30"
              />
            </label>

            <div>
              <div className="mb-1 text-xs font-medium text-muted">
                본문 미리보기
              </div>
              <div
                className="max-h-64 overflow-y-auto rounded-lg border border-border bg-white p-3 text-sm text-foreground [&_a]:text-primary [&_a]:underline"
                // Preview HTML is rendered by the trusted server route for
                // this experiment's own participant — same as the payment
                // dispatch preview flow.
                dangerouslySetInnerHTML={{ __html: preview.preview.html }}
              />
            </div>

            {preview.editUrl && (
              <div className="rounded-lg border border-border bg-muted/10 p-3 text-xs text-muted">
                재예약 링크: <span className="break-all">{preview.editUrl}</span>
              </div>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setPreview(null)}
                disabled={sending}
              >
                취소
              </Button>
              <Button
                type="button"
                variant="primary"
                onClick={handleSend}
                loading={sending}
              >
                발송
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
