"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

// Two-row merge UI for the participants section. Used when a person has
// been double-imported (e.g. Korean + romanised name from calendar
// backfill, or accidentally re-signed-up). Calls
// POST /api/participants/{sourceId}/merge with { targetId } — the
// server moves bookings, payment-info, classes, lab-identity, audit
// rows to target and deletes source.

interface SearchHit {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
}

function isPlaceholderEmail(s: string | null): boolean {
  if (!s) return false;
  return /@-$|@no-email\.local$|@imported\.invalid$/.test(s);
}

export function ParticipantMergeModal({
  open,
  onClose,
  sourceId,
  sourceLabel,
}: {
  open: boolean;
  onClose: () => void;
  sourceId: string;
  sourceLabel: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [target, setTarget] = useState<SearchHit | null>(null);
  const [merging, setMerging] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  // Debounced search.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 1) {
      setResults([]);
      return;
    }
    let aborted = false;
    setSearching(true);
    const handle = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/participants?search=${encodeURIComponent(q)}&limit=20`,
          { cache: "no-store" },
        );
        if (!res.ok) {
          if (!aborted) setResults([]);
          return;
        }
        const j = (await res.json()) as { participants?: SearchHit[] };
        if (aborted) return;
        const list = (j.participants ?? []).filter((p) => p.id !== sourceId);
        setResults(list);
      } finally {
        if (!aborted) setSearching(false);
      }
    }, 200);
    return () => {
      aborted = true;
      clearTimeout(handle);
    };
  }, [open, query, sourceId]);

  // Reset on close.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setResults([]);
      setTarget(null);
      setConfirmText("");
      setMerging(false);
    }
  }, [open]);

  async function doMerge() {
    if (!target || merging) return;
    if (confirmText.trim() !== "병합") {
      toast("병합을 진행하려면 '병합'을 정확히 입력해 주세요.", "error");
      return;
    }
    setMerging(true);
    try {
      const res = await fetch(`/api/participants/${sourceId}/merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId: target.id }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        moved?: Record<string, number>;
      };
      if (!res.ok || !j.ok) {
        toast(j.error ?? "병합에 실패했습니다.", "error");
        setMerging(false);
        return;
      }
      const movedSummary = j.moved
        ? Object.entries(j.moved)
            .filter(([, v]) => (v as number) > 0)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ")
        : "";
      toast(
        `병합 완료${movedSummary ? ` (${movedSummary})` : ""}. target 페이지로 이동합니다.`,
        "success",
      );
      onClose();
      router.push(`/participants/${target.id}`);
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : "네트워크 오류", "error");
      setMerging(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="참여자 병합">
      <div className="space-y-4">
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          <p className="font-medium">⚠️ 되돌릴 수 없는 작업입니다.</p>
          <p className="mt-1">
            현재 참여자(<b>{sourceLabel}</b>)의 모든 예약·정산·클래스 이력이
            선택한 target 참여자로 이전된 뒤, 현재 참여자 row 가 삭제됩니다.
            보통 한 인물이 한국어/영문 이름으로 두 번 등록된 경우 정리에
            사용합니다.
          </p>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-muted">
            병합 대상 참여자 검색
          </label>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="이름·이메일·전화번호 일부…"
            className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            autoFocus
          />
        </div>

        <div className="max-h-64 overflow-y-auto rounded-md border border-border">
          {searching ? (
            <p className="p-4 text-center text-xs text-muted">검색 중…</p>
          ) : results.length === 0 ? (
            <p className="p-4 text-center text-xs text-muted">
              {query.trim().length === 0
                ? "검색어를 입력하세요"
                : "일치하는 참여자가 없습니다"}
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {results.map((p) => {
                const selected = target?.id === p.id;
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => setTarget(p)}
                      className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition-colors ${
                        selected
                          ? "bg-primary/10 text-foreground"
                          : "hover:bg-card"
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate">
                        <span className="font-medium">
                          {p.name ?? "(이름 없음)"}
                        </span>
                        <span className="ml-2 text-xs text-muted">
                          {isPlaceholderEmail(p.email)
                            ? "이메일 (미입력)"
                            : (p.email ?? "이메일 -")}
                          {" · "}
                          {!p.phone || p.phone === ""
                            ? "전화 (미입력)"
                            : p.phone}
                        </span>
                      </span>
                      {selected && (
                        <span className="rounded-full bg-primary px-2 py-0.5 text-xs text-white">
                          target
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {target && (
          <div className="rounded-md border border-border bg-card p-3 text-xs">
            <p>
              <b>{sourceLabel}</b> →{" "}
              <b>{target.name ?? "(이름 없음)"}</b>
              {" 으로 모든 이력 이동 + source 삭제."}
            </p>
            <label className="mt-2 block text-xs text-muted">
              확인을 위해 아래에 <b>병합</b>을 입력하세요.
            </label>
            <input
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="병합"
              className="mt-1 w-full rounded-md border border-border bg-white px-3 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={merging}>
            취소
          </Button>
          <Button
            onClick={doMerge}
            disabled={!target || merging || confirmText.trim() !== "병합"}
            variant="danger"
          >
            {merging ? "병합 중…" : "병합 실행"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
