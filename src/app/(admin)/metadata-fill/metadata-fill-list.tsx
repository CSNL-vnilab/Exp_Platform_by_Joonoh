"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import type { ExperimentChecklistItem } from "@/types/database";

interface ExperimentRow {
  id: string;
  title: string;
  project_name: string | null | undefined;
  status: string;
  start_date: string;
  end_date: string;
  code_repo_url: string | null;
  data_path: string | null;
  pre_experiment_checklist: ExperimentChecklistItem[] | null;
  protocol_version: string | null;
  location_id: string | null;
  description: string | null;
  participation_fee: number | null;
  irb_document_url: string | null;
  recruitment_target: number | null;
}

interface LocationRow {
  id: string;
  name: string;
  address_lines: string[] | null;
}

interface FormState {
  code_repo_url: string;
  data_path: string;
  checklist_lines: string;
  protocol_version: string;
  location_id: string;
  description: string;
  participation_fee: string;
  irb_document_url: string;
  recruitment_target: string;
}

function seedForm(e: ExperimentRow): FormState {
  return {
    code_repo_url: e.code_repo_url ?? "",
    data_path: e.data_path ?? "",
    checklist_lines: (e.pre_experiment_checklist ?? [])
      .map((i) => i.item)
      .join("\n"),
    protocol_version: e.protocol_version ?? "",
    location_id: e.location_id ?? "",
    description: e.description ?? "",
    participation_fee:
      e.participation_fee != null ? String(e.participation_fee) : "",
    irb_document_url: e.irb_document_url ?? "",
    recruitment_target:
      e.recruitment_target != null ? String(e.recruitment_target) : "",
  };
}

