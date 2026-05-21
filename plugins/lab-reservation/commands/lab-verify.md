---
description: Verify the latest Vercel deployment is Ready and aliased to lab-reservation-seven.vercel.app; spot-check /login + /api/participants reachability.
---

Run, in order:

1. `vercel ls` — newest production deployment row. If Status is `● Building`, block on it with a Bash `until` loop polling every ~8s (the harness blocks long single `sleep` calls — use Monitor or background polling).
2. `vercel inspect <deployment-url>` — confirm `Aliases` includes `lab-reservation-seven.vercel.app` and `lab-reservation-git-main-*`.
3. `curl -s -o /dev/null -w "/login %{http_code}\n" https://lab-reservation-seven.vercel.app/login` — expect 200.
4. `curl -s -o /dev/null -w "/api/participants %{http_code}\n" https://lab-reservation-seven.vercel.app/api/participants` — expect 401 (route alive, auth-required).

If any step fails, fetch the failing deployment's logs with `vercel inspect <url> --logs` or `vercel logs <url>` and surface the relevant lines.
