export const OLLAMA_HOST =
  process.env.OLLAMA_HOST?.replace(/\/$/, "") ?? "http://127.0.0.1:11434";

export const MODELS = {
  // Reviewer (pass-2): gemma4:26b is what the lab box has pulled
  // (gemma4:31b OOMs / isn't present here). Both slots point at it.
  reviewDeep: "gemma4:26b",
  reviewFast: "gemma4:26b",
  reasoning: "qwen3.6:36b",
  // Code-analysis (pass-1): qwen3.6 MoE (36b-A3B) is the strongest
  // local extractor; the 27b dense is the fallback. The runtime
  // resolver (pickOllamaModel) walks CODE_ANALYSIS_PREFS and binds to
  // whichever tag is *actually pulled* — so a stale "qwen3.6:latest"
  // default can't 404 anymore. Override via env OFFLINE_CODE_MODEL.
  codeAnalysis: process.env.OFFLINE_CODE_MODEL ?? "qwen3.6:36b",
  codeAnalysisFallback: "qwen3.6:27b",
  embedding: "qwen3-embedding:8b",
  embeddingLite: "bge-m3:latest",
  ocr: "glm-ocr:latest",
} as const;

// Preference order the resolver tries when the requested tag isn't
// pulled. Kept here so model policy lives in one place. The resolver
// also falls back to *any* present tag of the same family before it
// gives up, so an unlisted custom tag (e.g. "qwen3.6:36b-q5") still
// works without code changes.
export const CODE_ANALYSIS_PREFS = [
  "qwen3.6:36b",
  "qwen3.6:27b",
  "qwen3.6:latest",
] as const;

export const REVIEW_PREFS = [
  "gemma4:26b",
  "gemma4:31b",
  "qwen3.6:36b",
] as const;

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
