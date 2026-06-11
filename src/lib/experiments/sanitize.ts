// Public-surface sanitizers for the experiments row.
//
// WHY: the public GET /api/experiments/[experimentId] and the public SSR
// /book/[experimentId] page historically returned select("*"), which leaks
// researcher-only / data-integrity-sensitive fields to unauthenticated
// participants and to other researchers:
//
//   - online_runtime_config.attention_checks[].correct_answer — if a
//     participant can read the expected answer they pass every check by
//     copying it, poisoning the attention-filter and the dataset.
//   - online_runtime_config.counterbalance_spec — the condition-assignment
//     logic; exposing it lets a participant infer/guess their arm.
//   - online_runtime_config.exclude_experiment_ids — cross-study exclusion
//     list (reveals which other studies the participant is gated against).
//   - code_repo_url / data_path — internal source + storage paths.
//
// These helpers return a shallow clone with the sensitive keys stripped or
// masked. Non-sensitive fields the participant runtime / booking shell
// actually consume (entry_url, preflight, fee, precautions, …) are kept so
// behaviour is unchanged for the public flow.
//
// FOLLOW-UP finding (out of scope here): /run/[bookingId] passes the FULL
// online_runtime_config — including attention_checks[].correct_answer — into
// the sandbox. Even though /run is gated by the participant's own booking
// token, the correct_answer is still shipped to the participant's browser,
// so a determined participant can read it from devtools. Fixing that needs
// server-side answer verification (grade attention checks on the server from
// the block-upload payload, never ship correct_answer to the client). Not
// done here because /run's threat surface (own-token gate) and the required
// server-grading infra are a separate work item.

import type { OnlineRuntimeConfig } from "@/types/database";

// Element type of the attention_checks array, sans the stripped answer.
type AttentionCheck = NonNullable<OnlineRuntimeConfig["attention_checks"]>[number];
type SanitizedAttentionCheck = Omit<AttentionCheck, "correct_answer">;

/**
 * Strip data-integrity-sensitive keys from an OnlineRuntimeConfig before it
 * reaches the participant runtime. Returns a shallow clone:
 *
 *   - attention_checks: each entry keeps question/kind/options/position
 *     (the shell needs these to render the item) but drops correct_answer.
 *   - counterbalance_spec: removed entirely.
 *   - exclude_experiment_ids: removed entirely.
 *
 * entry_url / entry_url_sri / trial_count / block_count / estimated_minutes /
 * completion_token_format / preflight are preserved — the /run shell and the
 * progress UI rely on them and none expose answers or assignment logic.
 */
export function sanitizeOnlineRuntimeConfig(
  cfg: OnlineRuntimeConfig | null | undefined,
): OnlineRuntimeConfig | null {
  if (cfg == null) return cfg ?? null;

  // Shallow clone, then drop the sensitive top-level keys.
  const {
    counterbalance_spec: _counterbalance_spec,
    exclude_experiment_ids: _exclude_experiment_ids,
    attention_checks,
    ...rest
  } = cfg;

  const sanitized: OnlineRuntimeConfig = { ...rest };

  if (Array.isArray(attention_checks)) {
    // Drop correct_answer; keep the fields the shell renders. The result no
    // longer satisfies the required `correct_answer` on the source element
    // type (by design — that's the leak we're closing), so the array is
    // typed via the stripped element shape and cast back at assignment.
    const stripped: SanitizedAttentionCheck[] = attention_checks.map(
      ({ correct_answer: _correct_answer, ...checkRest }) => checkRest,
    );
    sanitized.attention_checks =
      stripped as unknown as OnlineRuntimeConfig["attention_checks"];
  }

  return sanitized;
}

/**
 * Generic experiments row shape this sanitizer touches. Kept loose so both
 * the API route (DB row) and the SSR page can pass their concrete row type
 * without a cast churn — only the three masked fields are constrained.
 */
type SanitizableExperiment = {
  code_repo_url?: string | null;
  data_path?: string | null;
  online_runtime_config?: OnlineRuntimeConfig | null;
  [key: string]: unknown;
};

/**
 * Mask the researcher-only fields on an experiments row for any public /
 * non-owner / non-admin consumer. Returns a shallow clone with:
 *
 *   - code_repo_url = null
 *   - data_path = null
 *   - online_runtime_config = sanitizeOnlineRuntimeConfig(...)
 *
 * All other fields pass through untouched.
 */
export function sanitizeExperimentForPublic<T extends SanitizableExperiment>(
  row: T,
): T {
  return {
    ...row,
    code_repo_url: null,
    data_path: null,
    online_runtime_config: sanitizeOnlineRuntimeConfig(
      row.online_runtime_config,
    ),
  };
}
