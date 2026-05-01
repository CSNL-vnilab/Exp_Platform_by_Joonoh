import { OLLAMA_HOST, modelFor, type Task } from "./models";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  images?: string[];
}

export interface GenerateOptions {
  model?: string;
  task?: Task;
  prompt: string;
  system?: string;
  temperature?: number;
  num_ctx?: number;
  num_predict?: number;
  signal?: AbortSignal;
}

export interface ChatOptions {
  model?: string;
  task?: Task;
  messages: ChatMessage[];
  temperature?: number;
  num_ctx?: number;
  num_predict?: number;
  signal?: AbortSignal;
}

export interface EmbedOptions {
  task?: Task;
  model?: string;
  input: string | string[];
  signal?: AbortSignal;
}

function resolveModel(explicit: string | undefined, task: Task | undefined, fallback: Task): string {
  if (explicit) return explicit;
  return modelFor(task ?? fallback);
}

// Ollama generations on a strengthened prompt can take 4-10 minutes
// (qwen3.6 with num_predict=12288 + checklist self-verification). The
// undici default Headers Timeout is 5 minutes, which trips before the
// first byte arrives. We use a Node-only undici Agent with extended
// timeouts; on non-Node runtimes (Edge) we fall back to plain fetch.
let ollamaDispatcher: unknown = null;
async function getDispatcher(): Promise<unknown> {
  if (ollamaDispatcher !== null) return ollamaDispatcher;
  try {
    const undici = await import("undici");
    const Agent = (undici as { Agent: new (opts: object) => unknown }).Agent;
    ollamaDispatcher = new Agent({
      headersTimeout: 15 * 60 * 1000, // 15 min
      bodyTimeout: 15 * 60 * 1000,
      keepAliveTimeout: 60_000,
    });
  } catch {
    ollamaDispatcher = false;
  }
  return ollamaDispatcher;
}

