"use client";

// OfflineCodeAnalyzer
// ===================
// Drop-in editor section for an experiment's offline code.
// Pipeline:
//   1. Upload / paste code            → runHeuristic on the server
//   2. (optional) AI pass             → Qwen3.6-35B-A3B refines + fills gaps
//   3. mergeAnalysis(heuristic, ai, overrides) → editable UI
//   4. Save                           → PUT /experiments/[id]/offline-code
//                                       AND (when applicable) sync into
//                                       the experiment's parameter_schema
//
// The component is fully editable. Every cell shows its provenance
// (heuristic / AI / user) so the experimenter can tell what the model
// guessed vs. what they corrected. A side-panel chatbot is provided
// for messy code: it streams suggestions and emits <patch> blocks the
// user reviews + applies one-by-one.

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import {
  CodeAnalysisSchema,
  mergeAnalysis,
  SUPPORTED_FRAMEWORKS,
  SUPPORTED_GENRES,
  SUPPORTED_LANGS,
  type BlockPhase,
  type CodeAnalysis,
  type CodeAnalysisOverrides,
  type Factor,
  type Parameter,
  type SavedVariable,
} from "@/lib/experiments/code-analysis-schema";
import {
  applyPatch,
  parsePatchBlocks,
  summarisePatch,
  type Patch,
} from "@/lib/experiments/code-analysis-patch";
import type { ExperimentParameterSpec } from "@/types/database";

const SAVED_FORMATS = [
  "int",
  "float",
  "string",
  "bool",
  "array",
  "matrix",
  "struct",
  "csv-row",
  "json",
  "other",
] as const;

const PARAM_TYPES = ["number", "string", "boolean", "array", "other"] as const;
const FACTOR_TYPES = ["categorical", "continuous", "ordinal"] as const;

// ----- props -----------------------------------------------------------

export interface OfflineCodeAnalyzerInitial {
  code_excerpt: string | null;
  code_filename: string | null;
  code_lang: string | null;
  model: string | null;
  heuristic: CodeAnalysis | null;
  ai: CodeAnalysis | null;
  overrides: CodeAnalysisOverrides | null;
}

export interface OfflineCodeAnalyzerProps {
  // Existing experiment ID — when provided, the "저장" button persists
  // via PUT /api/experiments/[id]/offline-code. When omitted (new
  // experiment), the parent can pass `onChange` to capture state and
  // submit it together with the rest of the form.
  experimentId?: string | null;

  // Pre-existing analysis read from the experiment row.
  initial?: OfflineCodeAnalyzerInitial | null;

  // Initial source address (server path or git URL) — usually supplied
  // from `experiment.code_repo_url` so the analyzer can render an
  // "Re-analyze from source" button on the edit page.
  initialSource?: string | null;

  // Each merge step yields the new {heuristic, ai, overrides, merged}
  // — useful for the new-experiment page that doesn't have a row yet.
  onChange?: (state: {
    heuristic: CodeAnalysis | null;
    ai: CodeAnalysis | null;
    overrides: CodeAnalysisOverrides;
    merged: CodeAnalysis;
    code_excerpt: string | null;
    code_filename: string | null;
    code_lang: string | null;
    model: string | null;
  }) => void;

  // Reports the resolved source address back to the parent so the
  // experiment-form can keep `code_repo_url` in sync.
  onSourceChange?: (source: string | null) => void;

  // When set, "이 항목들을 실험 파라미터 스키마로 가져오기" populates
  // the experiment's existing parameter_schema editor.
  onApplyToParameterSchema?: (params: ExperimentParameterSpec[]) => void;
}

// ----- helpers ---------------------------------------------------------

function provenanceFor(
  field: string,
  key: string,
  heuristic: CodeAnalysis | null,
  ai: CodeAnalysis | null,
  overrides: CodeAnalysisOverrides,
): "user" | "ai" | "heuristic" | "missing" {
  // factor/param/etc lookup by name
  const inList = (a: CodeAnalysis | null | undefined): boolean => {
    if (!a) return false;
    const list = (a as unknown as Record<string, Array<{ name?: string; label?: string }>>)[field];
    if (!Array.isArray(list)) return false;
    return list.some((x) => x.name === key || x.label === key);
  };
  const overList = overrides[field as keyof CodeAnalysis] as
    | Array<{ name?: string; label?: string }>
    | undefined;
  if (Array.isArray(overList) && overList.some((x) => x.name === key || x.label === key)) {
    return "user";
  }
  if (inList(ai)) return "ai";
  if (inList(heuristic)) return "heuristic";
  return "missing";
}

function ProvBadge({
  source,
}: {
  source: "user" | "ai" | "heuristic" | "missing";
}) {
  const map: Record<typeof source, { label: string; variant: "default" | "info" | "warning" | "success" }> = {
    user: { label: "사용자", variant: "success" },
    ai: { label: "AI", variant: "info" },
    heuristic: { label: "휴리스틱", variant: "warning" },
    missing: { label: "—", variant: "default" },
  };
  const { label, variant } = map[source];
  return <Badge variant={variant}>{label}</Badge>;
}

// ----- component -------------------------------------------------------

