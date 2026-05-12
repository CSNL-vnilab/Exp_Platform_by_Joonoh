# Paper Draft — Methodology Manuscript

Working draft of a methodology paper describing the self-hosted lab
experiment platform. Target venues: Nature Methods, NeurIPS (Datasets &
Benchmarks or methodology track), or a comparable methodology outlet.

## Files

| File | Purpose |
|---|---|
| [`abstract.md`](./abstract.md) | 250–300 word structured abstract |
| [`introduction.md`](./introduction.md) | Six-paragraph introduction: motivation, two problem classes (offline fragmentation, online marketplace bias and cost), our approach, extension roadmap, paper structure |
| [`graphical-abstract/`](./graphical-abstract/) | drawio source plus version history of the figure; current canonical version is `v4-polished.drawio` |
| [`instructions.md`](./instructions.md) | Manual: eleven sequential operations from publication to fee dispatch, with the TimeExp1 walkthrough as a worked example |

## Anonymity policy

The draft never references institutional identifiers (project number,
principal-investigator name, host university, administrative recipient
address, lab account address). The only personalized references that
appear are the demo researcher *JOP* and the demo paradigm *TimeExp1*, both
of which are presented as anonymous illustrative examples.

If the manuscript proceeds to submission, the abstract, introduction, and
instructions can be lifted directly; the graphical abstract is in
`graphical-abstract/v4-polished.drawio` and is ready for SVG / PDF export at
publication resolution.

## Graphical abstract version history

- `v1-draft.drawio` — initial three-column layout; received a 3.5 / 10
  hostile review for being a text-heavy slide masquerading as a figure
  (no fragmentation visual on the left, no DB-as-anchor visual in the
  center, marketplace brand names exposed, redundant outcomes column).
- `v2-draft.drawio` — restructured to scattered tokens on the left,
  radial satellites around a DB cylinder, three outcomes instead of six,
  block arrows between columns. Scored 5.5 / 10; remaining failures were
  the marketplace brand-name leak ("Prolific, MTurk" hadn't been scrubbed
  on the left), title size too small for thumbnail rendering, confirmation
  gate demoted to footnote text, edges too thin to read at thumbnail.
- `v3-final.drawio` — anonymized to "Crowd marketplaces", title 44pt,
  break marks for the severed connectors, confirmation gate promoted to a
  visible amber pill, edges thickened, single (green block-arrow)
  deliverable. Scored 8 / 10 with recommendation to ship.
- `v4-polished.drawio` — post-multi-agent-review polish pass. Block
  arrows enlarged from 80×80 to 100×120 with adjusted `dy/dx` proportions
  so they survive thumbnail (200 px) rendering for journal carousels.
  Left "unify" arrow recolored from charcoal (`#2c3e50`) to system blue
  (`#1f4e79`) — removing a fifth color that broke the four-color scheme
  (red/blue/green/amber). Severed-connector decorations on the left
  column (three `//` break-mark groups) removed because the five
  shape-shifting tokens alone already convey fragmentation, and the
  connector endpoints were geometrically misaligned with the tokens
  they pretended to connect. Outcome-2 title shortened from
  "Local pool · institutional rate" to "Local pool, fair rate" so all
  three outcomes share the single-claim cadence. Block arrows
  re-symmetrised at x=445 / x=1155 with matched 100×120 footprint.
