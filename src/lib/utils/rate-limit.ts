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
