// Dev-only authentication bypass for the analyzer surface. Off by
// default; honoured only when:
//
//   1. NODE_ENV is one of the explicit dev/test allow-list values
//      ("development" or "test"). The previous "!= production" check
//      meant a Docker image with NODE_ENV unset (= undefined) treated
//      itself as dev — review item #6.
//   2. ANALYZER_DEV_BYPASS env flag is "1".
//
// Both conditions must be true. A misconfigured staging deploy that
// only forgets `NODE_ENV` cannot accidentally drop auth.
//
// Logs a stderr warning on first call when active so an operator who
// scans logs sees that the bypass is engaged.

const ALLOWED_DEV_ENVS = new Set(["development", "test"]);
let warned = false;

export function analyzerAuthBypassActive(): boolean {
  const env = process.env.NODE_ENV ?? "";
  if (!ALLOWED_DEV_ENVS.has(env)) return false;
  if (process.env.ANALYZER_DEV_BYPASS !== "1") return false;
  if (!warned) {
    warned = true;
    console.warn(
      "[analyzer] ANALYZER_DEV_BYPASS=1 active in NODE_ENV=%s — auth gate skipped on /api/experiments/code-analysis* endpoints",
      env,
    );
  }
  return true;
}
