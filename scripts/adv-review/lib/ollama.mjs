// Ollama streaming client for the adversarial review harness.
// Minimal, no deps. Surfaces first-token timeout + per-request timeout.

const HOST = process.env.OLLAMA_HOST?.replace(/\/$/, "") ?? "http://127.0.0.1:11434";

export async function streamChat({ model, messages, options, think, timeouts, onToken }) {
  const controller = new AbortController();
  const firstTokenMs = timeouts?.firstTokenMs ?? 300_000;
  const requestMs = timeouts?.requestMs ?? 900_000;
  const overall = setTimeout(() => controller.abort(new Error("request timeout")), requestMs);
  let firstTokenTimer = setTimeout(
    () => controller.abort(new Error("first-token timeout")),
    firstTokenMs,
  );

  try {
    const body = { model, messages, stream: true, options };
    if (think !== undefined) body.think = think;
    const res = await fetch(`${HOST}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`Ollama ${res.status}: ${text.slice(0, 400)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let full = "";
    let meta = null;
    let firstSeen = false;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        const piece = obj.message?.content;
        if (piece) {
          if (!firstSeen) {
            firstSeen = true;
            clearTimeout(firstTokenTimer);
          }
          full += piece;
          if (onToken) onToken(piece);
        }
        if (obj.done) {
          meta = {
            eval_count: obj.eval_count,
            prompt_eval_count: obj.prompt_eval_count,
            total_duration_ns: obj.total_duration,
            load_duration_ns: obj.load_duration,
          };
        }
      }
    }
    return { text: full, meta };
  } finally {
    clearTimeout(overall);
    clearTimeout(firstTokenTimer);
  }
}

export async function ping() {
  try {
    const res = await fetch(`${HOST}/api/tags`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function warmup(model) {
  try {
    const res = await fetch(`${HOST}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: "ok",
        stream: false,
        keep_alive: "30m",
        options: { num_predict: 1, temperature: 0 },
      }),
      signal: AbortSignal.timeout(600_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function hasModel(name) {
  try {
    const res = await fetch(`${HOST}/api/tags`);
    if (!res.ok) return false;
    const data = await res.json();
    return (data.models ?? []).some((m) => m.name === name);
  } catch {
    return false;
  }
}
