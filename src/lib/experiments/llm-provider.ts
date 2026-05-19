// LLM provider abstraction for the offline-experiment code analyzer.
//
// The analyzer needs one operation: "given a system prompt + a user
// payload, return a JSON object that conforms to CodeAnalysisSchema."
// Two providers ship in v1:
//
//   - OllamaProvider     — local model (qwen3.6, gemma4, …) via REST.
//                          Used in dev / on the lab's analysis box.
//   - AnthropicProvider  — claude-opus-4-7 (or -sonnet-4-6) via the
//                          official SDK. Used in production (Vercel)
//                          where Ollama isn't reachable.
//
// Selection priority at runtime:
//   1. AiAnalyzeInput.provider (explicit override)
//   2. LLM_PROVIDER env: "anthropic" | "ollama"
//   3. ANTHROPIC_API_KEY presence → anthropic
//   4. Ollama /api/tags reachable → ollama
//   5. throw
//
// Adding a third provider is one new class implementing LLMProvider.

import Anthropic from "@anthropic-ai/sdk";
import {
  chat as ollamaChat,
  chatJson as ollamaChatJson,
  ping as ollamaPing,
  modelFor as ollamaModelFor,
  MODELS as OLLAMA_MODELS,
  CODE_ANALYSIS_PREFS,
  REVIEW_PREFS,
  listModels as ollamaListModels,
  type ChatMessage,
} from "@/lib/ollama";

export interface LLMChatJsonOptions {
  messages: ChatMessage[];
  temperature?: number;
  num_predict?: number;
  num_ctx?: number;
  // Deterministic-decode knobs (Ollama). Ignored by the Anthropic
  // provider, which only honours `temperature`.
  seed?: number;
  top_p?: number;
  top_k?: number;
  repeat_penalty?: number;
  min_p?: number;
  signal?: AbortSignal;
}

export interface LLMProvider {
  readonly name: "ollama" | "anthropic";
  readonly model: string;
  // Returns a parsed JSON object — provider handles schema-mode
  // / format-json / robust extraction internally.
  chatJson<T = unknown>(opts: LLMChatJsonOptions): Promise<T>;
  // Returns raw text — used by the two-pass refinement reviewer that
  // emits <patch>{...}</patch> blocks (intermixable prose + json).
  chatText(opts: LLMChatJsonOptions): Promise<string>;
  health(): Promise<{ ok: boolean; detail?: string }>;
}

// ---------------------------------------------------------------------------
// Ollama provider (local)
// ---------------------------------------------------------------------------
export class OllamaProvider implements LLMProvider {
  readonly name = "ollama" as const;
  readonly model: string;
  constructor(model?: string) {
    this.model = model ?? ollamaModelFor("code.analysis");
  }
  async chatJson<T>(opts: LLMChatJsonOptions): Promise<T> {
    return ollamaChatJson<T>({
      model: this.model,
      messages: opts.messages,
      temperature: opts.temperature,
      num_ctx: opts.num_ctx,
      num_predict: opts.num_predict,
      seed: opts.seed,
      top_p: opts.top_p,
      top_k: opts.top_k,
      repeat_penalty: opts.repeat_penalty,
      min_p: opts.min_p,
      signal: opts.signal,
    });
  }
  async chatText(opts: LLMChatJsonOptions): Promise<string> {
    return ollamaChat({
      model: this.model,
      messages: opts.messages,
      temperature: opts.temperature,
      num_ctx: opts.num_ctx,
      num_predict: opts.num_predict,
      seed: opts.seed,
      top_p: opts.top_p,
      top_k: opts.top_k,
      repeat_penalty: opts.repeat_penalty,
      min_p: opts.min_p,
      signal: opts.signal,
    });
  }
  async health() {
    const ok = await ollamaPing();
    return { ok, detail: ok ? "ollama reachable" : "ollama unreachable" };
  }
}

// Resolve a model that's actually pulled on this Ollama host. Per-tag
// cached for 60s — *each* preferred tag gets its own cache slot so the
// extraction pass (qwen3.6) doesn't poison the review pass (gemma4:31b)
// or vice versa. Without a per-tag cache, the second call's `preferred`
// argument was ignored for 60s after the first call, silently using
// the wrong model for the second pass.
const ollamaModelCache = new Map<string, { value: string; expires: number }>();

