export const OLLAMA_HOST =
  process.env.OLLAMA_HOST?.replace(/\/$/, "") ?? "http://127.0.0.1:11434";

export const MODELS = {
  reviewDeep: "gemma4:31b",
  reviewFast: "gemma4:26b",
  reasoning: "qwen3.6:latest",
  embedding: "qwen3-embedding:8b",
  embeddingLite: "bge-m3:latest",
  ocr: "glm-ocr:latest",
} as const;

export type ModelKey = keyof typeof MODELS;

export type Task =
  | "review.deep"
  | "review.fast"
  | "reason"
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
