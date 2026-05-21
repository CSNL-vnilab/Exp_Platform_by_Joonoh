#!/usr/bin/env bash
# Restore the shell tools the lab-reservation platform depends on.
# Idempotent — only patches what's missing. Safe to run repeatedly.
#
# Used by:
#   - plugins/lab-reservation/hooks/hooks.json  (SessionStart hook)
#   - /lab-restore-env slash command (commands/lab-restore-env.md)
#
# Why this exists: this lab uses node (via npm/npx), gh, supabase, and
# vercel CLIs. They sit in /opt/homebrew/bin under macOS Homebrew; we've
# seen all of them disappear from PATH mid-session more than once (e.g.
# brew uninstall, /opt/homebrew/bin rebuilt from a different package
# set). This script reseats them.

set -u

prepend_path() {
  case ":$PATH:" in
    *":$1:"*) ;;
    *) PATH="$1:$PATH" ;;
  esac
}

ok=0
notes=()

# 1. node — prefer system; fall back to Codex.app's bundled node 24
if ! command -v node >/dev/null 2>&1; then
  if [ -x /Applications/Codex.app/Contents/Resources/node ]; then
    prepend_path /Applications/Codex.app/Contents/Resources
    notes+=("node: using Codex bundled (fallback)")
  else
    notes+=("node: MISSING — install Node 24 or Codex.app")
  fi
fi
command -v node >/dev/null 2>&1 && ok=$((ok + 1))

# 2. gh — if missing, restore from Cellar (if homebrew was uninstalled
#    but the bottle is still on disk) or from a one-off /tmp download
#    that a previous /lab-restore-env may have left behind.
if ! command -v gh >/dev/null 2>&1; then
  for candidate in \
    /opt/homebrew/Cellar/gh/*/bin/gh \
    /tmp/gh_*_macOS_arm64/bin/gh; do
    if [ -x "$candidate" ]; then
      cp "$candidate" /opt/homebrew/bin/gh 2>/dev/null && \
        notes+=("gh: restored from $candidate")
      break
    fi
  done
fi
command -v gh >/dev/null 2>&1 && ok=$((ok + 1)) || notes+=("gh: MISSING — see /lab-restore-env --download-gh")

# 3. supabase — same dance, from Cellar
if ! command -v supabase >/dev/null 2>&1; then
  for candidate in /opt/homebrew/Cellar/supabase/*/bin/supabase; do
    if [ -x "$candidate" ]; then
      cp "$candidate" /opt/homebrew/bin/supabase 2>/dev/null && \
        notes+=("supabase: restored from $candidate")
      break
    fi
  done
fi
command -v supabase >/dev/null 2>&1 && ok=$((ok + 1)) || notes+=("supabase: MISSING")

# 4. vercel — npm-global install
if ! command -v vercel >/dev/null 2>&1; then
  for candidate in $HOME/.npm-global/bin/vercel /opt/homebrew/bin/vercel; do
    if [ -x "$candidate" ]; then
      prepend_path "$(dirname "$candidate")"
      notes+=("vercel: added $(dirname "$candidate") to PATH")
      break
    fi
  done
fi
command -v vercel >/dev/null 2>&1 && ok=$((ok + 1)) || notes+=("vercel: MISSING — npm i -g vercel")

# Emit PATH so Claude's bash sees the additions. PATH export only persists
# inside the hook invocation, but the underlying binaries are now where
# the shell rc fallback (~/.zshrc lab-reservation block) can find them.
export PATH

# Stable diagnostic line — picked up by the SessionStart hook and shown
# to the user / Claude when something's still missing.
if [ "$ok" -eq 4 ]; then
  echo "lab-reservation env OK: node $(node --version 2>/dev/null), gh $(gh --version 2>/dev/null | head -1 | awk '{print $3}'), supabase $(supabase --version 2>/dev/null), vercel $(vercel --version 2>/dev/null)"
else
  echo "lab-reservation env: $ok/4 tools ready"
  for n in "${notes[@]}"; do echo "  - $n"; done
fi
