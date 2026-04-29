export const OLLAMA_HOST =
  process.env.OLLAMA_HOST?.replace(/\/$/, "") ?? "http://127.0.0.1:11434";

export const MODELS = {
  reviewDeep: "gemma4:31b",
  reviewFast: "gemma4:26b",
  reasoning: "qwen3.6:latest",
  // Code-analysis defaults to qwen3.6:latest — won the
  // scripts/prompt-bench.mjs sweep (save-focused preset + docs=Y →
  // 79.2% on the Magnitude experiment). Hosts that have pulled the
  // larger Qwen3.6-35B-A3B can override via env OFFLINE_CODE_MODEL;
  // the runtime resolver falls back to whichever qwen3.6:* tag exists.
  codeAnalysis: process.env.OFFLINE_CODE_MODEL ?? "qwen3.6:latest",
  codeAnalysisFallback: "qwen3.6:latest",
  embedding: "qwen3-embedding:8b",
  embeddingLite: "bge-m3:latest",
  ocr: "glm-ocr:latest",
} as const;

export type ModelKey = keyof typeof MODELS;

export type Task =
  | "review.deep"
  | "review.fast"
  | "reason"
  | "code.analysis"
  | "embed"
  | "embed.lite"
  | "ocr";

export function modelFor(task: Task): string {
  switch (task) {
    case "review.deep":
      return MODELS.reviewDeep;
    case "review.fast":
      return MODELS.reviewFast;
    case "reason":
      return MODELS.reasoning;
    case "code.analysis":
      return MODELS.codeAnalysis;
    case "embed":
      return MODELS.embedding;
    case "embed.lite":
      return MODELS.embeddingLite;
    case "ocr":
      return MODELS.ocr;
  }
}

export function pickReviewModel(tokensEstimate: number): string {
  return tokensEstimate > 8_000 ? MODELS.reviewDeep : MODELS.reviewFast;
}
