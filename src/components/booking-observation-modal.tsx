"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

/**
 * Researcher-facing modal for filling in `booking_observations`.
 *
 * Wraps the Stream C endpoints:
 *   GET  /api/bookings/[bookingId]/observation
 *   PUT  /api/bookings/[bookingId]/observation (optional ?backfill=true)
 *
 * Validation mirrors the server-side zod: if a *_done flag is checked, the
 * matching *_info textarea must be non-empty. post_survey_done=true will
 * auto-mark the booking as `completed` on the server; we surface that as a
 * confirmation tick once the PUT response reports the updated status.
 */

interface Props {
  bookingId: string;
  slotStart: string; // ISO — server's backfill guard compares against slot_start + 10min
  slotEnd: string; // ISO — kept for display
  bookingStatus: string;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

interface ObservationPayload {
  pre_survey_done: boolean;
  pre_survey_info: string | null;
  post_survey_done: boolean;
  post_survey_info: string | null;
  notable_observations: string | null;
}

interface FieldErrors {
  pre_survey_info?: string;
  post_survey_info?: string;
}

export function BookingObservationModal({
  bookingId,
  slotStart,
  slotEnd: _slotEnd,
  bookingStatus,
  open,
  onClose,
  onSaved,
}: Props) {
  const { toast } = useToast();

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [preDone, setPreDone] = useState(false);
  const [preInfo, setPreInfo] = useState("");
  const [postDone, setPostDone] = useState(false);
  const [postInfo, setPostInfo] = useState("");
  const [notable, setNotable] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [completedTick, setCompletedTick] = useState<boolean>(
    bookingStatus === "completed",
  );

  // Server's backfill guard compares `slot_start + 10min` to now; match that
  // on the client so the "too early" banner + `?backfill=true` flag fire for
  // the same requests the server would reject. (Previously compared against
  // slot_end, which disagreed with the server for mid-session saves.)
  const needsBackfill = useMemo(() => {
    if (!slotStart) return false;
    const slotStartMs = new Date(slotStart).getTime();
    return slotStartMs + 10 * 60 * 1000 > Date.now();
  }, [slotStart]);

  // Load existing observation when modal opens. Reset on close so stale state
  // doesn't bleed into the next booking.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/bookings/${bookingId}/observation`);
        if (!res.ok) {
          // 404 is a valid "no observation yet" signal; anything else is noise.
          if (res.status !== 404 && !cancelled) {
            toast("기록을 불러오지 못했습니다.", "error");
          }
          return;
        }
        const body = (await res.json().catch(() => null)) as
          | { observation: ObservationPayload | null }
          | ObservationPayload
          | null;
        if (cancelled || !body) return;
        const obs =
          (body as { observation?: ObservationPayload }).observation !== undefined
            ? (body as { observation: ObservationPayload | null }).observation
            : (body as ObservationPayload);
        if (obs) {
          setPreDone(!!obs.pre_survey_done);
          setPreInfo(obs.pre_survey_info ?? "");
          setPostDone(!!obs.post_survey_done);
          setPostInfo(obs.post_survey_info ?? "");
          setNotable(obs.notable_observations ?? "");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, bookingId, toast]);

  useEffect(() => {
    if (!open) {
      setErrors({});
    }
  }, [open]);

  function validate(): FieldErrors {
    const next: FieldErrors = {};
    if (preDone && preInfo.trim().length === 0) {
      next.pre_survey_info = "사전 설문을 완료로 표시한 경우 내용을 입력해 주세요.";
    }
    if (postDone && postInfo.trim().length === 0) {
      next.post_survey_info = "사후 설문을 완료로 표시한 경우 내용을 입력해 주세요.";
    }
    return next;
  }