async function ollamaFetch(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  const dispatcher = await getDispatcher();
  const init: RequestInit & { dispatcher?: unknown } = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  };
  if (dispatcher && dispatcher !== false) init.dispatcher = dispatcher;
  const res = await fetch(`${OLLAMA_HOST}${path}`, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Ollama ${path} ${res.status}: ${text.slice(0, 200)}`);
  }
  return res;
}

export async function generate(opts: GenerateOptions): Promise<string> {
  const model = resolveModel(opts.model, opts.task, "review.fast");
  const res = await ollamaFetch(
    "/api/generate",
    {
      model,
      prompt: opts.prompt,
      system: opts.system,
      stream: false,
      options: {
        temperature: opts.temperature ?? 0.2,
        num_ctx: opts.num_ctx ?? 8192,
        num_predict: opts.num_predict ?? 2048,
      },
    },
    opts.signal,
  );
  const data = (await res.json()) as { response?: string };
  return data.response ?? "";
}

export interface ChatJsonOptions extends ChatOptions {
  // Optional JSON-Schema string. Ollama accepts a schema object via
  // `format` on supported models; we pass it through verbatim. When
  // omitted, the request just sets `format: "json"` so the model
  // produces parseable JSON.
  schema?: string | object;
  // For thinking-models (Qwen3.6, deepseek-r1, …), thinking tokens
  // count against `num_predict` and frequently exhaust the budget on
  // long-context structured output. Default `think: false` keeps the
  // model in non-thinking mode, which is what we want for extraction.
  think?: boolean;
}

export async function chatJson<T = unknown>(opts: ChatJsonOptions): Promise<T> {
  const model = resolveModel(opts.model, opts.task, "code.analysis");
  const format =
    opts.schema == null
      ? "json"
      : typeof opts.schema === "string"
        ? safeParseJson(opts.schema) ?? "json"
        : opts.schema;
  const body: Record<string, unknown> = {
    model,
    messages: opts.messages,
    stream: false,
    format,
    think: opts.think ?? false,
    options: {
      temperature: opts.temperature ?? 0.1,
      num_ctx: opts.num_ctx ?? 32_768,
      num_predict: opts.num_predict ?? 4_096,
    },
  };
  const res = await ollamaFetch("/api/chat", body, opts.signal);
  const data = (await res.json()) as { message?: { content?: string } };
  const raw = data.message?.content ?? "";
  const parsed = safeParseJson(raw);
  if (parsed == null) {
    throw new Error(`chatJson: model returned non-JSON: ${raw.slice(0, 200)}`);
  }
  return parsed as T;
}

function safeParseJson(s: string): unknown | null {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    // tolerate ```json fenced blocks
    const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m) {
      try {
        return JSON.parse(m[1]);
      } catch {
        /* fall through to repair */
      }
    }
    // Last-ditch repair for late-truncated streams: find the last
    // balanced close-brace before the cutoff. Walk forward tracking
    // brace/bracket depth + string state, and remember the position
    // each time we close back to depth 0. Then close any open scopes
    // up to that position. Loses the truncated tail but salvages the
    // top-level object — far better than nothing.
    const repaired = repairTruncatedJson(s);
    if (repaired) {
      try {
        return JSON.parse(repaired);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function repairTruncatedJson(s: string): string | null {
  // Stack-based recovery for late-truncated streams. Earlier version
  // tracked only an integer depth and naively emitted `}` for every
  // open scope, producing structurally invalid JSON when an array was
  // open at cutoff. This version tracks the actual stack of opener
  // chars and emits matching closers in reverse stack order.
  //
  // Returns a parseable substring (with closers appended) covering as
  // much of the original object as possible, or null if no safe
  // truncation point exists.
  const start = s.indexOf("{");
  if (start < 0) return null;
  const stack: string[] = []; // entries: '{' or '['
  let inStr = false;
  let escape = false;
  // Last safe truncation point: position *just after* the last
  // complete value that closed back to the outer object's depth >= 1.
  // Setting only at depth >= 1 keeps the outer `{ ... }` intact.
  let safeCut = -1;
  let safeStack: string[] = [];
  for (let i = start; i < s.length; i += 1) {
    const c = s[i];
    if (escape) { escape = false; continue; }
    if (inStr) {
      if (c === "\\") escape = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "{" || c === "[") stack.push(c);
    else if (c === "}" || c === "]") {
      const top = stack.pop();
      const expected = c === "}" ? "{" : "[";
      if (top !== expected) return null; // malformed input -- bail
      // After popping, if we are still inside the outer object, this
      // is a clean truncation point (a complete value just ended).
      if (stack.length >= 1) {
        safeCut = i + 1;
        safeStack = stack.slice();
      }
    } else if (c === "," && stack.length >= 1) {
      safeCut = i; // drop the trailing comma when we slice
      safeStack = stack.slice();
    }
  }
  // If the cut would be inside an unterminated string, give up.
  if (inStr) return null;
  if (safeCut < 0) return null;
  let trimmed = s.slice(start, safeCut).replace(/,\s*$/, "");
  // Close scopes in reverse order with the matching closer.
  for (let i = safeStack.length - 1; i >= 0; i -= 1) {
    trimmed += safeStack[i] === "{" ? "}" : "]";
  }
  return trimmed;
}

export async function chat(opts: ChatOptions): Promise<string> {
  const model = resolveModel(opts.model, opts.task, "reason");
  const res = await ollamaFetch(
    "/api/chat",
    {
      model,
      messages: opts.messages,
      stream: false,
      options: {
        temperature: opts.temperature ?? 0.2,
        num_ctx: opts.num_ctx ?? 8192,
        num_predict: opts.num_predict ?? 2048,
      },
    },
    opts.signal,
  );
  const data = (await res.json()) as { message?: { content?: string } };
  return data.message?.content ?? "";
}

export async function* streamChat(opts: ChatOptions): AsyncGenerator<string> {
  const model = resolveModel(opts.model, opts.task, "reason");
  const res = await ollamaFetch(
    "/api/chat",
    {
      model,
      messages: opts.messages,
      stream: true,
      options: {
        temperature: opts.temperature ?? 0.2,
        num_ctx: opts.num_ctx ?? 8192,
        num_predict: opts.num_predict ?? 2048,
      },
    },
    opts.signal,
  );
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as { message?: { content?: string }; done?: boolean };
        if (obj.message?.content) yield obj.message.content;
      } catch {
        // skip malformed chunk
      }
    }
  }
}

export async function embed(opts: EmbedOptions): Promise<number[][]> {
  const model = resolveModel(opts.model, opts.task, "embed");
  const res = await ollamaFetch(
    "/api/embed",
    { model, input: opts.input },
    opts.signal,
  );
  const data = (await res.json()) as { embeddings?: number[][] };
  return data.embeddings ?? [];
}

export async function listModels(): Promise<string[]> {
  const res = await fetch(`${OLLAMA_HOST}/api/tags`);
  if (!res.ok) throw new Error(`Ollama /api/tags ${res.status}`);
  const data = (await res.json()) as { models?: Array<{ name: string }> };
  return (data.models ?? []).map((m) => m.name);
}

export async function ping(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
