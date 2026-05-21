---
description: Re-seat node / gh / supabase / vercel on PATH (idempotent). Use when commands suddenly stop being found.
---

Run the env restore script and report what it patched:

```bash
"${CLAUDE_PLUGIN_ROOT:-/Users/csnl/Documents/claude/lab-reservation-main/plugins/lab-reservation}"/scripts/restore-env.sh
```

If anything still reports `MISSING`, walk the user through the targeted recovery:

- **node**: install Node 24 LTS (or rely on Codex.app's bundled `node` — the script already wires that as a fallback).
- **gh**: download standalone — `curl -fLO https://github.com/cli/cli/releases/latest/download/gh_<version>_macOS_arm64.zip`, unzip, place at `/opt/homebrew/bin/gh`. The token in keyring survives a binary swap, so existing `gh auth status` should still work.
- **supabase**: same Cellar trick — if `/opt/homebrew/Cellar/supabase/*/bin/supabase` exists, the script auto-copies; otherwise download from GitHub releases.
- **vercel**: `npm i -g vercel` (uses ~/.npm-global, no brew needed).

After patching, verify with `zsh -ic 'command -v node gh vercel supabase'` to confirm a fresh shell sees them.
