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

async function ollamaFetch(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  const res = await fetch(`${OLLAMA_HOST}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
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