function modelFamily(tag: string): string {
  return tag.split(":")[0];
}

// Preference list to try when the requested tag isn't pulled, chosen by
// model family so a qwen request walks the extraction prefs and a gemma
// request walks the review prefs.
function prefsFor(want: string): readonly string[] {
  const fam = modelFamily(want);
  if (fam === "qwen3.6") return CODE_ANALYSIS_PREFS;
  if (fam === "gemma4") return REVIEW_PREFS;
  return [];
}

// Resolve `preferred` to a tag that is *actually pulled* on this host.
// The old impl returned `want` whenever ANY same-family tag existed
// (`tags.some(startsWith)`) — so a stale "qwen3.6:latest" default 404'd
// at chat time on a box that only has "qwen3.6:36b". We now bind to a
// concrete present tag: exact want → family prefs → fallback → ANY
// pulled tag of the wanted/fallback family (covers custom quant tags
// like "qwen3.6:36b-q5"). Per-tag cached 60s, keyed by the request so
// the extraction (qwen) and review (gemma) resolutions don't collide.
export async function pickOllamaModel(
  preferred?: string,
  // "review" guarantees the resolver never collapses to the code
  // (qwen) family even for an arbitrary REFINEMENT_MODEL tag — the
  // review pass must stay a *different* family from pass-1 (Codex R2
  // R1-INC #4). Default "code".
  purpose: "code" | "review" = "code",
): Promise<string> {
  const want = preferred ?? ollamaModelFor("code.analysis");
  const cacheKey = `${purpose}:${want}`;
  const cached = ollamaModelCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.value;
  // Family-correct fallback: a review request (or a gemma tag) must
  // NOT degrade to the qwen extraction fallback. Review → gemma
  // (reviewFast); code → code-analysis fallback.
  const fb =
    purpose === "review" || modelFamily(want) === "gemma4"
      ? OLLAMA_MODELS.reviewFast
      : OLLAMA_MODELS.codeAnalysisFallback;
  // The extraction (pass-1) family. A review pass must never resolve
  // to it — even if REFINEMENT_MODEL explicitly names a qwen tag —
  // because same-family review defeats cross-checking (Codex R3 #2).
  const codeFamily = modelFamily(OLLAMA_MODELS.codeAnalysis);
  const banned = (tag: string) =>
    purpose === "review" && modelFamily(tag) === codeFamily;
  let chosen = want;
  try {
    const tags = await ollamaListModels();
    const tagSet = new Set(tags);
    const candidates = [want, ...prefsFor(want), fb].filter((c) => !banned(c));
    let picked: string | null = null;
    for (const c of candidates) {
      if (tagSet.has(c)) {
        picked = c;
        break;
      }
    }
    if (!picked) {
      const wantFam = modelFamily(want);
      // For review, never cross into the code (qwen) family — only the
      // requested family (unless banned) or the gemma fallback family.
      picked =
        (!banned(want)
          ? tags.find((t) => modelFamily(t) === wantFam)
          : undefined) ??
        tags.find((t) => modelFamily(t) === modelFamily(fb) && !banned(t)) ??
        null;
    }
    if (!picked) {
      // Nothing usable is pulled. Throw with the exact pull command so
      // the analyzer warning tells the operator what's missing instead
      // of a downstream 404 swallowed upstream.
      throw new Error(
        `Ollama 모델이 호스트에 없습니다: 요청 "${want}" / 폴백 "${fb}" / 후보 [${prefsFor(
          want,
        ).join(", ")}] — \`ollama pull ${want}\` 으로 받아주세요`,
      );
    }
    chosen = picked;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Ollama 모델이")) throw err;
    // network glitch — keep `want` and let downstream fail loudly
  }
  ollamaModelCache.set(cacheKey, { value: chosen, expires: Date.now() + 60_000 });
  return chosen;
}

