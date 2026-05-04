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
  listModels as ollamaListModels,
  type ChatMessage,
} from "@/lib/ollama";

export interface LLMChatJsonOptions {
  messages: ChatMessage[];
  temperature?: number;
  num_predict?: number;
  num_ctx?: number;
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
      signal: opts.signal,
    });
  }
  async health() {
    const ok = await ollamaPing();
    return { ok, detail: ok ? "ollama reachable" : "ollama unreachable" };
  }
}

// Resolve a model that's actually pulled on this Ollama host. Cached
// for 60s to keep request latency low.
let ollamaModelCache: { value: string; expires: number } | null = null;
export async function pickOllamaModel(preferred?: string): Promise<string> {
  if (ollamaModelCache && ollamaModelCache.expires > Date.now()) return ollamaModelCache.value;
  const want = preferred ?? ollamaModelFor("code.analysis");
  const fb = OLLAMA_MODELS.codeAnalysisFallback;
  let chosen = want;
  try {
    const tags = await ollamaListModels();
    const has = (t: string) => tags.includes(t) || tags.some((x) => x.startsWith(`${t.split(":")[0]}:`));
    if (!has(want) && has(fb)) chosen = fb;
  } catch {
    // network glitch — keep `want`
  }
  ollamaModelCache = { value: chosen, expires: Date.now() + 60_000 };
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
    const block = res.content.find((b) => b.type === "text");
    return block && "text" in block ? block.text : "";
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

export async function resolveProvider(
  opts: ResolveProviderOpts = {},
): Promise<LLMProvider> {
  const explicit = opts.override && opts.override !== "auto" ? opts.override : null;
  const envChoice = (process.env.LLM_PROVIDER as "ollama" | "anthropic" | undefined) ?? null;
  const target =
    explicit ??
    envChoice ??
    (process.env.ANTHROPIC_API_KEY ? "anthropic" : "ollama");

  if (target === "anthropic") {
    // Symmetric fallback: if Anthropic is unconfigured AND Ollama is
    // reachable, fall through to Ollama instead of throwing on every
    // analyzer call (review item #5). The reverse direction already
    // does this below.
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
    // last-resort: if Anthropic key exists, fall over to it instead of
    // throwing — keeps the analyzer alive on a host where Ollama is
    // momentarily down but the cloud key is configured.
    if (process.env.ANTHROPIC_API_KEY) {
      return new AnthropicProvider({ model: opts.anthropicModel });
    }
    throw new Error("LLM 백엔드를 사용할 수 없습니다 (Ollama unreachable & ANTHROPIC_API_KEY 미설정)");
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
  const target =
    explicit ??
    envChoice ??
    (process.env.ANTHROPIC_API_KEY && !process.env.OLLAMA_HOST
      ? "anthropic"
      : "ollama");

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
    try {
      return new AnthropicProvider({ model: anthropicTag });
    } catch (err) {
      const ollamaP = new OllamaProvider(await pickOllamaModel(ollamaTag));
      const h = await ollamaP.health();
      if (h.ok) return ollamaP;
      throw err;
    }
  }
  // ollama
  const model = await pickOllamaModel(ollamaTag);
  const p = new OllamaProvider(model);
  const h = await p.health();
  if (h.ok) return p;
  if (process.env.ANTHROPIC_API_KEY) {
    return new AnthropicProvider({ model: anthropicTag });
  }
  throw new Error(
    "review LLM 백엔드를 사용할 수 없습니다 (Ollama unreachable & ANTHROPIC_API_KEY 미설정)",
  );
}