export function OfflineCodeAnalyzer({
  experimentId,
  initial,
  initialSource,
  onChange,
  onSourceChange,
  onApplyToParameterSchema,
}: OfflineCodeAnalyzerProps) {
  const { toast } = useToast();

  // ---- state ----------------------------------------------------------
  const [code, setCode] = useState<string>(initial?.code_excerpt ?? "");
  const [filename, setFilename] = useState<string | null>(initial?.code_filename ?? null);
  const [lang, setLang] = useState<string | null>(initial?.code_lang ?? null);
  const [model, setModel] = useState<string | null>(initial?.model ?? null);
  const [heuristic, setHeuristic] = useState<CodeAnalysis | null>(initial?.heuristic ?? null);
  const [ai, setAi] = useState<CodeAnalysis | null>(initial?.ai ?? null);
  const [overrides, setOverrides] = useState<CodeAnalysisOverrides>(
    initial?.overrides ?? {},
  );
  const [analyzing, setAnalyzing] = useState(false);
  const [savingDb, setSavingDb] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  // Multi-file (zip) inputs. When non-empty the analyzer sends
  // `{files, docs}` to the API instead of `{code}`.
  const [bundleFiles, setBundleFiles] = useState<Array<{ path: string; content: string }>>([]);
  const [docsText, setDocsText] = useState<string>("");
  const [bundleInfo, setBundleInfo] = useState<{
    entry: string | null;
    selected: Array<{ path: string; role: string; bytes: number; truncated: boolean }>;
    dropped: Array<{ path: string; reason: string }>;
    totalChars: number;
  } | null>(null);

  // Source-driven flow: enter a server path or GitHub URL, server
  // fetches the tree, bundles, and analyzes. Replaces the manual
  // code_repo_url + data_path inputs.
  const [source, setSource] = useState<string>(initialSource ?? "");
  const [sourceKind, setSourceKind] = useState<"auto" | "server-path" | "github">("auto");
  const [entryHint, setEntryHint] = useState<string>("");
  const [docsPath, setDocsPath] = useState<string>("");
  const [sourceInfo, setSourceInfo] = useState<{
    kind: string;
    root: string;
    fileCount: number;
    truncated?: boolean;
    docsResolved?: string;
    docsBytes?: number;
  } | null>(null);
  // Show the legacy manual paste / drag-drop block on demand.
  const [manualOpen, setManualOpen] = useState<boolean>(!!initial?.code_excerpt);

  useEffect(() => {
    onSourceChange?.(source.trim() || null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  const merged = useMemo(
    () => mergeAnalysis(heuristic, ai, overrides),
    [heuristic, ai, overrides],
  );

  useEffect(() => {
    onChange?.({
      heuristic,
      ai,
      overrides,
      merged,
      code_excerpt: code || null,
      code_filename: filename,
      code_lang: lang,
      model,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify({ heuristic, ai, overrides, code, filename, lang, model })]);

  // ---- analysis trigger -----------------------------------------------
  const runAnalysis = async (mode: "heuristic" | "ai" | "both") => {
    const useBundle = bundleFiles.length > 0;
    if (!useBundle && !code.trim()) {
      toast("분석할 코드가 비어 있습니다", "error");
      return;
    }
    setAnalyzing(true);
    try {
      const body = useBundle
        ? { files: bundleFiles, docs: docsText || null, mode }
        : { code, filename, docs: docsText || null, mode };
      const res = await fetch("/api/experiments/code-analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) {
        toast(json.error ?? "분석 실패", "error");
        if (json.heuristic) setHeuristic(json.heuristic);
        if (json.bundle) setBundleInfo(json.bundle);
        return;
      }
      setHeuristic(json.heuristic);
      setAi(json.ai);
      setModel(json.model ?? "heuristic");
      if (json.bundle) {
        setBundleInfo(json.bundle);
        // When bundle was used, expose the bundled text in the
        // textarea (truncated) so the chatbot has the same context as
        // the analyzer.
        if (json.bundle.entry) setFilename(json.bundle.entry);
      }
      if (json.heuristic?.meta?.language) setLang(json.heuristic.meta.language);
      toast("분석 완료", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "분석 실패", "error");
    } finally {
      setAnalyzing(false);
    }
  };

  // ---- source-driven analysis -----------------------------------------
  const runFromSource = async (mode: "heuristic" | "ai" | "both") => {
    if (!source.trim()) {
      toast("소스 주소(서버 경로 또는 GitHub URL)를 입력하세요", "error");
      return;
    }
    setAnalyzing(true);
    try {
      const res = await fetch("/api/experiments/code-analysis/from-source", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: source.trim(),
          kind: sourceKind,
          entry: entryHint.trim() || null,
          docs: docsText || null,
          docsPath: docsPath.trim() || null,
          mode,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast(json.error ?? "분석 실패", "error");
        if (json.heuristic) setHeuristic(json.heuristic);
        if (json.bundle) setBundleInfo(json.bundle);
        if (json.source) setSourceInfo(json.source);
        return;
      }
      setHeuristic(json.heuristic);
      setAi(json.ai);
      setModel(json.model ?? "heuristic");
      setBundleInfo(json.bundle);
      setSourceInfo(json.source);
      if (json.heuristic?.meta?.language) setLang(json.heuristic.meta.language);
      // Stash the resolved bundle so the chatbot has the same context
      // and so it survives a re-render. The `code` state shows a
      // collapsed badge — full content is available via merged.
      if (json.resolved?.code) setCode(json.resolved.code);
      if (json.resolved?.docs && !docsText) setDocsText(json.resolved.docs);
      if (json.bundle?.entry) setFilename(json.bundle.entry);
      const docsNote =
        json.source?.docsResolved && json.source.docsResolved !== "none"
          ? ` · 문서 ${json.source.docsResolved === "auto" ? "자동 감지" : "지정"}됨 (${json.source.docsBytes.toLocaleString()}자)`
          : "";
      toast(
        `분석 완료 — ${json.bundle?.selected?.length ?? 0}개 파일 번들${docsNote}`,
        "success",
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : "분석 실패", "error");
    } finally {
      setAnalyzing(false);
    }
  };

  // ---- file drop ------------------------------------------------------
  const TEXT_EXT_RE = /\.(m|py|js|mjs|ts|tsx|jsx|r|txt|md|json|yml|yaml|cfg|ini)$/i;

  const ingestZip = async (file: File) => {
    // jszip is already a project dep — used for export bundles.
    const JSZip = (await import("jszip")).default;
    const buf = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(buf);
    const out: Array<{ path: string; content: string }> = [];
    let totalSize = 0;
    const entries = Object.entries(zip.files);
    for (const [path, entry] of entries) {
      if (entry.dir) continue;
      if (!TEXT_EXT_RE.test(path)) continue;
      if (path.includes("__MACOSX/")) continue;
      const content = await entry.async("string");
      totalSize += content.length;
      // safety cap — we'll let the server bundler trim, but protect
      // browser memory from a runaway upload.
      if (totalSize > 5_000_000) {
        toast(`업로드 총량이 5MB 를 넘어 일부 파일만 사용됩니다 (${out.length}개 포함)`, "info");
        break;
      }
      out.push({ path, content });
    }
    return out;
  };

  const ingestFiles = async (files: FileList | File[]) => {
    const arr = Array.from(files);
    if (arr.length === 1 && /\.zip$/i.test(arr[0].name)) {
      const list = await ingestZip(arr[0]);
      setBundleFiles(list);
      setFilename(arr[0].name);
      setCode("");
      setBundleInfo(null);
      toast(`zip 에서 ${list.length}개 코드 파일을 로드했습니다`, "success");
      return;
    }
    if (arr.length > 1) {
      const out: Array<{ path: string; content: string }> = [];
      for (const f of arr) {
        if (!TEXT_EXT_RE.test(f.name)) continue;
        out.push({ path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, content: await f.text() });
      }
      setBundleFiles(out);
      setFilename(out[0]?.path ?? null);
      setCode("");
      setBundleInfo(null);
      toast(`${out.length}개 파일을 로드했습니다`, "success");
      return;
    }
    // single file → original behavior
    const f = arr[0];
    if (!f) return;
    if (f.size > 200_000) {
      toast("파일이 200KB 를 초과합니다 — 일부만 사용됩니다", "info");
    }
    setBundleFiles([]);
    setBundleInfo(null);
    const text = await f.text();
    setCode(text.slice(0, 200_000));
    setFilename(f.name);
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.dataTransfer.files?.length) void ingestFiles(e.dataTransfer.files);
  };

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) void ingestFiles(e.target.files);
  };

  // ---- override mutators ---------------------------------------------
  const setMeta = <K extends keyof CodeAnalysis["meta"]>(
    key: K,
    value: CodeAnalysis["meta"][K] | null,
  ) => {
    setOverrides((prev) => ({
      ...prev,
      meta: { ...(prev.meta ?? {}), [key]: value },
    }));
  };

  const upsertFactor = (idx: number, patch: Partial<Factor>) => {
    const list = merged.factors.slice();
    const target = list[idx];
    if (!target) return;
    const next: Factor = { ...target, ...patch };
    list[idx] = next;
    setOverrides((prev) => ({
      ...prev,
      factors: replaceByName(prev.factors, target.name, next),
    }));
  };
  const removeFactor = (name: string) => {
    setOverrides((prev) => ({
      ...prev,
      factors: [...(prev.factors ?? []).filter((f) => f.name !== name), {
        name,
        type: "categorical",
        levels: [],
        role: "unknown",
        description: "__REMOVED__",
        line_hint: null,
      }],
    }));
    // simpler: drop from merged via overrides removal — but since we
    // only track adds in overrides, we instead push a sentinel that the
    // merge ignores. Easier path: use a removed-set state.
  };

  // simplification: track removed-keys explicitly. we keep `overrides`
  // as a positive layer plus separate removal sets so the heuristic/AI
  // layers can be excluded cleanly.
  const [removedFactors, setRemovedFactors] = useState<Set<string>>(new Set());
  const [removedParams, setRemovedParams] = useState<Set<string>>(new Set());
  const [removedConds, setRemovedConds] = useState<Set<string>>(new Set());
  const [removedSaved, setRemovedSaved] = useState<Set<string>>(new Set());

  const visibleFactors = merged.factors.filter((f) => !removedFactors.has(f.name));
  const visibleParams = merged.parameters.filter((p) => !removedParams.has(p.name));
  const visibleConds = merged.conditions.filter((c) => !removedConds.has(c.label));
  const visibleSaved = merged.saved_variables.filter((s) => !removedSaved.has(s.name));

  // ---- save -----------------------------------------------------------
  const saveToDb = async () => {
    if (!experimentId) return;
    setSavingDb(true);
    try {
      const res = await fetch(`/api/experiments/${experimentId}/offline-code`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code_excerpt: code || null,
          code_filename: filename,
          code_lang: lang,
          model,
          heuristic,
          ai,
          overrides: stripRemoved(overrides, {
            factors: removedFactors,
            parameters: removedParams,
            conditions: removedConds,
            saved_variables: removedSaved,
          }),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast(json.error ?? "저장 실패", "error");
        return;
      }
      toast("실험에 저장되었습니다", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "저장 실패", "error");
    } finally {
      setSavingDb(false);
    }
  };

  const importToParamSchema = () => {
    if (!onApplyToParameterSchema) return;
    const out: ExperimentParameterSpec[] = visibleParams
      .map((p) => {
        const key = sanitizeParamKey(p.name);
        if (!key) return null;
        if (p.type === "number" || p.type === "string") {
          return {
            key,
            type: p.type,
            default: parseDefault(p.default, p.type),
          } as ExperimentParameterSpec;
        }
        return { key, type: "string", default: p.default ?? null } as ExperimentParameterSpec;
      })
      .filter(Boolean) as ExperimentParameterSpec[];
    onApplyToParameterSchema(out);
    toast(`${out.length}개 파라미터를 실험 스키마로 가져왔습니다`, "success");
  };

  // ---- chatbot --------------------------------------------------------
  type ChatTurn = { role: "user" | "assistant"; content: string; pending?: boolean };
  const [chatHistory, setChatHistory] = useState<ChatTurn[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatStreaming, setChatStreaming] = useState(false);
  const [pendingPatches, setPendingPatches] = useState<
    Array<{ id: number; patch: Patch; summary: string }>
  >([]);
  const patchIdRef = useRef(0);

  const sendChat = async () => {
    if (!chatInput.trim() || chatStreaming) return;
    if (!code.trim()) {
      toast("코드를 먼저 업로드/붙여넣기 하세요", "error");
      return;
    }
    const user_message = chatInput.trim();
    setChatInput("");
    const baseHistory = [...chatHistory, { role: "user" as const, content: user_message }];
    const next: ChatTurn[] = [...baseHistory, { role: "assistant", content: "", pending: true }];
    setChatHistory(next);
    setChatStreaming(true);
    try {
      const res = await fetch("/api/experiments/code-analysis/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          filename,
          current: merged,
          messages: chatHistory,
          user_message,
        }),
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({}));
        toast(err.error ?? `채팅 실패 (${res.status})`, "error");
        setChatHistory(baseHistory);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        setChatHistory([
          ...baseHistory,
          { role: "assistant", content: buf, pending: true },
        ]);
      }
      // parse patches from final
      const { prose, blocks } = parsePatchBlocks(buf);
      setChatHistory([...baseHistory, { role: "assistant", content: prose.trim() || buf }]);
      const newPatches = blocks
        .filter((b) => b.patch)
        .map((b) => ({
          id: ++patchIdRef.current,
          patch: b.patch!,
          summary: summarisePatch(b.patch!),
        }));
      if (newPatches.length > 0) {
        setPendingPatches((prev) => [...prev, ...newPatches]);
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : "채팅 실패", "error");
      setChatHistory(baseHistory);
    } finally {
      setChatStreaming(false);
    }
  };

  const acceptPatch = (id: number) => {
    const target = pendingPatches.find((p) => p.id === id);
    if (!target) return;
    setOverrides((prev) => applyPatch(prev, target.patch));
    setPendingPatches((prev) => prev.filter((p) => p.id !== id));
  };
  const rejectPatch = (id: number) =>
    setPendingPatches((prev) => prev.filter((p) => p.id !== id));
  const acceptAllPatches = () => {
    let next = overrides;
    for (const p of pendingPatches) next = applyPatch(next, p.patch);
    setOverrides(next);
    setPendingPatches([]);
  };

  // ---- render ---------------------------------------------------------
  const hasAnalysis = !!(heuristic || ai);

  return (
    <Card className="lg:col-span-2">
      <CardContent>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-foreground">
              오프라인 실험 코드 자동 분석
            </h2>
            <p className="mt-1 text-xs text-muted">
              실험 코드 + 라이브러리가 있는 서버 경로 또는 GitHub URL 만 알려주면,
              서버가 트리를 받아 핵심 파일을 추리고 휴리스틱 + Qwen 으로 메타데이터를
              뽑아 표로 보여줍니다. 데이터 디렉토리·파라미터 스키마 같은 항목을
              일일이 입력할 필요가 없으며, 모든 추출 결과는 직접 수정 가능하고,
              우측 챗봇으로 모호한 부분을 대화로 확정할 수 있습니다.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {model && (
              <span className="rounded-full bg-card px-2 py-0.5 text-[11px] text-muted">
                model: {model}
              </span>
            )}
            <Button
              variant={chatOpen ? "primary" : "secondary"}
              size="sm"
              onClick={() => setChatOpen((o) => !o)}
              type="button"
            >
              {chatOpen ? "챗봇 닫기" : "챗봇 열기"}
            </Button>
          </div>
        </div>

        <div className="mt-4 grid gap-6 lg:grid-cols-[1fr_320px]">
          {/* main column */}
          <div className="min-w-0 space-y-6">
            {/* source-driven (primary input) */}
            <div className="rounded-lg border border-border bg-white p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-sm font-semibold">소스 주소</h3>
                <span className="text-[11px] text-muted">
                  서버 절대 경로 또는 GitHub URL
                </span>
              </div>
              <p className="mt-1 text-[11px] text-muted">
                연구자가 코드와 라이브러리를 어디에 두었는지만 알려주면, 서버가 트리를
                받아 핵심 파일만 골라 분석합니다 — 데이터 디렉토리·결과 디렉토리 같은
                수동 입력은 더 이상 필요 없습니다.
              </p>
              <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]">
                <input
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  placeholder="예: /Volumes/CSNL_new-1/people/JOP/Magnitude/Experiment 또는 https://github.com/owner/repo#branch"
                  className={inputCls}
                />
                <select
                  value={sourceKind}
                  onChange={(e) =>
                    setSourceKind(e.target.value as "auto" | "server-path" | "github")
                  }
                  className={inputCls + " sm:w-32"}
                >
                  <option value="auto">자동 감지</option>
                  <option value="server-path">서버 경로</option>
                  <option value="github">GitHub</option>
                </select>
              </div>
              <details className="mt-2">
                <summary className="cursor-pointer text-[11px] text-muted hover:text-foreground">
                  고급 옵션 (엔트리 파일 / 문서 경로 명시)
                </summary>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <div>
                    <label className="text-[11px] text-muted">엔트리 파일 (선택)</label>
                    <input
                      value={entryHint}
                      onChange={(e) => setEntryHint(e.target.value)}
                      placeholder="예: main_duration.m (기본은 main_*/run_*/index 자동 감지)"
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label className="text-[11px] text-muted">참고 문서 경로 (선택)</label>
                    <input
                      value={docsPath}
                      onChange={(e) => setDocsPath(e.target.value)}
                      placeholder="예: summary.MD (root 의 README/summary 는 자동 감지)"
                      className={inputCls}
                    />
                  </div>
                </div>
              </details>
              <div className="mt-3">
                <label className="text-[11px] text-muted">
                  참고 문서 직접 입력 (선택) — README/summary 가 없거나 보강하고 싶을 때
                </label>
                <textarea
                  value={docsText}
                  onChange={(e) => setDocsText(e.target.value.slice(0, 50_000))}
                  placeholder="예: Exp1은 reproduction-only. 핵심 IV는 dist (U/A/B), day, subjNum mod 4 패턴…"
                  rows={3}
                  className={inputCls + " font-mono"}
                />
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => runFromSource("both")}
                  disabled={analyzing || !source.trim()}
                >
                  {analyzing ? "분석 중…" : "소스에서 분석 실행"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => runFromSource("heuristic")}
                  disabled={analyzing || !source.trim()}
                >
                  휴리스틱만 (빠름)
                </Button>
                <span className="text-[11px] text-muted">
                  서버에서 git clone / 디렉토리 스캔 후 자동으로 핵심 파일만 추려 분석합니다.
                </span>
              </div>

              {sourceInfo && (
                <div className="mt-3 rounded border border-blue-200 bg-blue-50 p-2 text-[11px] text-blue-900">
                  <div>
                    소스: <code className="break-all">{sourceInfo.root}</code> · 종류{" "}
                    <code>{sourceInfo.kind}</code> · {sourceInfo.fileCount}개 파일 fetched
                    {sourceInfo.truncated && <span className="ml-1 text-amber-700">(예산 초과 — 일부 잘림)</span>}
                  </div>
                  {sourceInfo.docsResolved && sourceInfo.docsResolved !== "none" && (
                    <div className="text-blue-700/80">
                      문서: {sourceInfo.docsResolved === "auto" ? "자동 감지" : sourceInfo.docsResolved}{" "}
                      ({sourceInfo.docsBytes?.toLocaleString()}자)
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* manual paste / drag-drop (fallback) */}
            <details
              className="rounded-lg border border-dashed border-border bg-card/30 p-3"
              open={manualOpen}
              onToggle={(e) => setManualOpen((e.target as HTMLDetailsElement).open)}
            >
              <summary className="cursor-pointer text-xs font-medium text-muted hover:text-foreground">
                수동 입력 (붙여넣기 / 파일 / zip / 폴더) — 소스 주소를 쓸 수 없는 경우
              </summary>
              <div className="mt-3">
            {/* upload */}
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={onDrop}
              className="rounded-lg border-2 border-dashed border-border bg-card/40 p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm">
                  <span className="font-medium">실험 코드</span>
                  <span className="ml-2 text-xs text-muted">
                    .zip / 폴더 다중 선택 / 단일 .py·.m·.js·.r 모두 지원 — 드래그&드롭 또는 붙여넣기
                  </span>
                  {filename && (
                    <span className="ml-2 rounded bg-card px-1.5 py-0.5 text-[11px] text-foreground">
                      {bundleFiles.length > 0
                        ? `${filename} · ${bundleFiles.length}개 파일`
                        : filename}
                    </span>
                  )}
                </div>
                <div className="flex gap-2">
                  <label className="cursor-pointer rounded-lg border border-border bg-white px-3 py-1.5 text-xs hover:bg-card">
                    파일/zip 선택
                    <input
                      type="file"
                      className="hidden"
                      accept=".zip,.py,.m,.js,.mjs,.ts,.tsx,.r,.txt,.md"
                      onChange={onPick}
                    />
                  </label>
                  <label className="cursor-pointer rounded-lg border border-border bg-white px-3 py-1.5 text-xs hover:bg-card">
                    폴더 선택
                    <input
                      type="file"
                      className="hidden"
                      multiple
                      // @ts-expect-error - non-standard but widely supported
                      webkitdirectory=""
                      directory=""
                      onChange={onPick}
                    />
                  </label>
                </div>
              </div>

              {bundleFiles.length === 0 ? (
                <textarea
                  value={code}
                  onChange={(e) => setCode(e.target.value.slice(0, 200_000))}
                  placeholder="여기에 코드를 붙여넣기 하거나 위 영역으로 파일/zip 을 드래그하세요…"
                  rows={6}
                  className="mt-3 block w-full resize-y rounded-lg border border-border bg-white px-3 py-2 font-mono text-xs text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              ) : (
                <div className="mt-3 max-h-32 overflow-y-auto rounded-lg border border-border bg-white p-2 font-mono text-[11px]">
                  {bundleFiles.slice(0, 80).map((f) => (
                    <div key={f.path} className="truncate text-foreground/80">
                      {f.path}{" "}
                      <span className="text-muted">({f.content.length.toLocaleString()}자)</span>
                    </div>
                  ))}
                  {bundleFiles.length > 80 && (
                    <div className="text-muted">… 외 {bundleFiles.length - 80}개</div>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setBundleFiles([]);
                      setBundleInfo(null);
                      setFilename(null);
                    }}
                    className="mt-2 text-xs text-danger hover:underline"
                  >
                    번들 해제 → 단일 코드 입력으로 전환
                  </button>
                </div>
              )}

              {/* docs textarea — README/summary/protocol 등 */}
              <div className="mt-3">
                <label className="text-xs font-medium text-foreground">
                  참고 문서 (README / summary / IRB 프로토콜) — 선택
                </label>
                <p className="text-[11px] text-muted">
                  연구자가 작성한 설명을 함께 입력하면 AI가 IV/조건 식별 정확도가 크게 올라갑니다.
                  코드와 충돌 시 문서를 우선 신뢰합니다 (최대 50,000자).
                </p>
                <textarea
                  value={docsText}
                  onChange={(e) => setDocsText(e.target.value.slice(0, 50_000))}
                  placeholder="예: Exp1은 reproduction-only. 핵심 IV는 dist (U/A/B)이며 day와 subjNum mod 4 패턴으로 결정 …"
                  rows={3}
                  className="mt-1 block w-full resize-y rounded-lg border border-border bg-white px-3 py-2 text-xs focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => runAnalysis("heuristic")}
                  disabled={analyzing || (!code.trim() && bundleFiles.length === 0)}
                >
                  휴리스틱만 (즉시)
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => runAnalysis("both")}
                  disabled={analyzing || (!code.trim() && bundleFiles.length === 0)}
                >
                  {analyzing ? "분석 중…" : "AI 분석 실행 (Qwen)"}
                </Button>
                <span className="text-[11px] text-muted">
                  단일 파일 200KB / 번들 80,000자까지 AI 분석에 사용됩니다.
                </span>
              </div>

              {bundleInfo && bundleInfo.entry && (
                <div className="mt-3 rounded border border-blue-200 bg-blue-50 p-2 text-[11px]">
                  <div className="font-medium text-blue-900">
                    엔트리: <code>{bundleInfo.entry}</code> · 선택 {bundleInfo.selected.length}개 ·{" "}
                    번들 크기 {bundleInfo.totalChars.toLocaleString()}자
                  </div>
                  <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono">
                    {bundleInfo.selected.map((s) => (
                      <div key={s.path} className="truncate text-blue-900/80">
                        <span
                          className={`mr-1 inline-block w-12 text-[10px] ${
                            s.role === "entry"
                              ? "text-blue-900 font-bold"
                              : s.role === "config"
                                ? "text-purple-700"
                                : "text-blue-700"
                          }`}
                        >
                          {s.role}
                        </span>
                        {s.path}
                        {s.truncated && <span className="ml-1 text-amber-700">(잘림)</span>}
                      </div>
                    ))}
                  </div>
                  {bundleInfo.dropped.length > 0 && (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-[10px] text-blue-700">
                        제외된 {bundleInfo.dropped.length}개 보기
                      </summary>
                      <div className="mt-1 max-h-32 overflow-y-auto font-mono text-[10px] text-blue-700/70">
                        {bundleInfo.dropped.map((d, i) => (
                          <div key={i} className="truncate">
                            {d.path} <span className="text-blue-700/50">— {d.reason}</span>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              )}
            </div>
              </div>
            </details>

            {hasAnalysis && (
              <>
                {/* warnings */}
                {merged.warnings.length > 0 && (
                  <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
                    <div className="mb-1 font-medium">분석 경고</div>
                    <ul className="list-disc space-y-0.5 pl-5">
                      {merged.warnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* meta */}
                <section>
                  <h3 className="mb-2 text-sm font-semibold">실험 구조 메타</h3>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    <MetaCell
                      label="언어"
                      value={merged.meta.language}
                      onChange={(v) => setMeta("language", v as CodeAnalysis["meta"]["language"])}
                      options={SUPPORTED_LANGS as readonly string[]}
                    />
                    <MetaCell
                      label="프레임워크"
                      value={merged.meta.framework}
                      onChange={(v) => setMeta("framework", v as CodeAnalysis["meta"]["framework"])}
                      options={SUPPORTED_FRAMEWORKS as readonly string[]}
                    />
                    <MetaNumber
                      label="블럭 수 (n_blocks)"
                      value={merged.meta.n_blocks}
                      onChange={(v) => setMeta("n_blocks", v)}
                    />
                    <MetaNumber
                      label="블럭당 트라이얼"
                      value={merged.meta.n_trials_per_block}
                      onChange={(v) => setMeta("n_trials_per_block", v)}
                    />
                    <MetaNumber
                      label="총 트라이얼"
                      value={merged.meta.total_trials}
                      onChange={(v) => setMeta("total_trials", v)}
                    />
                    <MetaNumber
                      label="예상 시간(분)"
                      value={merged.meta.estimated_duration_min}
                      onChange={(v) => setMeta("estimated_duration_min", v)}
                    />
                    <MetaText
                      label="seed"
                      value={merged.meta.seed}
                      onChange={(v) => setMeta("seed", v)}
                    />
                    <MetaCell
                      label="장르 (domain genre)"
                      value={merged.meta.domain_genre ?? "other"}
                      onChange={(v) => setMeta("domain_genre", v as CodeAnalysis["meta"]["domain_genre"])}
                      options={SUPPORTED_GENRES as readonly string[]}
                    />
                  </div>
                  <div className="mt-3">
                    <label className="text-[11px] text-muted">
                      디자인 매트릭스 (피험자/세션 별 IV 배정 패턴 — 자유서술)
                    </label>
                    <textarea
                      value={merged.meta.design_matrix ?? ""}
                      onChange={(e) =>
                        setMeta("design_matrix", e.target.value || null)
                      }
                      placeholder="예: subjNum mod 4 → AABB / ABBA / BABA / BBAA pattern across days"
                      rows={2}
                      className={inputCls + " font-mono"}
                    />
                  </div>
                </section>

                {/* block phases */}
                <Section
                  title="Block phases (실험 구조 분해)"
                  hint="한 세션에 phase 가 여럿 (training / test / stair / practice / main 등) 이거나 day 별로 다른 경우. 단일 phase 면 비어있어도 괜찮음."
                  onAdd={() =>
                    setOverrides((prev) => ({
                      ...prev,
                      meta: {
                        ...(prev.meta ?? {}),
                        block_phases: [
                          ...(prev.meta?.block_phases ?? merged.meta.block_phases ?? []),
                          {
                            kind: "main",
                            label: null,
                            n_blocks: null,
                            n_trials_per_block: null,
                            day_range: null,
                            applies_when: null,
                            description: null,
                          },
                        ],
                      },
                    }))
                  }
                >
                  {(merged.meta.block_phases ?? []).length === 0 ? (
                    <Empty>등록된 phase 가 없습니다 (단일 phase 실험)</Empty>
                  ) : (
                    <table className="w-full text-xs">
                      <thead className="text-left text-muted">
                        <tr>
                          <Th>kind</Th>
                          <Th>label</Th>
                          <Th>n_blocks</Th>
                          <Th>n_trials/block</Th>
                          <Th>day_range</Th>
                          <Th>applies_when</Th>
                          <Th>{""}</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {(merged.meta.block_phases ?? []).map((p, idx) => (
                          <tr key={idx} className="border-t border-border">
                            <Td>
                              <select
                                value={p.kind}
                                onChange={(e) =>
                                  setOverrides((prev) => ({
                                    ...prev,
                                    meta: {
                                      ...(prev.meta ?? {}),
                                      block_phases: replaceAt(
                                        merged.meta.block_phases ?? [],
                                        idx,
                                        { ...p, kind: e.target.value as BlockPhase["kind"] },
                                      ),
                                    },
                                  }))
                                }
                                className={inputCls}
                              >
                                {[
                                  "training",
                                  "practice",
                                  "stair",
                                  "main",
                                  "test",
                                  "transfer",
                                  "rest",
                                  "demo",
                                  "other",
                                ].map((k) => (
                                  <option key={k} value={k}>
                                    {k}
                                  </option>
                                ))}
                              </select>
                            </Td>
                            <Td>
                              <input
                                value={p.label ?? ""}
                                onChange={(e) =>
                                  setOverrides((prev) => ({
                                    ...prev,
                                    meta: {
                                      ...(prev.meta ?? {}),
                                      block_phases: replaceAt(merged.meta.block_phases ?? [], idx, {
                                        ...p,
                                        label: e.target.value || null,
                                      }),
                                    },
                                  }))
                                }
                                className={inputCls}
                              />
                            </Td>
                            <Td>
                              <input
                                type="number"
                                value={p.n_blocks ?? ""}
                                onChange={(e) =>
                                  setOverrides((prev) => ({
                                    ...prev,
                                    meta: {
                                      ...(prev.meta ?? {}),
                                      block_phases: replaceAt(merged.meta.block_phases ?? [], idx, {
                                        ...p,
                                        n_blocks: e.target.value === "" ? null : Number(e.target.value),
                                      }),
                                    },
                                  }))
                                }
                                className={inputCls}
                              />
                            </Td>
                            <Td>
                              <input
                                type="number"
                                value={p.n_trials_per_block ?? ""}
                                onChange={(e) =>
                                  setOverrides((prev) => ({
                                    ...prev,
                                    meta: {
                                      ...(prev.meta ?? {}),
                                      block_phases: replaceAt(merged.meta.block_phases ?? [], idx, {
                                        ...p,
                                        n_trials_per_block:
                                          e.target.value === "" ? null : Number(e.target.value),
                                      }),
                                    },
                                  }))
                                }
                                className={inputCls}
                              />
                            </Td>
                            <Td>
                              <input
                                value={p.day_range ?? ""}
                                onChange={(e) =>
                                  setOverrides((prev) => ({
                                    ...prev,
                                    meta: {
                                      ...(prev.meta ?? {}),
                                      block_phases: replaceAt(merged.meta.block_phases ?? [], idx, {
                                        ...p,
                                        day_range: e.target.value || null,
                                      }),
                                    },
                                  }))
                                }
                                placeholder="1, 2-5"
                                className={inputCls}
                              />
                            </Td>
                            <Td>
                              <input
                                value={p.applies_when ?? ""}
                                onChange={(e) =>
                                  setOverrides((prev) => ({
                                    ...prev,
                                    meta: {
                                      ...(prev.meta ?? {}),
                                      block_phases: replaceAt(merged.meta.block_phases ?? [], idx, {
                                        ...p,
                                        applies_when: e.target.value || null,
                                      }),
                                    },
                                  }))
                                }
                                placeholder="par.day == 1"
                                className={inputCls}
                              />
                            </Td>
                            <Td>
                              <RemoveBtn
                                onClick={() =>
                                  setOverrides((prev) => ({
                                    ...prev,
                                    meta: {
                                      ...(prev.meta ?? {}),
                                      block_phases: (merged.meta.block_phases ?? []).filter(
                                        (_, i) => i !== idx,
                                      ),
                                    },
                                  }))
                                }
                              />
                            </Td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </Section>

                {/* factors */}
                <Section
                  title="조작 변수 (Independent Variables / factors)"
                  hint="실험에서 의도적으로 조작되는 IV. 하나의 요인은 여러 수준(level)을 갖습니다."
                  onAdd={() =>
                    setOverrides((prev) => ({
                      ...prev,
                      factors: [
                        ...(prev.factors ?? []),
                        {
                          name: "new_factor",
                          type: "categorical",
                          levels: [],
                          role: "unknown",
                          description: null,
                          line_hint: null,
                        },
                      ],
                    }))
                  }
                >
                  {visibleFactors.length === 0 ? (
                    <Empty>등록된 조작 변수가 없습니다</Empty>
                  ) : (
                    <table className="w-full text-xs">
                      <thead className="text-left text-muted">
                        <tr>
                          <Th>이름</Th>
                          <Th>타입</Th>
                          <Th>수준 (쉼표)</Th>
                          <Th>설명</Th>
                          <Th>출처</Th>
                          <Th>라인</Th>
                          <Th>{""}</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleFactors.map((f, idx) => (
                          <tr key={f.name + idx} className="border-t border-border">
                            <Td>
                              <input
                                value={f.name}
                                onChange={(e) =>
                                  setOverrides((prev) => ({
                                    ...prev,
                                    factors: replaceByName(prev.factors, f.name, {
                                      ...f,
                                      name: e.target.value,
                                    }),
                                  }))
                                }
                                className={inputCls}
                              />
                            </Td>
                            <Td>
                              <select
                                value={f.type}
                                onChange={(e) =>
                                  setOverrides((prev) => ({
                                    ...prev,
                                    factors: replaceByName(prev.factors, f.name, {
                                      ...f,
                                      type: e.target.value as Factor["type"],
                                    }),
                                  }))
                                }
                                className={inputCls}
                              >
                                {FACTOR_TYPES.map((t) => (
                                  <option key={t} value={t}>
                                    {t}
                                  </option>
                                ))}
                              </select>
                            </Td>
                            <Td>
                              <input
                                value={f.levels.join(", ")}
                                onChange={(e) =>
                                  setOverrides((prev) => ({
                                    ...prev,
                                    factors: replaceByName(prev.factors, f.name, {
                                      ...f,
                                      levels: e.target.value
                                        .split(",")
                                        .map((s) => s.trim())
                                        .filter(Boolean),
                                    }),
                                  }))
                                }
                                placeholder="low, med, high"
                                className={inputCls}
                              />
                            </Td>
                            <Td>
                              <input
                                value={f.description ?? ""}
                                onChange={(e) =>
                                  setOverrides((prev) => ({
                                    ...prev,
                                    factors: replaceByName(prev.factors, f.name, {
                                      ...f,
                                      description: e.target.value || null,
                                    }),
                                  }))
                                }
                                className={inputCls}
                              />
                            </Td>
                            <Td>
                              <ProvBadge
                                source={provenanceFor("factors", f.name, heuristic, ai, overrides)}
                              />
                            </Td>
                            <Td className="text-muted">{f.line_hint ?? "—"}</Td>
                            <Td>
                              <RemoveBtn
                                onClick={() =>
                                  setRemovedFactors((s) => new Set(s).add(f.name))
                                }
                              />
                            </Td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </Section>

                {/* parameters */}
                <Section
                  title="파라미터 (실험 셋업 상수)"
                  hint="조작 변수가 아닌 고정 셋업 값. 자극 강도, 화면 거리, 시행 길이 등."
                  onAdd={() =>
                    setOverrides((prev) => ({
                      ...prev,
                      parameters: [
                        ...(prev.parameters ?? []),
                        { name: "new_param", type: "other", default: null, unit: null, shape: "unknown", description: null, line_hint: null },
                      ],
                    }))
                  }
                  rightAction={
                    onApplyToParameterSchema && visibleParams.length > 0 ? (
                      <Button type="button" size="sm" variant="secondary" onClick={importToParamSchema}>
                        실험 파라미터 스키마로 가져오기
                      </Button>
                    ) : null
                  }
                >
                  {visibleParams.length === 0 ? (
                    <Empty>등록된 파라미터가 없습니다</Empty>
                  ) : (
                    <table className="w-full text-xs">
                      <thead className="text-left text-muted">
                        <tr>
                          <Th>이름</Th>
                          <Th>타입</Th>
                          <Th>기본값</Th>
                          <Th>단위</Th>
                          <Th>설명</Th>
                          <Th>출처</Th>
                          <Th>라인</Th>
                          <Th>{""}</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleParams.map((p) => (
                          <tr key={p.name} className="border-t border-border">
                            <Td>
                              <input
                                value={p.name}
                                onChange={(e) =>
                                  setOverrides((prev) => ({
                                    ...prev,
                                    parameters: replaceByName(prev.parameters, p.name, {
                                      ...p,
                                      name: e.target.value,
                                    }),
                                  }))
                                }
                                className={inputCls}
                              />
                            </Td>
                            <Td>
                              <select
                                value={p.type}
                                onChange={(e) =>
                                  setOverrides((prev) => ({
                                    ...prev,
                                    parameters: replaceByName(prev.parameters, p.name, {
                                      ...p,
                                      type: e.target.value as Parameter["type"],
                                    }),
                                  }))
                                }
                                className={inputCls}
                              >
                                {PARAM_TYPES.map((t) => (
                                  <option key={t} value={t}>
                                    {t}
                                  </option>
                                ))}
                              </select>
                            </Td>
                            <Td>
                              <input
                                value={p.default ?? ""}
                                onChange={(e) =>
                                  setOverrides((prev) => ({
                                    ...prev,
                                    parameters: replaceByName(prev.parameters, p.name, {
                                      ...p,
                                      default: e.target.value || null,
                                    }),
                                  }))
                                }
                                className={inputCls}
                              />
                            </Td>
                            <Td>
                              <input
                                value={p.unit ?? ""}
                                onChange={(e) =>
                                  setOverrides((prev) => ({
                                    ...prev,
                                    parameters: replaceByName(prev.parameters, p.name, {
                                      ...p,
                                      unit: e.target.value || null,
                                    }),
                                  }))
                                }
                                placeholder="ms, deg, …"
                                className={inputCls}
                              />
                            </Td>
                            <Td>
                              <input
                                value={p.description ?? ""}
                                onChange={(e) =>
                                  setOverrides((prev) => ({
                                    ...prev,
                                    parameters: replaceByName(prev.parameters, p.name, {
                                      ...p,
                                      description: e.target.value || null,
                                    }),
                                  }))
                                }
                                className={inputCls}
                              />
                            </Td>
                            <Td>
                              <ProvBadge
                                source={provenanceFor("parameters", p.name, heuristic, ai, overrides)}
                              />
                            </Td>
                            <Td className="text-muted">{p.line_hint ?? "—"}</Td>
                            <Td>
                              <RemoveBtn
                                onClick={() =>
                                  setRemovedParams((s) => new Set(s).add(p.name))
                                }
                              />
                            </Td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </Section>

                {/* conditions */}
                <Section
                  title="컨디션 매핑"
                  hint="factor 의 어떤 level 조합이 어떤 condition 라벨로 쓰이는지 — 코드에서 실제로 사용되는 조합만."
                  onAdd={() =>
                    setOverrides((prev) => ({
                      ...prev,
                      conditions: [
                        ...(prev.conditions ?? []),
                        { label: "new_condition", factor_assignments: {}, description: null },
                      ],
                    }))
                  }
                >
                  {visibleConds.length === 0 ? (
                    <Empty>등록된 컨디션이 없습니다</Empty>
                  ) : (
                    <table className="w-full text-xs">
                      <thead className="text-left text-muted">
                        <tr>
                          <Th>라벨</Th>
                          <Th>factor → level (key=value, 쉼표)</Th>
                          <Th>설명</Th>
                          <Th>출처</Th>
                          <Th>{""}</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleConds.map((c) => (
                          <tr key={c.label} className="border-t border-border">
                            <Td>
                              <input
                                value={c.label}
                                onChange={(e) =>
                                  setOverrides((prev) => ({
                                    ...prev,
                                    conditions: replaceByLabel(prev.conditions, c.label, {
                                      ...c,
                                      label: e.target.value,
                                    }),
                                  }))
                                }
                                className={inputCls}
                              />
                            </Td>
                            <Td>
                              <input
                                value={Object.entries(c.factor_assignments)
                                  .map(([k, v]) => `${k}=${v}`)
                                  .join(", ")}
                                onChange={(e) => {
                                  const fa: Record<string, string> = {};
                                  for (const tok of e.target.value.split(",")) {
                                    const [k, v] = tok.split("=").map((x) => x.trim());
                                    if (k && v) fa[k] = v;
                                  }
                                  setOverrides((prev) => ({
                                    ...prev,
                                    conditions: replaceByLabel(prev.conditions, c.label, {
                                      ...c,
                                      factor_assignments: fa,
                                    }),
                                  }));
                                }}
                                placeholder="contrast=high, congruent=true"
                                className={inputCls}
                              />
                            </Td>
                            <Td>
                              <input
                                value={c.description ?? ""}
                                onChange={(e) =>
                                  setOverrides((prev) => ({
                                    ...prev,
                                    conditions: replaceByLabel(prev.conditions, c.label, {
                                      ...c,
                                      description: e.target.value || null,
                                    }),
                                  }))
                                }
                                className={inputCls}
                              />
                            </Td>
                            <Td>
                              <ProvBadge
                                source={provenanceFor("conditions", c.label, heuristic, ai, overrides)}
                              />
                            </Td>
                            <Td>
                              <RemoveBtn
                                onClick={() =>
                                  setRemovedConds((s) => new Set(s).add(c.label))
                                }
                              />
                            </Td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </Section>

                {/* saved variables */}
                <Section
                  title="저장 변수 (출력 데이터 스키마)"
                  hint="실험 코드가 실제로 기록하는 변수 — 이름, 포맷, 저장 위치."
                  onAdd={() =>
                    setOverrides((prev) => ({
                      ...prev,
                      saved_variables: [
                        ...(prev.saved_variables ?? []),
                        {
                          name: "new_var",
                          format: "other",
                          unit: null,
                          sink: null,
                          description: null,
                          line_hint: null,
                        },
                      ],
                    }))
                  }
                >
                  {visibleSaved.length === 0 ? (
                    <Empty>등록된 저장 변수가 없습니다</Empty>
                  ) : (
                    <table className="w-full text-xs">
                      <thead className="text-left text-muted">
                        <tr>
                          <Th>이름</Th>
                          <Th>포맷</Th>
                          <Th>단위</Th>
                          <Th>저장처 (sink)</Th>
                          <Th>설명</Th>
                          <Th>출처</Th>
                          <Th>{""}</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleSaved.map((s) => (
                          <tr key={s.name} className="border-t border-border">
                            <Td>
                              <input
                                value={s.name}
                                onChange={(e) =>
                                  setOverrides((prev) => ({
                                    ...prev,
                                    saved_variables: replaceByName(prev.saved_variables, s.name, {
                                      ...s,
                                      name: e.target.value,
                                    }),
                                  }))
                                }
                                className={inputCls}
                              />
                            </Td>
                            <Td>
                              <select
                                value={s.format}
                                onChange={(e) =>
                                  setOverrides((prev) => ({
                                    ...prev,
                                    saved_variables: replaceByName(prev.saved_variables, s.name, {
                                      ...s,
                                      format: e.target.value as SavedVariable["format"],
                                    }),
                                  }))
                                }
                                className={inputCls}
                              >
                                {SAVED_FORMATS.map((f) => (
                                  <option key={f} value={f}>
                                    {f}
                                  </option>
                                ))}
                              </select>
                            </Td>
                            <Td>
                              <input
                                value={s.unit ?? ""}
                                onChange={(e) =>
                                  setOverrides((prev) => ({
                                    ...prev,
                                    saved_variables: replaceByName(prev.saved_variables, s.name, {
                                      ...s,
                                      unit: e.target.value || null,
                                    }),
                                  }))
                                }
                                className={inputCls}
                              />
                            </Td>
                            <Td>
                              <input
                                value={s.sink ?? ""}
                                onChange={(e) =>
                                  setOverrides((prev) => ({
                                    ...prev,
                                    saved_variables: replaceByName(prev.saved_variables, s.name, {
                                      ...s,
                                      sink: e.target.value || null,
                                    }),
                                  }))
                                }
                                placeholder="data.csv, results.mat"
                                className={inputCls}
                              />
                            </Td>
                            <Td>
                              <input
                                value={s.description ?? ""}
                                onChange={(e) =>
                                  setOverrides((prev) => ({
                                    ...prev,
                                    saved_variables: replaceByName(prev.saved_variables, s.name, {
                                      ...s,
                                      description: e.target.value || null,
                                    }),
                                  }))
                                }
                                className={inputCls}
                              />
                            </Td>
                            <Td>
                              <ProvBadge
                                source={provenanceFor(
                                  "saved_variables",
                                  s.name,
                                  heuristic,
                                  ai,
                                  overrides,
                                )}
                              />
                            </Td>
                            <Td>
                              <RemoveBtn
                                onClick={() =>
                                  setRemovedSaved((p) => new Set(p).add(s.name))
                                }
                              />
                            </Td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </Section>

                {/* actions */}
                <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
                  {experimentId && (
                    <Button
                      type="button"
                      onClick={saveToDb}
                      disabled={savingDb}
                      size="sm"
                    >
                      {savingDb ? "저장 중…" : "이 실험에 저장"}
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setOverrides({});
                      setRemovedFactors(new Set());
                      setRemovedParams(new Set());
                      setRemovedConds(new Set());
                      setRemovedSaved(new Set());
                    }}
                  >
                    내 수정 초기화 (AI/휴리스틱 결과로 되돌리기)
                  </Button>
                  <span className="ml-auto text-[11px] text-muted">
                    {analyzing ? "분석 진행 중…" : `요인 ${visibleFactors.length} · 파라미터 ${visibleParams.length} · 컨디션 ${visibleConds.length} · 저장변수 ${visibleSaved.length}`}
                  </span>
                </div>
              </>
            )}
          </div>

          {/* chat side panel */}
          {chatOpen && (
            <aside className="rounded-lg border border-border bg-card/40 p-3">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold">코드 분석 챗봇</h3>
                <span className="text-[10px] text-muted">
                  {chatStreaming ? "응답 중…" : "Qwen via Ollama"}
                </span>
              </div>
              <div className="mb-3 max-h-72 space-y-2 overflow-y-auto rounded border border-border bg-white p-2 text-xs">
                {chatHistory.length === 0 && (
                  <p className="text-muted">
                    예) “save_data 함수가 어떤 컬럼을 쓰는지 정리해줘”, “factor
                    contrast 의 levels 가 맞나?”
                  </p>
                )}
                {chatHistory.map((m, i) => (
                  <div key={i} className={m.role === "user" ? "text-foreground" : "text-foreground/80"}>
                    <span className="mr-1 font-mono text-[10px] text-muted">
                      {m.role === "user" ? "🧑" : "🤖"}
                    </span>
                    <span className="whitespace-pre-wrap">{m.content}</span>
                  </div>
                ))}
              </div>

              {pendingPatches.length > 0 && (
                <div className="mb-3 rounded border border-blue-300 bg-blue-50 p-2 text-xs">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="font-medium text-blue-900">
                      대기 중인 변경 {pendingPatches.length}개
                    </span>
                    <button
                      type="button"
                      onClick={acceptAllPatches}
                      className="text-[11px] font-medium text-blue-900 hover:underline"
                    >
                      모두 적용
                    </button>
                  </div>
                  <ul className="space-y-1">
                    {pendingPatches.map((p) => (
                      <li key={p.id} className="flex items-center justify-between gap-2">
                        <span className="truncate">{p.summary}</span>
                        <span className="flex shrink-0 gap-1">
                          <button
                            type="button"
                            onClick={() => acceptPatch(p.id)}
                            className="rounded bg-green-600 px-2 py-0.5 text-[10px] text-white hover:bg-green-700"
                          >
                            적용
                          </button>
                          <button
                            type="button"
                            onClick={() => rejectPatch(p.id)}
                            className="rounded bg-gray-200 px-2 py-0.5 text-[10px] hover:bg-gray-300"
                          >
                            거부
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <textarea
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void sendChat();
                  }
                }}
                rows={3}
                placeholder="모호한 부분을 물어보세요 (Ctrl/Cmd + Enter 전송)"
                className="block w-full resize-y rounded-lg border border-border bg-white px-2 py-1.5 text-xs focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
              <Button
                type="button"
                size="sm"
                className="mt-2 w-full"
                onClick={sendChat}
                disabled={chatStreaming || !chatInput.trim()}
              >
                전송
              </Button>
            </aside>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ---- small helpers ----------------------------------------------------

const inputCls =
  "block w-full rounded border border-border bg-white px-2 py-1 text-xs focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30";

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-2 py-1 font-medium">{children}</th>;
}
function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-2 py-1 align-middle ${className}`}>{children}</td>;
}

function Section({
  title,
  hint,
  onAdd,
  rightAction,
  children,
}: {
  title: string;
  hint?: string;
  onAdd?: () => void;
  rightAction?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        <div className="flex items-center gap-2">
          {rightAction}
          {onAdd && (
            <button
              type="button"
              onClick={onAdd}
              className="text-xs font-medium text-primary hover:text-primary-hover"
            >
              + 추가
            </button>
          )}
        </div>
      </div>
      {hint && <p className="mb-2 text-[11px] text-muted">{hint}</p>}
      <div className="overflow-x-auto rounded-lg border border-border bg-white">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-3 py-4 text-center text-xs text-muted">{children}</p>;
}

function RemoveBtn({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-muted hover:text-danger"
      aria-label="삭제"
      title="삭제"
    >
      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
    </button>
  );
}

function MetaCell({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
}) {
  return (
    <div>
      <div className="text-[11px] text-muted">{label}</div>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={inputCls}>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </div>
  );
}
function MetaNumber({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  return (
    <div>
      <div className="text-[11px] text-muted">{label}</div>
      <input
        type="number"
        min={0}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        className={inputCls}
      />
    </div>
  );
}
function MetaText({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  return (
    <div>
      <div className="text-[11px] text-muted">{label}</div>
      <input
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        className={inputCls}
      />
    </div>
  );
}

function replaceAt<T>(arr: T[], idx: number, next: T): T[] {
  const out = arr.slice();
  out[idx] = next;
  return out;
}

function replaceByName<T extends { name: string }>(
  list: T[] | undefined,
  oldName: string,
  next: T,
): T[] {
  const arr = list ? [...list] : [];
  const i = arr.findIndex((x) => x.name === oldName);
  if (i >= 0) arr[i] = next;
  else arr.push(next);
  return arr;
}
function replaceByLabel<T extends { label: string }>(
  list: T[] | undefined,
  oldLabel: string,
  next: T,
): T[] {
  const arr = list ? [...list] : [];
  const i = arr.findIndex((x) => x.label === oldLabel);
  if (i >= 0) arr[i] = next;
  else arr.push(next);
  return arr;
}

function stripRemoved(
  overrides: CodeAnalysisOverrides,
  removed: {
    factors: Set<string>;
    parameters: Set<string>;
    conditions: Set<string>;
    saved_variables: Set<string>;
  },
): CodeAnalysisOverrides {
  return {
    ...overrides,
    factors: (overrides.factors ?? []).filter((f) => !removed.factors.has(f.name)),
    parameters: (overrides.parameters ?? []).filter((p) => !removed.parameters.has(p.name)),
    conditions: (overrides.conditions ?? []).filter((c) => !removed.conditions.has(c.label)),
    saved_variables: (overrides.saved_variables ?? []).filter(
      (s) => !removed.saved_variables.has(s.name),
    ),
  };
}

function sanitizeParamKey(name: string): string {
  // existing experimentSchema parameter_schema.key requires
  // /^[A-Za-z_][A-Za-z0-9_]*$/ ≤64. Replace dots with underscores.
  const s = name.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 64);
  if (!/^[A-Za-z_]/.test(s)) return `_${s}`.slice(0, 64);
  return s;
}

function parseDefault(
  value: string | null,
  type: "number" | "string",
): string | number | null {
  if (value == null || value === "") return null;
  if (type === "number") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return value;
}

// Re-exporting the schema keeps consumers' imports tidy.
export { CodeAnalysisSchema };
