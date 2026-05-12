# Paper Draft — Methodology Manuscript

Working draft of a methodology paper that names a class of reproducibility
failure — *the join problem* — and presents a self-hostable platform as a
working instance of join-completion at the laboratory scale. Target venues:
Nature Methods, NeurIPS (Datasets & Benchmarks or methodology track), or a
comparable methodology outlet.

## Named contribution

The paper names and defends one methodological claim: *the join problem* —
the class of reproducibility and handover failures that arise not from any
individual artifact being missing, malformed, or non-standard but from the
absence of a machine-readable referential identity binding two or more
artifacts co-produced by a single research event. Around this claim the
paper organizes three design commitments that the platform demonstrates:

1. **Referential closure of the study record** — one relational schema, FK
   integrity over every artifact, single-SELECT provenance from a published
   session label back to recruitment / commit / data / disbursement.
2. **Schema-as-contract, deployment-as-customization** — forkable codebase,
   each laboratory hosts its own deployment, locale-specific paperwork in
   config rather than source, new operations attach as typed schema
   extensions rather than core patches.
3. **Confirmation-gated automation** — every external dispatch is preceded
   by an explicit modal-level confirmation; the audit trail records human
   intent at every external action.

Free-tier composition is treated as a deployment-cost footnote, not as a
methodological contribution, and is documented in the implementation
appendix; the README at the repository root carries the free-tier pitch for
adopting laboratories.

## Files

| File | Purpose |
|---|---|
| [`abstract.md`](./abstract.md) | Structured abstract naming the join problem and the three commitments |
| [`introduction.md`](./introduction.md) | Seven-section introduction: artifacts vs joins, the join problem, offline fragmentation, online marketplace bias / cost / data residency, our approach (one schema, one pipeline, one fork per laboratory), operational consequences (rigor, ethics, handover, co-work), AI roadmap, paper structure |
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
