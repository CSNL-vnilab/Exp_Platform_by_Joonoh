"use client";

import { useCallback, useEffect, useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";

// Recruitment ("홍보") blast modal. Flow:
//   1. pick an active experiment → server returns an editable
//      subject/body template + recipient breakdown
//   2. edit subject/body freely, flip to 미리보기 to see rendered HTML
//   3. 발송 → ONE email, To: lab account (self), BCC: every selected
//      deliverable participant (same body to all)

interface PromoExperiment {
  id: string;
  title: string;
  project_name: string | null;
}

interface PreviewResponse {
  experiment: { id: string; title: string };
  subject: string;
  body: string;
  html: string;
  recipients: Array<{
    id: string;
    name: string | null;
    email: string;
    deliverable: boolean;
    alreadySent: boolean;
  }>;
  counts: {
    selected: number;
    deliverable: number;
    undeliverable: number;
    alreadySent: number;
  };
}

export function PromoEmailModal({
  open,
  onClose,
  participantIds,
  experimentMode,
  onSent,
}: {
  open: boolean;
  onClose: () => void;
  participantIds: string[];
  // Scope the active-experiments dropdown to a single mode so an
  // offline-recruitment blast can't accidentally pick an online (often
  // e2e/test) experiment, and vice versa. null = no scope.
  experimentMode?: "offline" | "online" | "hybrid" | null;
  onSent?: () => void;
}) {
  const { toast } = useToast();

  const [experiments, setExperiments] = useState<PromoExperiment[]>([]);
  const [loadingExps, setLoadingExps] = useState(false);
  const [selectedExp, setSelectedExp] = useState("");

  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [html, setHtml] = useState("");
  const [counts, setCounts] = useState<PreviewResponse["counts"] | null>(null);
  const [tab, setTab] = useState<"edit" | "preview">("edit");
  const [loadingTpl, setLoadingTpl] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState<{ sent: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    setSelectedExp("");
    setSubject("");
    setBody("");
    setHtml("");
    setCounts(null);
    setTab("edit");
    setDone(null);
    setLoadingExps(true);
    const url = experimentMode
      ? `/api/participants/promo-email?mode=${experimentMode}`
      : "/api/participants/promo-email";
    fetch(url)
      .then(async (r) => {
        if (!r.ok) throw new Error();
        const b = (await r.json()) as { experiments: PromoExperiment[] };
        setExperiments(b.experiments ?? []);
      })
      .catch(() => toast("활성 실험 목록을 불러오지 못했습니다", "error"))
      .finally(() => setLoadingExps(false));
  }, [open, toast, experimentMode]);

  // Load the editable template + recipient breakdown for an experiment.
  const loadTemplate = useCallback(
    async (experimentId: string) => {
      setLoadingTpl(true);
      try {
        const res = await fetch("/api/participants/promo-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            experimentId,
            participantIds,
            mode: "preview",
          }),
        });
        const b = await res.json();
        if (!res.ok) {
          toast(b?.error ?? "템플릿을 불러오지 못했습니다", "error");
          return;
        }
        const pv = b as PreviewResponse;
        setSubject(pv.subject);
        setBody(pv.body);
        setHtml(pv.html);
        setCounts(pv.counts);
        setTab("edit");
      } catch {
        toast("네트워크 오류가 발생했습니다", "error");
      } finally {
        setLoadingTpl(false);
      }
    },
    [participantIds, toast],
  );

  const refreshPreview = useCallback(async () => {
    if (!selectedExp) return;
    setRefreshing(true);
    try {
      const res = await fetch("/api/participants/promo-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          experimentId: selectedExp,
          participantIds,
          mode: "preview",
          subject,
          body,
        }),
      });
      const b = await res.json();
      if (!res.ok) {
        toast(b?.error ?? "미리보기를 갱신하지 못했습니다", "error");
        return;
      }
      setHtml((b as PreviewResponse).html);
      setTab("preview");
    } catch {
      toast("네트워크 오류가 발생했습니다", "error");
    } finally {
      setRefreshing(false);
    }
  }, [selectedExp, participantIds, subject, body, toast]);

  const send = useCallback(async () => {
    if (!selectedExp || !counts || counts.deliverable === 0) return;
    setSending(true);
    try {
      const res = await fetch("/api/participants/promo-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          experimentId: selectedExp,
          participantIds,
          mode: "send",
          subject,
          body,
          confirm: true,
        }),
      });
      const b = await res.json();
      if (!res.ok) {
        toast(b?.error ?? "발송에 실패했습니다", "error");
        return;
      }
      setDone({ sent: b.counts?.sent ?? counts.deliverable });
      toast(`홍보 메일 발송 완료 — ${b.counts?.sent ?? counts.deliverable}명 (BCC)`, "success");
      onSent?.();
    } catch {
      toast("네트워크 오류가 발생했습니다", "error");
    } finally {
      setSending(false);
    }
  }, [selectedExp, counts, participantIds, subject, body, toast, onSent]);

  return (
    <Modal open={open} onClose={onClose} title="참여자 홍보 메일 발송">
      <div className="space-y-4">
        {done ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
              ✓ {done.sent}명에게 홍보 메일을 발송했습니다. (To: 발신 계정,
              BCC: 참여자)
            </div>
            <div className="flex justify-end">
              <Button onClick={onClose}>닫기</Button>
            </div>
          </div>
        ) : (
          <>
            <div>
              <label className="mb-1 block text-sm font-medium text-foreground">
                홍보할 실험 (진행 중)
              </label>
              <Select
                value={selectedExp}
                disabled={loadingExps || sending}
                onChange={(e) => {
                  const v = e.target.value;
                  setSelectedExp(v);
                  if (v) void loadTemplate(v);
                  else {
                    setSubject("");
                    setBody("");
                    setHtml("");
                    setCounts(null);
                  }
                }}
              >
                <option value="">
                  {loadingExps ? "불러오는 중…" : "실험을 선택하세요"}
                </option>
                {experiments.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.title}
                    {e.project_name ? ` · ${e.project_name}` : ""}
                  </option>
                ))}
              </Select>
              {!loadingExps && experiments.length === 0 && (
                <p className="mt-1 text-xs text-muted">
                  진행 중(active)인 실험이 없습니다. 실험을 먼저 활성화하세요.
                </p>
              )}
            </div>

            {loadingTpl && (
              <p className="text-sm text-muted">템플릿 불러오는 중…</p>
            )}

            {counts && !loadingTpl && (
              <>
                <div className="grid grid-cols-3 gap-2 text-center text-sm">
                  <div className="rounded-lg border border-border bg-card p-2">
                    <div className="text-lg font-semibold text-emerald-700">
                      {counts.deliverable}
                    </div>
                    <div className="text-xs text-muted">발송 대상(BCC)</div>
                  </div>
                  <div className="rounded-lg border border-border bg-card p-2">
                    <div className="text-lg font-semibold text-amber-700">
                      {counts.undeliverable}
                    </div>
                    <div className="text-xs text-muted">이메일 없음</div>
                  </div>
                  <div className="rounded-lg border border-border bg-card p-2">
                    <div className="text-lg font-semibold text-sky-700">
                      {counts.alreadySent}
                    </div>
                    <div className="text-xs text-muted">기발송</div>
                  </div>
                </div>

                <div className="flex gap-2 border-b border-border">
                  {(["edit", "preview"] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() =>
                        t === "preview" ? refreshPreview() : setTab("edit")
                      }
                      className={`-mb-px border-b-2 px-3 py-1.5 text-sm font-medium ${
                        tab === t
                          ? "border-primary text-foreground"
                          : "border-transparent text-muted hover:text-foreground"
                      }`}
                    >
                      {t === "edit" ? "내용 편집" : "미리보기"}
                      {t === "preview" && refreshing ? " …" : ""}
                    </button>
                  ))}
                </div>

                {tab === "edit" ? (
                  <div className="space-y-3">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-muted">
                        제목
                      </label>
                      <input
                        value={subject}
                        onChange={(e) => setSubject(e.target.value)}
                        className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-muted">
                        본문 (자유롭게 수정 가능 · URL은 자동 링크)
                      </label>
                      <textarea
                        value={body}
                        onChange={(e) => setBody(e.target.value)}
                        rows={14}
                        className="w-full rounded-lg border border-border bg-white px-3 py-2 font-mono text-xs leading-relaxed focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                      />
                    </div>
                  </div>
                ) : (
                  <div>
                    <p className="mb-1 text-xs text-muted">
                      제목: <span className="text-foreground">{subject}</span>
                    </p>
                    <iframe
                      title="promo-preview"
                      srcDoc={html}
                      className="h-80 w-full rounded-lg border border-border bg-white"
                    />
                  </div>
                )}

                <div className="flex items-center justify-end gap-2">
                  <Button
                    variant="secondary"
                    onClick={onClose}
                    disabled={sending}
                  >
                    취소
                  </Button>
                  {tab === "edit" && (
                    <Button
                      variant="secondary"
                      onClick={refreshPreview}
                      loading={refreshing}
                      disabled={refreshing || sending}
                    >
                      미리보기
                    </Button>
                  )}
                  <Button
                    onClick={send}
                    loading={sending}
                    disabled={
                      sending ||
                      counts.deliverable === 0 ||
                      !subject.trim() ||
                      !body.trim()
                    }
                  >
                    {`${counts.deliverable}명에게 발송`}
                  </Button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
