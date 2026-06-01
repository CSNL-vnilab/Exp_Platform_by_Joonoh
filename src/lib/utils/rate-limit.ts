// In-memory sliding-window rate limiter.
//
// Defense-in-depth, NOT a security boundary on its own:
// - Vercel serverless lambdas can run in multiple warm instances → an
//   attacker hitting from many IPs (or the same IP through different
//   edge POPs) can multiply the cap by the instance count.
// - Cold-start resets the counter.
//
// What it WILL stop:
// - A single client hammering one URL hundreds of times per minute
//   from a single instance — by far the most common abuse pattern.
// - The cumulative-cost portion of brute force / enumeration attacks.
//
// What it WON'T stop:
// - Distributed attacks across many IPs.
// - Coordinated multi-instance abuse on Vercel.
//
// For real anti-abuse: add a Vercel WAF rule, or replace this module
// with a Supabase-backed counter + atomic UPDATE … RETURNING. This
// helper is the cheap-shot first line.
//
// Runtime observability (iter 35, 2026-06-01 / hidden-couplings #21):
// - On the FIRST `rateLimit()` invocation per process the limiter
//   logs a single `[rate-limit] per-Lambda` warning, including the
//   `process.pid`. Operators can count distinct log lines over a
//   window in Vercel logs to estimate the real cap multiplier
//   (cap × distinct-pids).
// - `getRateLimitDiagnostics()` returns the current bucket count
//   for the calling Lambda instance. Add it to a future
//   `/api/health/rate-limit` if/when KV-backed migration is
//   prioritised (refactor-roadmap E2).

export interface RateLimitOptions {
  /** Window in milliseconds. */
  windowMs: number;
  /** Max attempts per key per window. */
  max: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Number of attempts already recorded in the window (including this one if allowed). */
  count: number;
  /** ms until the first attempt in the window expires — i.e. when the next attempt would slot in. */
  retryAfterMs: number;
}

// Keyed by `${prefix}:${key}` so different limiters share the same map.
// Each entry stores the timestamps of attempts within the window.
const buckets = new Map<string, number[]>();

// One-shot per process. Surfaces in Vercel logs as
//   `[rate-limit] per-Lambda in-memory bucket (pid=…) — hidden-couplings #21`
// so operators can count distinct pids and estimate the real cap
// multiplier under load. Pid is included rather than a random uuid
// because warm Lambda instances reuse pids across requests, making
// dedup straightforward.
let warnedAboutPerLambda = false;
function warnOncePerProcess(): void {
  if (warnedAboutPerLambda) return;
  warnedAboutPerLambda = true;
  // process.pid is always defined under Node runtime; Vercel functions
  // run on Node so this is safe. Guard against edge runtimes regardless.
  const pid =
    typeof process !== "undefined" && typeof process.pid === "number"
      ? process.pid
      : "edge";
  console.warn(
    `[rate-limit] per-Lambda in-memory bucket (pid=${pid}) — hidden-couplings #21. ` +
      "Real cap = configured cap × distinct warm instances. " +
      "Count distinct pids in Vercel logs over a window to estimate.",
  );
}

// Periodic cleanup so the map doesn't grow unbounded with one-off keys.
// Runs every minute, drops entries with no recent activity.
let cleanupHandle: NodeJS.Timeout | null = null;
function ensureCleanup(maxIdleMs: number) {
  if (cleanupHandle) return;
  cleanupHandle = setInterval(() => {
    const cutoff = Date.now() - maxIdleMs;
    for (const [k, arr] of buckets) {
      const last = arr[arr.length - 1] ?? 0;
      if (last < cutoff) buckets.delete(k);
    }
  }, 60_000);
  // unref so the timer doesn't keep the Lambda alive after a request.
  if (typeof cleanupHandle === "object" && cleanupHandle && "unref" in cleanupHandle) {
    (cleanupHandle as { unref?: () => void }).unref?.();
  }
}

/**
 * Record an attempt against (prefix, key) and return whether it's allowed.
 * Caller chooses the policy on result.allowed=false (HTTP 429, log, etc).
 */
export function rateLimit(
  prefix: string,
  key: string,
  opts: RateLimitOptions,
): RateLimitResult {
  warnOncePerProcess();
  ensureCleanup(opts.windowMs * 4);
  const bucketKey = `${prefix}:${key}`;
  const now = Date.now();
  const cutoff = now - opts.windowMs;

  const existing = buckets.get(bucketKey) ?? [];
  // Drop expired timestamps.
  const recent = existing.filter((t) => t >= cutoff);

  if (recent.length >= opts.max) {
    // Reject — don't record this attempt, otherwise legitimate retries
    // after the window closes would chain forever.
    const oldest = recent[0];
    return {
      allowed: false,
      count: recent.length,
      retryAfterMs: Math.max(0, oldest + opts.windowMs - now),
    };
  }

  recent.push(now);
  buckets.set(bucketKey, recent);
  return { allowed: true, count: recent.length, retryAfterMs: 0 };
}

/** Test helper — clear all buckets. NEVER call from production code. */
export function _resetRateLimitForTests(): void {
  buckets.clear();
}

/**
 * Snapshot of this Lambda instance's bucket count + a per-process pid
 * for cross-instance comparison. Side-effect-free; safe to call from a
 * future `/api/health/rate-limit` probe. Numbers are inherently
 * per-instance — operator must aggregate across distinct pids to see
 * cluster-wide state.
 */
export function getRateLimitDiagnostics(): {
  pid: number | "edge";
  bucketCount: number;
  warned: boolean;
} {
  return {
    pid:
      typeof process !== "undefined" && typeof process.pid === "number"
        ? process.pid
        : "edge",
    bucketCount: buckets.size,
    warned: warnedAboutPerLambda,
  };
}
