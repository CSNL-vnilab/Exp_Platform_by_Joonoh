#!/usr/bin/env node
// Local AI code reviewer using Ollama.
// Usage:
//   node scripts/review.mjs [--deep|--fast] [--model <name>] [paths...]
//   git diff | node scripts/review.mjs --deep
//
// Defaults:
//   - Picks gemma4:31b for deep review, gemma4:26b for fast review.
//   - Reads stdin if no paths given; otherwise concatenates file contents.

import { readFile } from "node:fs/promises";
import { argv, stdin, stdout } from "node:process";

const HOST = process.env.OLLAMA_HOST?.replace(/\/$/, "") ?? "http://127.0.0.1:11434";

function parseArgs(args) {
  const opts = { model: null, depth: "auto", paths: [] };
  for (let i = 2; i < args.length; i++) {
    const a = args[i];
    if (a === "--deep") opts.depth = "deep";
    else if (a === "--fast") opts.depth = "fast";
    else if (a === "--model") opts.model = args[++i];
    else if (a === "--help" || a === "-h") opts.help = true;
    else opts.paths.push(a);
  }
  return opts;
}

async function readStdin() {
  if (stdin.isTTY) return "";
  const chunks = [];
  for await (const c of stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

async function readPaths(paths) {
  const parts = [];
  for (const p of paths) {
    const body = await readFile(p, "utf8");
    parts.push(`--- ${p} ---\n${body}`);
  }
  return parts.join("\n\n");
}

function pickModel({ depth, model, length }) {
  if (model) return model;
  if (depth === "deep") return "gemma4:31b";
  if (depth === "fast") return "gemma4:26b";
  return length > 32_000 ? "gemma4:31b" : "gemma4:26b";
}

const SYSTEM = `너는 시니어 코드 리뷰어다. 한국어로 답한다.
형식:
1) 요약 (2-3줄)
2) 이슈 목록: 각 항목에 [CRITICAL|HIGH|MED|LOW] 태그 + 파일:라인 + 근거 + 권장 수정
3) 놓친 보안/성능/UX 관점이 있으면 별도 섹션.
추측은 금지하고 제공된 코드에서만 판단해라.`;

async function main() {
  const opts = parseArgs(argv);
  if (opts.help) {
    stdout.write("Usage: node scripts/review.mjs [--deep|--fast] [--model X] [paths...]\n");
    return;
  }

  const content = opts.paths.length ? await readPaths(opts.paths) : await readStdin();
  if (!content.trim()) {
    stdout.write("에러: 리뷰할 입력이 없습니다. 파일 경로를 주거나 stdin으로 git diff를 파이프하세요.\n");
    process.exit(1);
  }

  const model = pickModel({ depth: opts.depth, model: opts.model, length: content.length });
  stdout.write(`▶ model=${model}  bytes=${content.length}\n\n`);

  const res = await fetch(`${HOST}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content },
      ],
      stream: true,
      options: { temperature: 0.2, num_ctx: 16_384, num_predict: 4_096 },
    }),
  });

  if (!res.ok || !res.body) {
    stdout.write(`Ollama error: ${res.status} ${await res.text().catch(() => "")}\n`);
    process.exit(2);
  }

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
        const obj = JSON.parse(line);
        if (obj.message?.content) stdout.write(obj.message.content);
      } catch {
        // ignore malformed chunk
      }
    }
  }
  stdout.write("\n");
}

main().catch((e) => {
  stdout.write(`\n[fatal] ${e.message}\n`);
  process.exit(1);
});