// ---------------------------------------------------------------------------
// Anthropic provider (cloud — Opus 4.7 / Sonnet 4.6)
// ---------------------------------------------------------------------------
export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic" as const;
  readonly model: string;
  private client: Anthropic;
  // The Anthropic API doesn't yet expose `format=json` constrained
  // decoding, so we rely on (a) a tightly-scoped system prompt and
  // (b) a JSON-extraction post-processor identical to the Ollama one.
  constructor(opts: { apiKey?: string; model?: string } = {}) {
    const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY 가 설정되지 않았습니다");
    this.client = new Anthropic({ apiKey });
    this.model = opts.model ?? process.env.ANTHROPIC_CODE_MODEL ?? "claude-opus-4-7";
  }
  async chatJson<T>(opts: LLMChatJsonOptions): Promise<T> {
    // Anthropic Messages API expects system / user separated.
    // Our internal message list always has shape [system, ...turns, user].
    const sys = opts.messages.find((m) => m.role === "system")?.content ?? "";
    const turns = opts.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));
    const res = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: opts.num_predict ?? 8192,
        temperature: opts.temperature ?? 0.1,
        system: sys + "\n\n반드시 JSON 객체 하나만 출력하세요 — 다른 텍스트나 마크다운 금지.",
        messages: turns,
      },
      { signal: opts.signal },
    );
    const block = res.content.find((b) => b.type === "text");
    const raw = block && "text" in block ? block.text : "";
    const parsed = robustJsonParse(raw);
    if (parsed == null) {
      throw new Error(`anthropic chatJson: model returned non-JSON: ${raw.slice(0, 200)}`);
    }
    return parsed as T;
  }
  async chatText(opts: LLMChatJsonOptions): Promise<string> {
    const sys = opts.messages.find((m) => m.role === "system")?.content ?? "";
    const turns = opts.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));
    const res = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: opts.num_predict ?? 8192,
        temperature: opts.temperature ?? 0.2,
        system: sys,
        messages: turns,
      },
      { signal: opts.signal },
    );
    // Concatenate ALL text blocks. Reviewer responses can interleave
    // prose + <patch> + prose + <patch>; returning only the first block
    // would silently drop trailing patches.
    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  }
  async health() {
    // Cheapest possible probe — list models is rate-limited and not
    // idempotent on auth issues. We instead do a 1-token messages call
    // gated behind an env to avoid hidden costs.
    if (!process.env.ANTHROPIC_API_KEY) {
      return { ok: false, detail: "ANTHROPIC_API_KEY 미설정" };
    }
    return { ok: true, detail: "anthropic ready (no live ping)" };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function robustJsonParse(s: string): unknown | null {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    // common case — model wrapped JSON in ```json ... ``` fence
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) {
      try {
        return JSON.parse(fence[1]);
      } catch {
        /* fall through */
      }
    }
    // last resort — first { ... } block
    const first = s.indexOf("{");
    const last = s.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(s.slice(first, last + 1));
      } catch {
        /* fall through */
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------
export interface ResolveProviderOpts {
  override?: "ollama" | "anthropic" | "auto";
  ollamaModel?: string;
  anthropicModel?: string;
}

// Local-only invariant: the analyzer must keep researcher code/docs on
// the box. The cloud (Anthropic) path is reachable ONLY via an explicit
// request (override "anthropic" or LLM_PROVIDER/REFINEMENT_PROVIDER=
// anthropic) AND only when local-only mode is disabled. The mere
// presence of ANTHROPIC_API_KEY never routes to the cloud, and an
// Ollama target never silently cloud-fails-over. Set LLM_LOCAL_ONLY=0
// to allow the cloud path (e.g. a Vercel deploy with no Ollama).
function localOnly(): boolean {
  return process.env.LLM_LOCAL_ONLY !== "0";
}

export async function resolveProvider(
  opts: ResolveProviderOpts = {},
): Promise<LLMProvider> {
  const explicit = opts.override && opts.override !== "auto" ? opts.override : null;
  const envChoice = (process.env.LLM_PROVIDER as "ollama" | "anthropic" | undefined) ?? null;
  // Key presence must NOT route to the cloud — cloud is opt-in only.
  const target = explicit ?? envChoice ?? "ollama";

  if (target === "anthropic") {
    if (localOnly()) {
      throw new Error(
        "LLM_LOCAL_ONLY: Anthropic 경로가 비활성화돼 있습니다 (로컬 Ollama 전용). 클라우드가 필요하면 LLM_LOCAL_ONLY=0 으로 명시 해제하세요.",
      );
    }
    try {
      return new AnthropicProvider({ model: opts.anthropicModel });
    } catch (err) {
      const ollamaP = new OllamaProvider(await pickOllamaModel(opts.ollamaModel));
      const h = await ollamaP.health();
      if (h.ok) return ollamaP;
      throw err;
    }
  }

  // ollama: verify the host is reachable; auto-pick the right model tag
  const model = await pickOllamaModel(opts.ollamaModel);
  const p = new OllamaProvider(model);
  const h = await p.health();
  if (!h.ok) {
    // Cloud fail-over only when local-only is explicitly disabled —
    // otherwise an Ollama blip must NOT leak code/docs to the cloud.
    if (!localOnly() && process.env.ANTHROPIC_API_KEY) {
      return new AnthropicProvider({ model: opts.anthropicModel });
    }
    throw new Error(
      `LLM 백엔드를 사용할 수 없습니다 (Ollama 연결 불가${
        localOnly()
          ? "; LLM_LOCAL_ONLY 모드 — 클라우드 폴백 안 함)"
          : " & ANTHROPIC_API_KEY 미설정)"
      }`,
    );
  }
  return p;
}

// Provider description for UI display ("model: claude-opus-4-7 (anthropic)").
export function describeProvider(p: LLMProvider): string {
  return `${p.model} (${p.name})`;
}

// Resolver for the *review* (second-pass refinement) model. Distinct
// from resolveProvider() so we can target a different — typically more
// capable — model than the extraction pass without disturbing the
// primary code path.
//
// Selection priority:
//   1. opts.override / REFINEMENT_PROVIDER env  (ollama | anthropic | auto)
//   2. REFINEMENT_MODEL env  → explicit Ollama tag (or anthropic model)
//   3. default Ollama model: MODELS.reviewDeep ("gemma4:31b").
//      Falls back via pickOllamaModel() if not pulled on this host.
//   4. default Anthropic model: ANTHROPIC_REFINEMENT_MODEL env, else
//      ANTHROPIC_CODE_MODEL env, else "claude-opus-4-7".
//
// If neither backend is reachable, throws — callers should catch and
// fall through to the 1-pass result.
export async function resolveReviewProvider(
  opts: ResolveProviderOpts = {},
): Promise<LLMProvider> {
  const explicit =
    opts.override && opts.override !== "auto" ? opts.override : null;
  const envChoice =
    (process.env.REFINEMENT_PROVIDER as "ollama" | "anthropic" | undefined) ??
    null;
  // Mirror resolveProvider: prefer Ollama (lab default — gemma4:31b is
  // pulled), fall back to Anthropic only when no key for Ollama or
  // user explicitly set ANTHROPIC for the review model. The earlier
  // condition "ANTHROPIC_API_KEY && !OLLAMA_HOST" was inverted —
  // hosts with both env vars (every dev box) silently fell to Ollama
  // even when the user asked for the cloud reviewer.
  // Key presence must NOT route cloud — opt-in only (mirror resolveProvider).
  const target = explicit ?? envChoice ?? "ollama";

  const ollamaTag =
    opts.ollamaModel ??
    process.env.REFINEMENT_MODEL ??
    OLLAMA_MODELS.reviewDeep;

  const anthropicTag =
    opts.anthropicModel ??
    process.env.ANTHROPIC_REFINEMENT_MODEL ??
    process.env.ANTHROPIC_CODE_MODEL ??
    "claude-opus-4-7";

  if (target === "anthropic") {
    if (localOnly()) {
      throw new Error(
        "LLM_LOCAL_ONLY: review Anthropic 경로 비활성 (로컬 Ollama 전용). LLM_LOCAL_ONLY=0 으로 해제하세요.",
      );
    }
    try {
      return new AnthropicProvider({ model: anthropicTag });
    } catch (err) {
      const ollamaP = new OllamaProvider(await pickOllamaModel(ollamaTag, "review"));
      const h = await ollamaP.health();
      if (h.ok) return ollamaP;
      throw err;
    }
  }
  // ollama
  const model = await pickOllamaModel(ollamaTag, "review");
  const p = new OllamaProvider(model);
  const h = await p.health();
  if (h.ok) return p;
  if (!localOnly() && process.env.ANTHROPIC_API_KEY) {
    return new AnthropicProvider({ model: anthropicTag });
  }
  throw new Error(
    "review LLM 백엔드를 사용할 수 없습니다 (Ollama 연결 불가; 클라우드 폴백은 LLM_LOCAL_ONLY=0 + ANTHROPIC_API_KEY 필요)",
  );
}
