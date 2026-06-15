# UI Taste-Forks — Change Comparison Report (변경대조표)

**Date:** 2026-06-15 · **Commit:** `8ca0c3c` · **Branch:** `main`
**Scope:** the 7 identity-level design decisions ("taste forks") surfaced by the
Fable web-designer review during the 24h UI/visualization loop, now all applied
per user directive ("7개 모두 적용"). Pure token/CSS/className/JSX/font — no
behavior, data, routing, or validation change. Gate: `tsc --noEmit` clean,
regression suites 72/0 (payment-info-notify 41 / backfill 20 / experiment-schema
11), adversarial refute-review pass, every Tailwind utility token-backed.

Built on the design-system foundation laid in rounds R1–R14 of the loop (neutral
+ semantic token ramps, `EmptyState`/`Notice`/`Select`/Button-`loading`
primitives, color sweep, a11y pass, visualizations). See
`_workspace/ui-loop/REPORT.md` for that history.

---

## 변경대조표 — 7 forks

| # | Fork (CS) | Before | After | Files |
|---|---|---|---|---|
| 1 | **Korean web font** (CS11) | Geist `subsets:["latin"]` only → Korean fell back to OS fonts (AppleSDGothic / 맑은고딕), weight hierarchy inconsistent across machines | **Geist** (latin/numerals) **+ Pretendard** (Korean) via `next/font/local`; weight hierarchy stable on every OS | `layout.tsx`, `globals.css`, `package.json`, `package-lock.json`, `src/app/fonts/PretendardVariable.woff2` (new, 2.06 MB) |
| 2 | **success hue → emerald** (CS13) | green `#15803d` token + raw `emerald-*` inline chips coexisting (split) | success ramp re-pointed to **emerald** (`#047857`); 12 inline success/완료/확정/claimed chips → `success-*` tokens; `Notice` gains `success` tone | `globals.css` + payment-panel, pending-work-card, blacklist-requests-list, metadata-fill-list, participant-detail, bookings-manager, experiment-detail, online-screener-editor, promo-email-modal, booking-observation-modal, `ui/notice.tsx` |
| 3 | **canvas tone** (CS14) | admin wrapper `bg-card` `#f9fafb` (~3% from white cards — near-invisible) | `bg-neutral-100` `#f3f4f6` — white cards float clearly; `--color-card` unchanged (card interiors unaffected) | `src/app/(admin)/layout.tsx` |
| 4 | **elevation / shadows** (CS12) | Tailwind default pure-black shadows; flat cards; no CTA depth | navy-tinted (`rgb(16 24 40 / …)`) `--shadow-xs…overlay` tokens (cards auto-improve); modals → `shadow-overlay`; primary/danger buttons → `shadow-sm hover:shadow` | `globals.css`, `ui/modal.tsx`, `ui/button.tsx`, payment-panel + bookings-manager modals |
| 5 | **heading weight** (CS15) | page `h1` `text-2xl font-bold` (700) | `text-2xl font-semibold` (600) — cleaner Korean at 24px with Pretendard | 11 admin pages (dashboard, participants, experiments, experiments/new, lab-settings, locations, users, metadata-fill, blacklist-requests, bookings, live) |
| 6 | **dashboard KPI strip** (CS16) | counts buried in cards; no at-a-glance summary | 3-up summary strip (진행 중 실험 / 다가오는 예약(7일) / 기록 누락 실험) reusing already-computed counts — **zero new queries** | `src/app/(admin)/dashboard/page.tsx` |
| 7 | **2nd accent color** (CS17) | single-blue identity (Fable rec: don't add) | **user-directed override**: indigo `--color-accent` ramp + Badge `accent` variant, applied only to the non-semantic **DEMO MODE** marker (kept out of every status/semantic slot to protect the info hierarchy) | `globals.css`, `ui/badge.tsx`, `(public)/demo/page.tsx` |

---

## Token diffs (globals.css `@theme inline`)

**success ramp (green → emerald):**
```
--color-success:     #15803d → #047857
--color-success-50:  #f0fdf4 → #ecfdf5
--color-success-100: #dcfce7 → #d1fae5
--color-success-200: #bbf7d0 → #a7f3d0
--color-success-600: #16a34a → #059669
--color-success-700: #15803d → #047857
--color-success-800: #166534 → #065f46
```

**new — navy elevation tokens:**
```
--shadow-xs:      0 1px 2px 0 rgb(16 24 40 / .05)
--shadow-sm:      0 1px 3px 0 rgb(16 24 40 / .06), 0 1px 2px -1px rgb(16 24 40 / .04)
--shadow-md:      0 4px 8px -2px rgb(16 24 40 / .08), 0 2px 4px -2px rgb(16 24 40 / .05)
--shadow-lg:      0 12px 24px -6px rgb(16 24 40 / .12)
--shadow-overlay: 0 20px 40px -12px rgb(16 24 40 / .20)
```

**new — accent (indigo) ramp:**
```
--color-accent:     #4f46e5
--color-accent-50:  #eef2ff
--color-accent-100: #e0e7ff
--color-accent-600: #4f46e5
--color-accent-700: #4338ca
```

**font-family:**
```
body: var(--font-sans), Arial, …  →  var(--font-geist-sans), var(--font-pretendard), Arial, …
```

---

## Notes / residuals

- **Participant/public screens unchanged** (booking flow, `/run`, public booking-edit)
  — consistent with the loop's researcher-screen scope; their emerald/accent
  surfaces were intentionally left.
- **Residual raw `emerald-*`** in a few admin spots (experiment-list completion
  text, completeness dot, schedule categorical palette, promo send-count) renders
  **identically** to the success token now (both `#047857`), so no visual
  inconsistency; full tokenization is an optional future nit. `schedule-view`'s
  hash→hue experiment palette and the Sat/Sun weekday colors stay raw by design
  (categorical, not semantic).
- **3 hand-rolled modals** aligned to `shadow-overlay` (admin: payment-panel,
  bookings-manager); `/run` modal left (participant scope).

## Verification
- `tsc --noEmit`: 0 errors.
- Regression: payment-info-notify 41/0, backfill 20/0, experiment-schema 11/0.
- All new utilities (`success(emerald)-*`, `shadow-*`, `accent-*`) backed by
  `@theme` tokens (cross-grep).
- Pretendard asset present + `--font-pretendard` bound on `<html>`.
- Deploy: see commit `8ca0c3c` on Vercel (production).
