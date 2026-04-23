"use client";

import { useEffect, useState } from "react";
import type { OnlineScreenerKind, OnlineScreenerValidation } from "@/types/database";
import { Button } from "@/components/ui/button";

interface ScreenerRow {
  id?: string;
  kind: OnlineScreenerKind;
  question: string;
  help_text: string | null;
  required: boolean;
  validation_config: OnlineScreenerValidation;
}

// Editor for an experiment's online screener questions. Researcher-facing,
// loaded on-demand from /api/experiments/:id/online-screeners. Kept out of
// the main experiment form's serialization path so we don't have to thread
// an extra round-trip through the experiments UPSERT.

export function OnlineScreenerEditor({ experimentId }: { experimentId: string }) {
  const [rows, setRows] = useState<ScreenerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/experiments/${experimentId}/online-screeners`,
        );
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.ok) {
          setRows(
            (body.screeners ?? []).map((r: Record<string, unknown>) => ({
              id: r.id as string,
              kind: r.kind as OnlineScreenerKind,
              question: r.question as string,
              help_text: (r.help_text as string) ?? null,
              required: (r.required as boolean) ?? true,
              validation_config: (r.validation_config as OnlineScreenerValidation) ?? {},
            })),
          );
        } else {
          setError(body.error ?? "스크리너를 불러오지 못했습니다");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [experimentId]);

  function updateRow(idx: number, patch: Partial<ScreenerRow>) {
    setRows((rs) =>
      rs.map((r, i) => (i === idx ? { ...r, ...patch } : r)),
    );
    setDirty(true);
  }

  function updateValidation(idx: number, patch: Partial<OnlineScreenerValidation>) {
    setRows((rs) =>
      rs.map((r, i) =>
        i === idx
          ? { ...r, validation_config: { ...r.validation_config, ...patch } }
          : r,
      ),
    );
    setDirty(true);
  }

  function addRow(kind: OnlineScreenerKind) {
    const blank: OnlineScreenerValidation =
      kind === "yes_no"
        ? { required_answer: true }
        : kind === "numeric"
          ? {}
          : { options: [] };
    setRows((rs) => [
      ...rs,
      { kind, question: "", help_text: null, required: true, validation_config: blank },
    ]);
    setDirty(true);
  }

  function removeRow(idx: number) {
    setRows((rs) => rs.filter((_, i) => i !== idx));
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/experiments/${experimentId}/online-screeners`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            rows.map((r) => ({
              id: r.id,
              kind: r.kind,
              question: r.question,
              help_text: r.help_text,
              required: r.required,
              validation_config: r.validation_config,
            })),
          ),
        },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? "저장 실패");
        return;
      }
      setRows(
        (body.screeners ?? []).map((r: Record<string, unknown>) => ({
          id: r.id as string,
          kind: r.kind as OnlineScreenerKind,
          question: r.question as string,
          help_text: (r.help_text as string) ?? null,
          required: (r.required as boolean) ?? true,
          validation_config: (r.validation_config as OnlineScreenerValidation) ?? {},
        })),
      );
      setDirty(false);
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="text-sm text-muted">불러오는 중…</p>;

  return (
    <div className="space-y-3">
      {error && (
        <p className="rounded-md bg-red-50 p-2 text-xs text-red-700">{error}</p>
      )}
      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border py-4 text-center text-xs text-muted">
          스크리너 질문이 없습니다
        </p>
      ) : (
        <div className="space-y-3">
          {rows.map((row, i) => (
            <div key={i} className="rounded-lg border border-border bg-white p-3">
              <div className="flex items-start gap-2">
                <div className="flex-1 space-y-2">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary">
                      {row.kind === "yes_no"
                        ? "예/아니오"
                        : row.kind === "numeric"
                          ? "숫자"
                          : row.kind === "single_choice"
                            ? "단일선택"
                            : "복수선택"}
                    </span>
                    <label className="flex items-center gap-1 text-muted">
                      <input
                        type="checkbox"
                        checked={row.required}
                        onChange={(e) => updateRow(i, { required: e.target.checked })}
                        className="h-3.5 w-3.5 accent-primary"
                      />
                      필수
                    </label>
                  </div>
                  <input
                    value={row.question}
                    onChange={(e) => updateRow(i, { question: e.target.value })}
                    placeholder="질문 내용"
                    className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm"
                  />
                  <input
                    value={row.help_text ?? ""}
                    onChange={(e) =>
                      updateRow(i, { help_text: e.target.value || null })
                    }
                    placeholder="도움말 (선택)"
                    className="w-full rounded-lg border border-border bg-white px-3 py-2 text-xs text-muted"
                  />
                  {row.kind === "yes_no" && (
                    <div className="flex items-center gap-3 text-xs text-muted">
                      <span>통과 기준:</span>
                      <label className="flex items-center gap-1">
                        <input
                          type="radio"
                          name={`req-${i}`}
                          checked={row.validation_config.required_answer === true}
                          onChange={() => updateValidation(i, { required_answer: true })}
                          className="h-3.5 w-3.5 accent-primary"
                        />
                        예
                      </label>
                      <label className="flex items-center gap-1">
                        <input
                          type="radio"
                          name={`req-${i}`}
                          checked={row.validation_config.required_answer === false}
                          onChange={() => updateValidation(i, { required_answer: false })}
                          className="h-3.5 w-3.5 accent-primary"
                        />
                        아니오
                      </label>
                    </div>
                  )}
                  {row.kind === "numeric" && (
                    <div className="flex items-center gap-3 text-xs text-muted">
                      <label className="flex items-center gap-1">
                        최소
                        <input
                          type="number"
                          value={row.validation_config.min ?? ""}
                          onChange={(e) =>
                            updateValidation(i, {
                              min: e.target.value ? Number(e.target.value) : undefined,
                            })
                          }
                          className="w-20 rounded border border-border px-2 py-1 text-xs"
                        />
                      </label>
                      <label className="flex items-center gap-1">
                        최대
                        <input
                          type="number"
                          value={row.validation_config.max ?? ""}
                          onChange={(e) =>
                            updateValidation(i, {
                              max: e.target.value ? Number(e.target.value) : undefined,
                            })
                          }
                          className="w-20 rounded border border-border px-2 py-1 text-xs"
                        />
                      </label>
                      <label className="flex items-center gap-1">
                        <input
                          type="checkbox"
                          checked={row.validation_config.integer ?? false}
                          onChange={(e) =>
                            updateValidation(i, { integer: e.target.checked })
                          }
                          className="h-3.5 w-3.5 accent-primary"
                        />
                        정수만
                      </label>
                    </div>
                  )}
                  {(row.kind === "single_choice" || row.kind === "multi_choice") && (
                    <div className="space-y-1 text-xs text-muted">
                      <span>선택지 (한 줄에 하나)</span>
                      <textarea
                        value={(row.validation_config.options ?? []).join("\n")}
                        onChange={(e) =>
                          updateValidation(i, {
                            options: e.target.value
                              .split("\n")
                              .map((x) => x.trim())
                              .filter(Boolean),
                          })
                        }
                        rows={3}
                        className="w-full rounded border border-border px-2 py-1 font-mono text-xs"
                      />
                      <span>통과 선택지 (쉼표)</span>
                      <input
                        value={(row.validation_config.accepted ?? []).join(",")}
                        onChange={(e) =>
                          updateValidation(i, {
                            accepted: e.target.value
                              .split(",")
                              .map((x) => x.trim())
                              .filter(Boolean),
                          })
                        }
                        className="w-full rounded border border-border px-2 py-1 font-mono text-xs"
                      />
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => removeRow(i)}
                  className="text-muted hover:text-danger"
                  aria-label="삭제"
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <span className="text-xs text-muted">추가:</span>
        {(
          [
            ["yes_no", "예/아니오"],
            ["numeric", "숫자"],
            ["single_choice", "단일선택"],
            ["multi_choice", "복수선택"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => addRow(k)}
            className="rounded-full border border-border px-3 py-1 text-xs hover:bg-card"
          >
            + {label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          {savedAt && !dirty && (
            <span className="text-xs text-emerald-700">저장됨</span>
          )}
          <Button
            size="sm"
            onClick={save}
            disabled={saving || !dirty}
          >
            {saving ? "저장 중…" : "저장"}
          </Button>
        </div>
      </div>
    </div>
  );
}