  async function handleSave() {
    const v = validate();
    setErrors(v);
    if (Object.keys(v).length > 0) return;

    setSaving(true);
    try {
      const url = needsBackfill
        ? `/api/bookings/${bookingId}/observation?backfill=true`
        : `/api/bookings/${bookingId}/observation`;
      const res = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pre_survey_done: preDone,
          pre_survey_info: preDone ? preInfo.trim() : undefined,
          post_survey_done: postDone,
          post_survey_info: postDone ? postInfo.trim() : undefined,
          notable_observations: notable.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        // Keep PII out of toasts — stick to the server-provided message only.
        toast(body.error ?? "저장에 실패했습니다.", "error");
        return;
      }
      const body = (await res.json().catch(() => ({}))) as {
        booking?: { status?: string } | null;
        status?: string;
      };
      const updatedStatus =
        body.booking?.status ?? body.status ?? (postDone ? "completed" : undefined);
      if (updatedStatus === "completed") {
        setCompletedTick(true);
      }
      toast("관찰 기록이 저장되었습니다.", "success");
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="관찰 입력">
      <div className="space-y-4">
        {loading ? (
          <p className="text-sm text-muted">불러오는 중…</p>
        ) : (
          <>
            {needsBackfill && (
              <div
                role="alert"
                className="rounded-lg border border-yellow-200 bg-yellow-50 px-3 py-2 text-xs text-yellow-800"
              >
                실험 시간이 아직 지나지 않았습니다. 사전에만 기록하는 경우
                backfill 플래그로 저장됩니다.
              </div>
            )}

            {completedTick && (
              <div
                role="status"
                className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800"
              >
                <span aria-hidden>✓</span>
                <span>예약 상태가 &ldquo;완료&rdquo;로 전환되었습니다.</span>
              </div>
            )}

            {/* Pre-survey */}
            <div className="rounded-lg border border-border bg-card p-3">
              <label className="flex items-center gap-2 text-sm font-medium text-foreground">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-primary"
                  checked={preDone}
                  onChange={(e) => setPreDone(e.target.checked)}
                />
                사전 설문 완료
              </label>
              {preDone && (
                <div className="mt-2">
                  <label
                    htmlFor="pre-info"
                    className="text-xs font-medium text-muted"
                  >
                    사전 설문 메모
                  </label>
                  <textarea
                    id="pre-info"
                    rows={3}
                    value={preInfo}
                    onChange={(e) => setPreInfo(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-border bg-white px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                    placeholder="예: 설문 링크 클릭 확인, 응답 완료 스크린샷 수령"
                  />
                  {errors.pre_survey_info && (
                    <p className="mt-1 text-xs text-danger">
                      {errors.pre_survey_info}
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Post-survey */}
            <div className="rounded-lg border border-border bg-card p-3">
              <label className="flex items-center gap-2 text-sm font-medium text-foreground">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-primary"
                  checked={postDone}
                  onChange={(e) => setPostDone(e.target.checked)}
                />
                사후 설문 완료
              </label>
              {postDone && (
                <p className="mt-1 text-xs text-muted">
                  사후 설문을 완료로 저장하면 예약이 자동으로 &ldquo;완료&rdquo;
                  상태로 전환됩니다.
                </p>
              )}
              {postDone && (
                <div className="mt-2">
                  <label
                    htmlFor="post-info"
                    className="text-xs font-medium text-muted"
                  >
                    사후 설문 메모
                  </label>
                  <textarea
                    id="post-info"
                    rows={3}
                    value={postInfo}
                    onChange={(e) => setPostInfo(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-border bg-white px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                    placeholder="예: 참여자 소감, 이상 징후, 기타 메모"
                  />
                  {errors.post_survey_info && (
                    <p className="mt-1 text-xs text-danger">
                      {errors.post_survey_info}
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Notable observations — always visible */}
            <div>
              <label
                htmlFor="notable"
                className="text-xs font-medium text-muted"
              >
                특이사항 (선택)
              </label>
              <textarea
                id="notable"
                rows={3}
                value={notable}
                onChange={(e) => setNotable(e.target.value)}
                className="mt-1 w-full rounded-lg border border-border bg-white px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                placeholder="장비 오류, 참여자 컨디션, 재방문 사유 등"
              />
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="secondary" size="sm" onClick={onClose} disabled={saving}>
                닫기
              </Button>
              <Button size="sm" onClick={handleSave} disabled={saving}>
                {saving ? "저장 중…" : "저장"}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
