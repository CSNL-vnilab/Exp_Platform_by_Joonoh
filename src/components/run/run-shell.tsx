"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { OnlineRuntimeConfig } from "@/types/database";

interface Precaution {
  question: string;
  required_answer: boolean;
}

interface RunShellProps {
  token: string;
  booking: {
    id: string;
    subject_number: number;
  };
  experiment: {
    id: string;
    title: string;
    description: string | null;
    mode: "online" | "hybrid";
    runtime_config: OnlineRuntimeConfig | null;
    irb_document_url: string | null;
    data_consent_required: boolean;
    precautions: Precaution[];
  };
  progress: {
    blocks_submitted: number;
    completion_code: string | null;
  };
}

type Phase = "consent" | "ready" | "running" | "completed" | "error";

// Frames a researcher-provided JS file inside a same-origin-blocked iframe.
// The iframe loads a small HTML shim that exposes window.expPlatform.submitBlock
// and proxies calls back to the parent via postMessage. The parent then hits
// /api/experiments/:id/data/:bookingId/block with the signed token.
//
// Security considerations:
//  - iframe sandbox: 'allow-scripts' only. No same-origin, no form submission,
//    no top navigation. Researcher JS cannot read parent cookies or touch
//    the rest of the app.
//  - token never leaves the parent frame. The iframe only sees the block
//    payload; the parent adds auth headers.
//  - postMessage origin checked: messages must come from the iframe's window.
//  - rate limits enforced server-side regardless of what the iframe sends.

