#!/usr/bin/env bash
# Pre-flight guard for `git commit` / `git push`. Blocks the two
# multi-session footguns from session 2026-05-04:
#
#   1) committing/pushing while not on `main` (sibling session checked
#      out a feature branch between our commits — twice)
#   2) pushing while local `main` is behind `origin/main` (we'd clobber
#      a sibling's commit on the next force-push, or land an out-of-date
#      build on Vercel)
#
# Wired via `.claude/settings.json` PreToolUse hook on the Bash tool.
# Reads the standard Claude Code hook JSON payload from stdin
# (https://docs.claude.com/en/docs/claude-code/hooks#hook-input).
#
# Override (intentional feature-branch work):
#     ALLOW_FEATURE_BRANCH=1 git commit ...
#     ALLOW_FEATURE_BRANCH=1 git push ...
# The `VAR=val cmd args` form is preserved verbatim in the command
# string the hook sees, so we can detect it without a separate env var.

set -euo pipefail

PAYLOAD="$(cat)"

# Extract the bash command. Fall back to grep if jq is missing — the
# project doesn't list jq as a hard dep.
if command -v jq >/dev/null 2>&1; then
  CMD="$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.command // ""')"
else
  CMD="$(printf '%s' "$PAYLOAD" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
fi

# Only intercept git commit / git push. Everything else passes through.
# Match `git commit`, `git push`, and the `VAR=val git commit/push` form.
case "$CMD" in
  *"git commit"*|*"git push"*) ;;
  *) exit 0 ;;
esac

# Skip read-only / informational variants that can't mutate state.
case "$CMD" in
  *"git push --dry-run"*|*"git push -n"*) exit 0 ;;
esac

# Honor the documented escape hatch.
if [[ "$CMD" == *"ALLOW_FEATURE_BRANCH=1"* ]]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}"

BRANCH="$(git branch --show-current 2>/dev/null || echo '')"

if [[ -z "$BRANCH" ]]; then
  echo "preflight: detached HEAD — refusing $(echo "$CMD" | awk '{print $1, $2}'). Check out main first." >&2
  exit 2
fi

if [[ "$BRANCH" != "main" ]]; then
  cat >&2 <<EOF
preflight: refusing — current branch is '$BRANCH', not 'main'.

A sibling session likely checked out '$BRANCH' between your last two
commits. Switch back before continuing:

    git checkout main

If this commit/push is *intentionally* on a feature branch, prefix
the command with the override:

    ALLOW_FEATURE_BRANCH=1 git commit ...
    ALLOW_FEATURE_BRANCH=1 git push ...
EOF
  exit 2
fi

# On main. For pushes (and pre-push commits), make sure we're not behind
# origin — otherwise we either fail the push or land stale code. We
# only fetch when the command is `git push`; for `git commit` we trust
# whatever fetch the session did most recently (commits are local-only).
if [[ "$CMD" == *"git push"* ]]; then
  if ! git fetch --quiet origin main 2>/dev/null; then
    echo "preflight: 'git fetch origin main' failed — network issue? Re-run when reachable, or use ALLOW_FEATURE_BRANCH=1 to bypass." >&2
    exit 2
  fi
  BEHIND="$(git rev-list --count HEAD..origin/main 2>/dev/null || echo 0)"
  if [[ "$BEHIND" -gt 0 ]]; then
    cat >&2 <<EOF
preflight: refusing — local 'main' is $BEHIND commit(s) behind origin/main.

A sibling session pushed in the meantime. Pull (rebase) before pushing:

    git pull --rebase origin main

Then re-run your push.
EOF
    exit 2
  fi
fi

exit 0