export function MetadataFillList({
  experiments,
  locations,
  labIrbBaseUrl,
}: {
  experiments: ExperimentRow[];
  locations: LocationRow[];
  // Admin-registered lab-wide IRB URL (labs.irb_base_url). Per-card
  // "관리자 등록 IRB 사용" button copies this into the IRB input on
  // click; hidden when null.
  labIrbBaseUrl: string | null;
}) {
  const { toast } = useToast();
  const [forms, setForms] = useState<Record<string, FormState>>(() =>
    Object.fromEntries(experiments.map((e) => [e.id, seedForm(e)])),
  );
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  // Locally hide cards the researcher has opted out of (is_project=false)
  // — the server query also filters them out on the next page load.
  const [optedOutIds, setOptedOutIds] = useState<Set<string>>(new Set());
  const [optingOut, setOptingOut] = useState<Record<string, boolean>>({});

  const visible = experiments.filter((e) => !optedOutIds.has(e.id));

  if (visible.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted">
          비어 있는 메타데이터 항목이 있는 실험이 없습니다. 모두 입력 완료
          또는 면제 처리되었습니다. ✓
        </CardContent>
      </Card>
    );
  }

  function patch(id: string, key: keyof FormState, value: string) {
    setForms((prev) => ({ ...prev, [id]: { ...prev[id], [key]: value } }));
  }

  async function save(e: ExperimentRow) {
    const f = forms[e.id];
    // Build the partial — only send fields the researcher actually
    // populated (avoid clobbering with empties they didn't touch).
    const body: Record<string, unknown> = {};
    if (f.code_repo_url.trim()) body.code_repo_url = f.code_repo_url.trim();
    if (f.data_path.trim()) body.data_path = f.data_path.trim();
    if (f.protocol_version.trim()) body.protocol_version = f.protocol_version.trim();
    if (f.location_id) body.location_id = f.location_id;
    if (f.description.trim()) body.description = f.description.trim();
    if (f.irb_document_url.trim()) body.irb_document_url = f.irb_document_url.trim();
    if (f.participation_fee.trim() !== "") {
      const n = Number(f.participation_fee);
      if (!Number.isNaN(n) && n >= 0) body.participation_fee = n;
    }
    if (f.recruitment_target.trim() !== "") {
      const n = Number(f.recruitment_target);
      if (Number.isInteger(n) && n > 0) body.recruitment_target = n;
    }
    // Checklist: one item per line → [{question, required_answer:false}].
    // Researchers can later toggle 'required' from the experiment detail page.
    const lines = f.checklist_lines
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length > 0) {
      body.pre_experiment_checklist = lines.map((q) => ({
        item: q,
        required: false,
      } satisfies ExperimentChecklistItem));
    }

    if (Object.keys(body).length === 0) {
      toast("입력된 값이 없습니다.", "info");
      return;
    }

    setSaving((s) => ({ ...s, [e.id]: true }));
    try {
      const res = await fetch(`/api/experiments/${e.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(j?.error ?? "저장에 실패했습니다", "error");
        return;
      }
      setSavedIds((prev) => new Set(prev).add(e.id));
      toast(`저장 완료 — ${e.title}`, "success");
    } catch {
      toast("네트워크 오류가 발생했습니다", "error");
    } finally {
      setSaving((s) => ({ ...s, [e.id]: false }));
    }
  }

  async function optOut(e: ExperimentRow) {
    if (
      !confirm(
        `"${e.title}" 을(를) 프로젝트가 아닌 항목(pilot · 장비 테스트 등)으로\n표시하고 메타데이터 입력 안내에서 면제하시겠습니까?\n\n나중에 실험 상세 화면에서 다시 켤 수 있습니다.`,
      )
    ) {
      return;
    }
    setOptingOut((s) => ({ ...s, [e.id]: true }));
    try {
      const res = await fetch(`/api/experiments/${e.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_project: false }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(j?.error ?? "면제 처리 실패", "error");
        return;
      }
      setOptedOutIds((prev) => new Set(prev).add(e.id));
      toast(`면제 처리됨 — ${e.title}`, "success");
    } catch {
      toast("네트워크 오류가 발생했습니다", "error");
    } finally {
      setOptingOut((s) => ({ ...s, [e.id]: false }));
    }
  }

  return (
    <div className="space-y-6">
      {visible.map((e) => {
        const f = forms[e.id];
        const isSaving = !!saving[e.id];
        const isSaved = savedIds.has(e.id);
        const isOptingOut = !!optingOut[e.id];
        return (
          <Card key={e.id}>
            <CardContent className="space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold text-foreground">
                    {e.title}
                  </h2>
                  <p className="mt-0.5 text-xs text-muted">
                    {e.project_name ?? "-"} · {e.start_date} ~ {e.end_date} ·{" "}
                    {e.status}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={isOptingOut || isSaving}
                    onClick={() => optOut(e)}
                    title="pilot · 장비 테스트 등 정식 프로젝트가 아닌 항목으로 표시"
                  >
                    {isOptingOut ? "처리 중…" : "프로젝트 아님 (면제)"}
                  </Button>
                  {isSaved && (
                    <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700">
                      ✓ 저장됨
                    </span>
                  )}
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <Input
                  id={`code-${e.id}`}
                  label="분석 코드 저장소/디렉토리 (필수)"
                  placeholder="예: /Volumes/CSNL/analysis/exp6 또는 https://github.com/…"
                  value={f.code_repo_url}
                  onChange={(ev) => patch(e.id, "code_repo_url", ev.target.value)}
                />
                <Input
                  id={`data-${e.id}`}
                  label="원본 데이터 경로 (필수)"
                  placeholder="예: /Volumes/CSNL/data/exp6"
                  value={f.data_path}
                  onChange={(ev) => patch(e.id, "data_path", ev.target.value)}
                />
                <Input
                  id={`proto-${e.id}`}
                  label="프로토콜 버전"
                  placeholder="예: v1.0"
                  value={f.protocol_version}
                  onChange={(ev) => patch(e.id, "protocol_version", ev.target.value)}
                />
                <div>
                  <label
                    htmlFor={`loc-${e.id}`}
                    className="mb-1 block text-sm font-medium text-foreground"
                  >
                    장소
                  </label>
                  <select
                    id={`loc-${e.id}`}
                    value={f.location_id}
                    onChange={(ev) => patch(e.id, "location_id", ev.target.value)}
                    className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                  >
                    <option value="">선택 안 함</option>
                    {locations.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                </div>
                <Input
                  id={`fee-${e.id}`}
                  label="참여비 (원, 0 = 무료)"
                  type="number"
                  min={0}
                  step={1000}
                  value={f.participation_fee}
                  onChange={(ev) => patch(e.id, "participation_fee", ev.target.value)}
                />
                <Input
                  id={`recr-${e.id}`}
                  label="모집 인원 (총 참여자 수, 선택)"
                  type="number"
                  min={1}
                  placeholder="비워두면 무제한"
                  value={f.recruitment_target}
                  onChange={(ev) =>
                    patch(e.id, "recruitment_target", ev.target.value)
                  }
                />
                <div>
                  <Input
                    id={`irb-${e.id}`}
                    label="IRB 문서 URL"
                    type="url"
                    placeholder="https://…"
                    value={f.irb_document_url}
                    onChange={(ev) =>
                      patch(e.id, "irb_document_url", ev.target.value)
                    }
                  />
                  {labIrbBaseUrl && (
                    <button
                      type="button"
                      onClick={() => patch(e.id, "irb_document_url", labIrbBaseUrl)}
                      className="mt-1 inline-flex items-center gap-1 text-xs text-sky-700 underline-offset-2 hover:underline"
                      title={labIrbBaseUrl}
                    >
                      📎 관리자 등록 IRB 사용
                    </button>
                  )}
                </div>
              </div>

              <div>
                <label
                  htmlFor={`desc-${e.id}`}
                  className="mb-1 block text-sm font-medium text-foreground"
                >
                  실험 소개 (참여자에게 노출)
                </label>
                <textarea
                  id={`desc-${e.id}`}
                  rows={3}
                  value={f.description}
                  onChange={(ev) => patch(e.id, "description", ev.target.value)}
                  className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>

              <div>
                <label
                  htmlFor={`chk-${e.id}`}
                  className="mb-1 block text-sm font-medium text-foreground"
                >
                  사전 체크리스트 (한 줄당 한 항목)
                </label>
                <textarea
                  id={`chk-${e.id}`}
                  rows={3}
                  placeholder={"예:\n안경/렌즈 착용\n카페인 8시간 금지"}
                  value={f.checklist_lines}
                  onChange={(ev) =>
                    patch(e.id, "checklist_lines", ev.target.value)
                  }
                  className="w-full rounded-lg border border-border bg-white px-3 py-2 font-mono text-xs focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
                <p className="mt-1 text-xs text-muted">
                  저장 후 필수 답변 토글은 실험 상세 화면에서 조정합니다.
                </p>
              </div>

              <div className="flex justify-end">
                <Button onClick={() => save(e)} disabled={isSaving}>
                  {isSaving ? "저장 중…" : "이 실험 저장"}
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
