// Notion API rate-limit aware fetch wrapper.
//
// Design motivation (from research 2026-04):
//   * Notion API version 2026-04-01 exposes X-RateLimit-Limit / Remaining /
//     Reset headers on EVERY response — not just 429s. We can back off
//     pre-emptively before hitting the limit.
//   * Standard rate is 3 rps sustained per integration, with 10 rps burst.
//     Our current 400ms fixed delay (2.5 rps) is safe on the sustained
//     path but gets killed when a parent pipeline fires many Notion
//     writes back-to-back (e.g. a multi-session booking).
//   * On 429, Notion returns Retry-After in seconds. Always respect it.
//
// Contract:
//   * fetchNotion(path, init) returns the parsed JSON body or throws
//     RateLimitedError / NotionApiError.
//   * Caller should NOT retry on RateLimitedError — the wrapper has
//     already applied Retry-After + jitter and retried twice internally.
//   * On 429-after-retries, surface the error so the caller's outbox
//     can backoff at the application level.
//
// Intentionally NOT a full SDK — we only use rest/pages/databases.

const NOTION_VERSION = "2022-06-28";
const NOTION_BASE = "https://api.notion.com";

// Module-level counter, best-effort advisory — resets on serverless cold
// starts but useful for observability in the same invocation.
let lastKnownRemaining: number | null = null;
let lastKnownResetAt: number | null = null;

export class NotionRateLimitError extends Error {
  status: number;
  retryAfterSeconds: number;
  constructor(msg: string, status: number, retryAfterSeconds: number) {
    super(msg);
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class NotionApiError extends Error {
  status: number;
  body: unknown;
  constructor(msg: string, status: number, body: unknown) {
    super(msg);
    this.status = status;
    this.body = body;
  }
}

function jitterMs(maxMs = 500): number {
  return Math.floor(Math.random() * maxMs);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(h: string | null): number {
  if (!h) return 1;
  const n = Number.parseInt(h, 10);
  if (!Number.isFinite(n) || n < 0) return 1;
  return Math.min(n, 60); // cap at 60s — server is broken beyond that
}

// Read rate-limit headers and apply pre-emptive backoff if we're close
// to the limit. Called after every successful response.
async function updateRateLimitState(response: Response): Promise<void> {
  const remaining = response.headers.get("x-ratelimit-remaining");
  const resetAt = response.headers.get("x-ratelimit-reset");

  if (remaining != null) {
    const n = Number.parseInt(remaining, 10);
    if (Number.isFinite(n)) lastKnownRemaining = n;
  }
  if (resetAt != null) {
    const n = Number.parseInt(resetAt, 10);
    if (Number.isFinite(n)) lastKnownResetAt = n * 1000; // Unix seconds → ms
  }

  // Pre-emptive throttle: if we have fewer than 3 tokens left and the
  // bucket resets soon, wait until reset. Notion docs: bucket granularity
  // is 10 tokens / 3 seconds, so a near-empty bucket is one burst away
  // from a 429.
  if (
    lastKnownRemaining != null &&
    lastKnownRemaining < 3 &&
    lastKnownResetAt != null
  ) {
    const untilReset = Math.max(0, lastKnownResetAt - Date.now());
    if (untilReset > 0 && untilReset < 5_000) {
      await sleep(untilReset + jitterMs(200));
    }
  }
}

// Wrapped fetch. Handles auth header, Notion-Version, JSON body, and the
// 429 retry loop. Up to 2 retries on 429 (network-level retries are
// delegated to the platform's TCP retry).
export async function fetchNotion<T = unknown>(
  path: string,
  init: RequestInit = {},
  options: { maxRetries?: number } = {},
): Promise<T> {
  const token = process.env.NOTION_API_KEY;
  if (!token) {
    throw new NotionApiError("NOTION_API_KEY not configured", 0, null);
  }

  const maxRetries = options.maxRetries ?? 2;
  const url = path.startsWith("http") ? path : `${NOTION_BASE}${path}`;

  let attempt = 0;
  while (true) {
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });

    await updateRateLimitState(res);

    if (res.status === 429) {
      const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
      if (attempt >= maxRetries) {
        throw new NotionRateLimitError(
          `Notion 429 after ${attempt + 1} attempts`,
          429,
          retryAfter,
        );
      }
      attempt += 1;
      await sleep(retryAfter * 1000 + jitterMs(500));
      continue;
    }

    const body = await res.json().catch(() => null);

    if (!res.ok) {
      throw new NotionApiError(
        `Notion ${res.status}: ${JSON.stringify(body).slice(0, 300)}`,
        res.status,
        body,
      );
    }

    return body as T;
  }
}

// Read-only snapshot of observed rate-limit state — for diagnostics /
// dashboards.
export function notionRateLimitSnapshot(): {
  remaining: number | null;
  resetAtMs: number | null;
} {
  return {
    remaining: lastKnownRemaining,
    resetAtMs: lastKnownResetAt,
  };
}
