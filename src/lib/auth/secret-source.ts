// Centralized secret resolution for HMAC-token modules.
//
// Why this exists (refactor-roadmap A3 / hidden-couplings #23):
//
// Four stateless-token systems (run-token, payment-token, booking-edit
// token, booking-edit session cookie) plus the symmetric-crypto module
// each had their own ad-hoc fallback chain reaching into shared env
// vars and ultimately into SUPABASE_SERVICE_ROLE_KEY. Three problems:
//
//   1. **Rotation footgun.** Rotating SUPABASE_SERVICE_ROLE_KEY silently
//      invalidates every outstanding token whose deploy never set an
//      explicit token secret — including booking-edit URLs with a 60-day
//      TTL the participant may try to use weeks later. The chain made
//      the dependency invisible.
//
//   2. **Silent drift between modules.** The chains were copy-pasted but
//      not identical (payment-token went RUN→REGISTRATION while
//      booking-edit went BOOKING_EDIT→PAYMENT→RUN→REGISTRATION). A deploy
//      that set RUN_TOKEN_SECRET and assumed it covered "all stateless
//      tokens" silently got different keys for payment vs run.
//
//   3. **No deploy-time visibility.** Operators had no signal that a
//      box was running with the SUPABASE_SERVICE_ROLE_KEY fallback until
//      something broke.
//
// This helper unifies the resolution: each module declares its preferred
// name + a single shared-fallback list (capped at the "module-specific"
// secrets only; SUPABASE_SERVICE_ROLE_KEY is the absolute last resort
// AND triggers a warn-once log to the console + a process-wide flag the
// startup audit can read).
//
// Behavior preserved: deploys today that only set
// SUPABASE_SERVICE_ROLE_KEY continue to work; they now leave a
// breadcrumb. Phase B will turn the breadcrumb into a startup fail under
// STRICT_TOKEN_SECRETS=1.

const warnedSources = new Set<string>();
const fellThroughToServiceRole = new Set<string>();

export interface SecretChainEntry {
  /** Env var name. Required. */
  name: string;
  /** Free-text description of what this secret governs. Used in warnings. */
  purpose: string;
}

export interface ResolveOptions {
  /** Module's own primary env var (first checked). */
  primary: string;
  /**
   * Module-scoped fallbacks tried in order. Should be a deliberate,
   * documented allowlist — not the catch-all chain we used to have.
   */
  fallbacks?: string[];
  /**
   * Human-readable description of what this secret governs. Goes into
   * the breadcrumb log message so an operator searching for "why are
   * /payment-info tokens invalid" gets a directly relevant hit.
   */
  purpose: string;
}

/**
 * Walks `[primary, ...fallbacks, SUPABASE_SERVICE_ROLE_KEY]` in order,
 * returns the first non-empty value, and warns (once per primary) when
 * the chain fell through to SUPABASE_SERVICE_ROLE_KEY — because that
 * means a Supabase service-role rotation will silently invalidate every
 * outstanding token issued by this module.
 *
 * Throws if every source is unset.
 */
export function resolveSecret(opts: ResolveOptions): string {
  for (const name of [opts.primary, ...(opts.fallbacks ?? [])]) {
    const v = process.env[name];
    if (v && v.length > 0) return v;
  }
  const lastResort = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (lastResort && lastResort.length > 0) {
    if (!warnedSources.has(opts.primary)) {
      warnedSources.add(opts.primary);
      fellThroughToServiceRole.add(opts.primary);
      console.warn(
        `[secret-source] ${opts.primary} not set — ${opts.purpose} derived from ` +
          "SUPABASE_SERVICE_ROLE_KEY. Rotating the service role will silently " +
          `invalidate every outstanding token of this kind. Set ${opts.primary} ` +
          "in production.",
      );
    }
    return lastResort;
  }
  throw new Error(
    `${opts.primary} (or one of: ${(opts.fallbacks ?? []).join(", ") || "—"}, ` +
      "SUPABASE_SERVICE_ROLE_KEY) must be set",
  );
}