export function RunShell({ token, booking, experiment, progress }: RunShellProps) {
  const [phase, setPhase] = useState<Phase>(
    progress.completion_code ? "completed"
      : experiment.data_consent_required || experiment.precautions.length > 0 ? "consent"
      : "ready",
  );
  const [consentChecked, setConsentChecked] = useState(false);
  const [precautionAnswers, setPrecautionAnswers] = useState<Record<number, boolean>>({});
  const [blocksSubmitted, setBlocksSubmitted] = useState(progress.blocks_submitted);
  const [completionCode, setCompletionCode] = useState<string | null>(progress.completion_code);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const entryUrl = experiment.runtime_config?.entry_url ?? "";
  const blockCount = experiment.runtime_config?.block_count ?? null;
  const estMinutes = experiment.runtime_config?.estimated_minutes ?? null;

  // Build the sandboxed shim HTML. The shim injects a script tag pointing at
  // the researcher's entry_url and exposes window.expPlatform.
  const shimHtml = useMemo(() => {
    // Injecting values into an inline <script> block. JSON.stringify alone
    // is NOT sufficient — a payload containing "</script>" will terminate
    // the script tag and let arbitrary HTML run. Escape <, >, &, and U+2028/
    // U+2029 (which break JS strings) to their \uXXXX forms, which JS
    // parses identically but HTML cannot.
    const scriptSafe = (v: unknown) =>
          JSON.stringify(v)
            .replace(/</g, '\\u003c')
            .replace(/>/g, '\\u003e')
            .replace(/&/g, '\\u0026')
            .replace(/\u2028/g, '\\u2028')
            .replace(/\u2029/g, '\\u2029');
        const safeEntry = scriptSafe(entryUrl);
    return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Experiment runtime</title>
<style>
  html, body { margin: 0; padding: 0; background: #0b0f14; color: #e5e7eb; font-family: -apple-system, "Segoe UI", sans-serif; }
  body { min-height: 100vh; overflow-x: hidden; }
  .shim-loading { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; }
  .shim-loading p { color: #9ca3af; font-size: 14px; }
  .shim-error { padding: 24px; color: #fecaca; font-size: 13px; font-family: ui-monospace, SFMono-Regular, monospace; white-space: pre-wrap; }
</style>
</head>
<body>
<div class="shim-loading" id="__shim_loading"><p>실험 코드를 불러오는 중입니다…</p></div>
<div id="exp-root"></div>
<script>
(function(){
  var pending = new Map();
  var seq = 1;
  function send(type, data) {
    return new Promise(function(resolve, reject){
      var id = String(seq++);
      pending.set(id, { resolve: resolve, reject: reject });
      parent.postMessage({ __exp: true, id: id, type: type, data: data }, '*');
    });
  }
  window.addEventListener('message', function(e){
    var msg = e.data;
    if (!msg || msg.__exp !== true || !msg.id) return;
    var p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
  });
  window.expPlatform = {
    subject: ${JSON.stringify(booking.subject_number)},
    experimentId: ${JSON.stringify(experiment.id)},
    bookingId: ${JSON.stringify(booking.id)},
    config: ${JSON.stringify(experiment.runtime_config ?? {})},
    // How many blocks the server has already accepted for this booking.
    // Researcher JS should skip ahead this many blocks so a reload resumes
    // where the participant left off; the server rejects out-of-order
    // block_index values.
    blocksSubmitted: ${JSON.stringify(progress.blocks_submitted)},
    submitBlock: function(payload) {
      if (!payload || typeof payload !== 'object') return Promise.reject(new Error('payload required'));
      if (typeof payload.blockIndex !== 'number' && typeof payload.block_index !== 'number') {
        return Promise.reject(new Error('blockIndex required'));
      }
      if (!Array.isArray(payload.trials)) {
        return Promise.reject(new Error('trials array required'));
      }
      return send('submitBlock', {
        block_index: payload.blockIndex ?? payload.block_index,
        trials: payload.trials,
        block_metadata: payload.blockMetadata || payload.block_metadata || null,
        completed_at: payload.completedAt || payload.completed_at || new Date().toISOString(),
        is_last: !!(payload.isLast || payload.is_last),
      });
    },
    reportProgress: function(update) { return send('progress', update || {}); },
    log: function(message) { return send('log', String(message || '')); },
  };
  var loading = document.getElementById('__shim_loading');
  var script = document.createElement('script');
  script.src = "${safeEntry}";
  script.onload = function(){ if (loading) loading.remove(); parent.postMessage({ __exp: true, type: 'loaded' }, '*'); };
  script.onerror = function(){
    if (loading) loading.remove();
    var err = document.createElement('pre');
    err.className = 'shim-error';
    err.textContent = '실험 코드를 불러올 수 없습니다. 연구원에게 문의해주세요.\\nentry_url: ' + ${JSON.stringify(safeEntry)};
    document.body.appendChild(err);
    parent.postMessage({ __exp: true, type: 'load_error' }, '*');
  };
  document.body.appendChild(script);
})();
</script>
</body>
</html>`;
  }, [entryUrl, booking, experiment]);

  // Wire postMessage handler for the iframe shim.
  useEffect(() => {
    if (phase !== "running") return;
    const handler = (e: MessageEvent) => {
      if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return;
      const msg = e.data as {
        __exp?: true;
        id?: string;
        type?: string;
        data?: unknown;
      };
      if (!msg || msg.__exp !== true) return;

      if (msg.type === "loaded") return;
      if (msg.type === "load_error") {
        setErrorMsg(
          "실험 코드를 불러올 수 없습니다. 페이지를 새로고침하거나 연구원에게 문의해 주세요.",
        );
        return;
      }
      if (msg.type === "log") return;
      if (msg.type === "progress") return;

      if (msg.type === "submitBlock" && msg.id) {
        void submitBlockToApi(msg.data).then(
          (result) => {
            iframeRef.current?.contentWindow?.postMessage(
              { __exp: true, id: msg.id, result },
              "*",
            );
          },
          (err: Error) => {
            iframeRef.current?.contentWindow?.postMessage(
              { __exp: true, id: msg.id, error: err.message },
              "*",
            );
          },
        );
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [phase]);

  // Map server error codes to Korean strings the participant can act on.
  function describeError(code: string): string {
    switch (code) {
      case "RATE_LIMIT_BURST":
        return "너무 빠르게 전송되었습니다. 잠시 후 자동으로 다시 시도됩니다.";
      case "RATE_LIMIT_MINUTE":
        return "전송 한도를 초과했습니다. 잠시 기다린 뒤 계속하세요.";
      case "BLOCK_INDEX_MISMATCH":
        return "블록 순서가 맞지 않습니다. 페이지를 새로고침하면 이어서 진행할 수 있습니다.";
      case "BLOCK_INDEX_OUT_OF_RANGE":
        return "설정된 블록 수를 초과했습니다. 연구원에게 문의해 주세요.";
      case "RUN_ALREADY_COMPLETED":
        return "이미 완료된 세션입니다. 완료 코드를 다시 확인해 주세요.";
      case "TOKEN_REVOKED":
        return "접근 권한이 취소되었습니다. 연구원에게 새 링크를 요청해 주세요.";
      default:
        return "서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.";
    }
  }

  async function submitBlockToApi(data: unknown): Promise<{
    blocks_submitted: number;
    completion_code: string | null;
  }> {
    // Light retry — one pass with exponential backoff covers transient
    // network blips (Wi-Fi reconnect, server warm-up) without letting
    // genuine errors stall the run.
    const delays = [0, 1500];
    let lastErr: Error | null = null;
    for (const delay of delays) {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      try {
        const res = await fetch(
          `/api/experiments/${experiment.id}/data/${booking.id}/block`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(data),
          },
        );
        const body = (await res.json().catch(() => ({}))) as {
          blocks_submitted?: number;
          completion_code?: string | null;
          error?: string;
          warning?: string;
        };
        if (!res.ok) {
          const code = body.error || `HTTP_${res.status}`;
          // 429 and 5xx are worth retrying once. 4xx beyond 429 are final.
          if (res.status >= 500 || res.status === 429) {
            lastErr = new Error(code);
            continue;
          }
          throw new Error(code);
        }
        if (typeof body.blocks_submitted === "number") {
          setBlocksSubmitted(body.blocks_submitted);
        }
        if (body.completion_code) {
          setCompletionCode(body.completion_code);
          setPhase("completed");
        } else if (body.warning) {
          setErrorMsg(
            "마지막 블록은 업로드되었지만 완료 코드를 발급하지 못했습니다. 연구원에게 문의해 주세요.",
          );
        } else {
          setErrorMsg(null);
        }
        return {
          blocks_submitted: body.blocks_submitted ?? 0,
          completion_code: body.completion_code ?? null,
        };
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
      }
    }
    const code = lastErr?.message ?? "UNKNOWN";
    const friendly = describeError(code);
    setErrorMsg(friendly);
    throw new Error(code);
  }

  const canStart = useMemo(() => {
    if (phase !== "consent") return true;
    if (experiment.data_consent_required && !consentChecked) return false;
    for (const [i, p] of experiment.precautions.entries()) {
      const ans = precautionAnswers[i];
      if (ans === undefined || ans !== p.required_answer) return false;
    }
    return true;
  }, [phase, consentChecked, precautionAnswers, experiment]);

  function startRun() {
    if (!canStart) return;
    setErrorMsg(null);
    setPhase("running");
  }

  async function copyCode() {
    if (!completionCode) return;
    // Preferred path: async clipboard API (secure contexts only).
    if (
      typeof navigator !== "undefined" &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === "function"
    ) {
      try {
        await navigator.clipboard.writeText(completionCode);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
        return;
      } catch {
        // fall through to legacy path
      }
    }
    // Fallback for insecure contexts / older browsers: select the code
    // element and execute a synchronous copy. The element is also
    // styled with user-select:all so triple-click + Cmd-C works manually.
    try {
      const el = document.getElementById("exp-completion-code");
      if (el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        document.execCommand("copy");
        sel?.removeAllRanges();
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch {
      // noop — the code is still visible and user-selectable
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div className="mx-auto max-w-3xl py-8">
      <header className="mb-6 rounded-2xl border border-border bg-white p-5 shadow-sm sm:p-6">
        <h1 className="text-xl font-bold leading-snug text-foreground sm:text-2xl">
          {experiment.title}
        </h1>
        {experiment.description && (
          <p className="mt-2 text-sm leading-relaxed text-muted">{experiment.description}</p>
        )}
        <div className="mt-4 flex flex-wrap gap-2 text-xs">
          <span className="rounded-full bg-blue-50 px-2.5 py-1 font-medium text-blue-700">
            Sbj {booking.subject_number}
          </span>
          {blockCount !== null && (
            <span className="rounded-full bg-gray-100 px-2.5 py-1 font-medium text-foreground">
              {blocksSubmitted}/{blockCount} 블록 완료
            </span>
          )}
          {estMinutes !== null && (
            <span className="rounded-full bg-gray-100 px-2.5 py-1 font-medium text-foreground">
              예상 소요 {estMinutes}분
            </span>
          )}
        </div>
      </header>

      {phase === "consent" && (
        <section className="rounded-2xl border border-border bg-white p-5 shadow-sm sm:p-6">
          <h2 className="text-base font-semibold text-foreground">실험 참여 전 확인사항</h2>

          {experiment.irb_document_url && (
            <div className="mt-4 rounded-lg border border-blue-200 bg-blue-50 p-4">
              <p className="text-sm font-medium text-blue-800">IRB 승인 문서</p>
              <p className="mt-1 text-xs text-blue-700 leading-relaxed">
                아래 문서에서 본 연구의 IRB 승인 내용을 확인하실 수 있습니다.
              </p>
              <a
                href={experiment.irb_document_url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
              >
                IRB 문서 열기
              </a>
            </div>
          )}

          {experiment.precautions.length > 0 && (
            <div className="mt-4 space-y-3">
              {experiment.precautions.map((p, i) => {
                const ans = precautionAnswers[i];
                const wrong = ans !== undefined && ans !== p.required_answer;
                return (
                  <div
                    key={i}
                    className={`rounded-lg border p-3 ${
                      wrong ? "border-red-300 bg-red-50" : "border-border bg-card"
                    }`}
                  >
                    <p className="text-sm text-foreground">{p.question}</p>
                    <div className="mt-2 flex gap-4">
                      {[
                        { label: "예", val: true },
                        { label: "아니오", val: false },
                      ].map(({ label, val }) => (
                        <label key={label} className="flex cursor-pointer items-center gap-2">
                          <input
                            type="radio"
                            name={`precaution-${i}`}
                            checked={ans === val}
                            onChange={() =>
                              setPrecautionAnswers((prev) => ({ ...prev, [i]: val }))
                            }
                            className="h-4 w-4 accent-primary"
                          />
                          <span className="text-sm text-foreground">{label}</span>
                        </label>
                      ))}
                    </div>
                    {wrong && (
                      <p className="mt-2 text-xs text-red-600">
                        해당 조건을 충족하지 않으면 실험 참여가 불가합니다.
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {experiment.data_consent_required && (
            <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-card p-3">
              <input
                type="checkbox"
                checked={consentChecked}
                onChange={(e) => setConsentChecked(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-primary"
              />
              <span className="text-sm leading-relaxed text-foreground">
                본 실험의 데이터 수집에 동의합니다. 수집된 응답은 연구 목적 외로는 사용되지
                않으며, IRB 승인 문서에 명시된 보관·파기 절차를 따릅니다.
              </span>
            </label>
          )}

          <div className="mt-6 flex justify-end">
            <button
              type="button"
              onClick={startRun}
              disabled={!canStart}
              className="inline-flex items-center justify-center rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              실험 시작
            </button>
          </div>
        </section>
      )}

      {phase === "ready" && (
        <section className="rounded-2xl border border-border bg-white p-5 shadow-sm sm:p-6">
          <p className="text-sm leading-relaxed text-foreground">
            준비가 되셨다면 아래 버튼을 눌러 실험을 시작해 주세요. 실험 중에는 창을 닫지 말아
            주시고, 네트워크 연결을 유지해 주세요.
          </p>
          <div className="mt-5 flex justify-end">
            <button
              type="button"
              onClick={() => setPhase("running")}
              className="inline-flex items-center justify-center rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-primary/90"
            >
              실험 시작
            </button>
          </div>
        </section>
      )}

      {phase === "running" && (
        <section className="overflow-hidden rounded-2xl border border-border bg-[#0b0f14] shadow-sm">
          <iframe
            ref={iframeRef}
            title="Experiment runtime"
            srcDoc={shimHtml}
            sandbox="allow-scripts"
            className="h-[70vh] w-full border-0"
          />
          {errorMsg && (
            <div
              role="alert"
              aria-live="polite"
              className="flex items-start gap-3 border-t border-red-300 bg-red-50 p-3 text-xs text-red-800"
            >
              <span className="flex-1 leading-relaxed">{errorMsg}</span>
              <button
                type="button"
                onClick={() => {
                  if (typeof window !== "undefined") window.location.reload();
                }}
                className="shrink-0 rounded border border-red-400 bg-white px-2 py-1 font-medium text-red-700 hover:bg-red-100"
              >
                새로고침
              </button>
            </div>
          )}
          {blockCount !== null && (
            <div className="border-t border-border bg-white p-3 text-center text-xs text-muted">
              진행: {blocksSubmitted}/{blockCount} 블록
            </div>
          )}
        </section>
      )}

      {phase === "completed" && completionCode && (
        <section className="rounded-2xl border border-green-200 bg-green-50 p-6 text-center shadow-sm">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-green-500 text-white">
            <svg
              className="h-7 w-7"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={3}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="text-lg font-bold text-green-800">실험이 완료되었습니다</h2>
          <p className="mt-2 text-sm text-green-700">
            아래의 완료 코드를 담당 연구원에게 전달해 주세요. 코드가 확인되어야 참여가
            최종적으로 기록됩니다.
          </p>
          <div
            className="mt-4 rounded-xl border border-green-300 bg-white p-4"
            aria-live="polite"
          >
            <p className="text-xs font-medium uppercase tracking-wide text-green-700">
              완료 코드
            </p>
            <p
              id="exp-completion-code"
              className="mt-1 break-all font-mono text-lg font-bold text-foreground"
              style={{ userSelect: "all", WebkitUserSelect: "all" }}
            >
              {completionCode}
            </p>
          </div>
          <button
            type="button"
            onClick={copyCode}
            className="mt-4 inline-flex items-center gap-2 rounded-lg border border-green-400 bg-white px-4 py-2 text-sm font-medium text-green-800 hover:bg-green-100"
          >
            {copied ? "복사되었습니다" : "코드 복사"}
          </button>
          <p className="mt-6 text-xs text-muted">
            참여해 주셔서 감사합니다. 이 창은 닫으셔도 괜찮습니다.
          </p>
        </section>
      )}

      {phase === "error" && (
        <section className="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-700">
          {errorMsg ?? "알 수 없는 오류가 발생했습니다."}
        </section>
      )}
    </div>
  );
}
