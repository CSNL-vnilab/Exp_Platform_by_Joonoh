// GET /api/health/secret-audit
//
// Cron-secret-gated operator probe. Walks every known stateless-token
// module's secret chain against the current process.env and reports
// which env var actually resolves. Surfaces the SUPABASE_SERVICE_ROLE_KEY
// fallback footgun (refactor-roadmap A3 / hidden-couplings #23) — an
// operator can spot a misconfigured deploy without grepping logs for
// [secret-source] warnings.
//
// Auth: same x-cron-secret / Bearer scheme as the cron endpoints, so
// this endpoint can be probed from a scheduled GH Actions step as well
// as from operator curl. NEVER exposes secret values, only env var
// NAMES that resolved.
//
// Returns 200 always. The "anyFellThroughToServiceRole" flag in the
// JSON body is the operator's primary signal — if true, set the primary
// secrets explicitly before the next service-role rotation.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authorizeCronRequest } from "@/lib/auth/cron-secret";
import { auditTokenSecrets } from "@/lib/auth/secret-source";

export async function GET(request: NextRequest) {
  if (!authorizeCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const audit = auditTokenSecrets();
  const anyFellThroughToServiceRole = audit.some(
    (a) => a.fellThroughToServiceRole,
  );
  const anyMissing = audit.some((a) => a.resolvedFrom === null);

  return NextResponse.json({
    ok: !anyFellThroughToServiceRole && !anyMissing,
    anyFellThroughToServiceRole,
    anyMissing,
    audit,
    documentation: "DEPLOY.md → Token-secret rotation 주의",
  });
}