/**
 * For a startup audit endpoint. Returns the set of token systems
 * currently fallen through to SUPABASE_SERVICE_ROLE_KEY in this
 * process. Empty set = all token systems have explicit secrets.
 *
 * Note: a fresh Lambda cold-start won't have any state until each
 * module's getKey() has been invoked at least once. For a stateless
 * audit (no side effects, no warm-up required), use auditTokenSecrets()
 * below — it walks KNOWN_TOKEN_SECRETS directly against process.env.
 */
export function tokensFellThroughToServiceRole(): readonly string[] {
  return Array.from(fellThroughToServiceRole);
}

/**
 * Declarative registry of every stateless-token / symmetric-crypto
 * module that uses resolveSecret. Update this list when adding a new
 * token kind. The /api/health/secret-audit endpoint reads it.
 *
 * MUST mirror the resolveSecret() call inside each module — when you
 * add a fallback in payments/token.ts (for example), add it here too.
 */
export const KNOWN_TOKEN_SECRETS: ReadonlyArray<{
  module: string;
  primary: string;
  fallbacks: string[];
  /** TTL of tokens this key signs — informational, for the audit response. */
  tokenTtl: string;
}> = [
  {
    module: "payments/token",
    primary: "PAYMENT_TOKEN_SECRET",
    fallbacks: ["RUN_TOKEN_SECRET", "REGISTRATION_SECRET"],
    tokenTtl: "60 days",
  },
  {
    module: "booking-edit/token",
    primary: "BOOKING_EDIT_TOKEN_SECRET",
    fallbacks: [
      "PAYMENT_TOKEN_SECRET",
      "RUN_TOKEN_SECRET",
      "REGISTRATION_SECRET",
    ],
    tokenTtl: "60 days",
  },
  {
    module: "booking-edit/session",
    primary: "BOOKING_EDIT_SESSION_SECRET",
    fallbacks: [
      "BOOKING_EDIT_TOKEN_SECRET",
      "PAYMENT_TOKEN_SECRET",
      "RUN_TOKEN_SECRET",
      "REGISTRATION_SECRET",
    ],
    tokenTtl: "24 hours",
  },
  {
    module: "experiments/run-token",
    primary: "RUN_TOKEN_SECRET",
    fallbacks: ["REGISTRATION_SECRET"],
    tokenTtl: "14 days",
  },
  {
    module: "crypto/symmetric",
    primary: "REGISTRATION_SECRET",
    fallbacks: [],
    tokenTtl: "(storage lifetime)",
  },
];

export interface TokenSecretAudit {
  module: string;
  primary: string;
  /**
   * Which env var actually resolves first against current process.env.
   * One of [primary, ...fallbacks, "SUPABASE_SERVICE_ROLE_KEY"], or
   * null if every source is unset (= module will throw on first use).
   */
  resolvedFrom: string | null;
  /**
   * True iff resolution would fall through to SUPABASE_SERVICE_ROLE_KEY.
   * That's the rotation footgun — every outstanding token of this kind
   * gets silently invalidated when the service role rotates.
   */
  fellThroughToServiceRole: boolean;
  /** TTL of tokens this key signs. */
  tokenTtl: string;
}

/**
 * Side-effect-free audit. Walks every KNOWN_TOKEN_SECRETS entry against
 * process.env and reports which env var would resolve. Safe to call on
 * cold-start Lambdas; doesn't invoke any module's getKey().
 */
export function auditTokenSecrets(): TokenSecretAudit[] {
  return KNOWN_TOKEN_SECRETS.map(({ module, primary, fallbacks, tokenTtl }) => {
    const candidates = [primary, ...fallbacks];
    let resolvedFrom: string | null = null;
    for (const name of candidates) {
      const v = process.env[name];
      if (v && v.length > 0) {
        resolvedFrom = name;
        break;
      }
    }
    let fellThroughToServiceRole = false;
    if (!resolvedFrom) {
      const sr = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (sr && sr.length > 0) {
        resolvedFrom = "SUPABASE_SERVICE_ROLE_KEY";
        fellThroughToServiceRole = true;
      }
    }
    return {
      module,
      primary,
      resolvedFrom,
      fellThroughToServiceRole,
      tokenTtl,
    };
  });
}
