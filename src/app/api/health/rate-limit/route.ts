// GET /api/health/rate-limit
//
// Operator probe — exposes the per-Lambda-instance rate-limit
// diagnostics added in iter 35 (hidden-couplings.md #21). The
// `buckets` Map lives in process memory, so the response describes
// THE SPECIFIC Lambda instance that handled this request.
//
// To estimate the cluster-wide multiplier:
//   * Call this endpoint several times in quick succession (curl -L
//     or a small loop). Vercel's load balancer fans the requests out
//     across warm instances.
//   * Group the responses by `pid`. The number of distinct pids
//     observed within a short window approximates the warm-instance
//     count; multiply by the configured rate-limit cap for the real
//     effective ceiling.
//
// Same cron-secret auth scheme as the other /api/health/* endpoints.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authorizeCronRequest } from "@/lib/auth/cron-secret";
import { getRateLimitDiagnostics } from "@/lib/utils/rate-limit";

export async function GET(request: NextRequest) {
  if (!authorizeCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const diag = getRateLimitDiagnostics();

  return NextResponse.json({
    ok: true,
    pid: diag.pid,
    bucket_count: diag.bucketCount,
    warned: diag.warned,
    note:
      "Per-Lambda snapshot. Call repeatedly + group by pid to count " +
      "warm instances; cluster cap = configured cap × distinct pids. " +
      "See hidden-couplings.md #21.",
  });
}
