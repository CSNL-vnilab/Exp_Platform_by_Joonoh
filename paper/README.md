# Paper Draft — Methodology Manuscript

Working draft of a methodology paper that describes a self-hosted,
laboratory-scoped behavioral-experiment platform: a relational substrate
on which a laboratory consolidates the artifacts of its own experimental
workflow rather than an attempted community-wide data standard. Target
venues: Behavior Research Methods, Nature Methods, or a comparable
methodology outlet.

## Files

| File | Purpose |
|---|---|
| [`draft-v1.md`](./draft-v1.md) | **Merged single-file manuscript snapshot** — abstract + introduction + graphical-abstract pointer + instructions + appendices + references, frozen at git tag `paper-draft-v1` |
| [`abstract.md`](./abstract.md) | Structured abstract (component file, source of truth for continued iteration) |
| [`introduction.md`](./introduction.md) | Seven-section introduction: why behavioral experiments resist BIDS-style standardization; three problem classes (offline fragmentation + human error; questionable research practices; online marketplace cost / skew / data residency); our approach (lab-scoped substrate, not a community standard); a careful note on AI-powered research, day science and night science; paper structure |
| [`graphical-abstract/`](./graphical-abstract/) | drawio source; canonical version is `v4-polished.drawio` |
| [`instructions.md`](./instructions.md) | Manual: eleven sequential operations from publication to fee dispatch, at the platform-feature level |

The component files (`abstract.md`, `introduction.md`, `instructions.md`)
remain the source of truth for continued iteration; `draft-v1.md` is a
read-only snapshot of the four files concatenated at the tag point. To
produce a later snapshot (`draft-v2.md`, etc.) re-concatenate after
edits to the component files.

## Anonymity policy

The paper text contains no deployment-specific identifiers: no
institutional name, no principal-investigator name, no project or grant
number, no demo paradigm name, and no demo researcher initials. The
instructions describe the eleven operations at the platform-feature
level only. The deployment-specific case (paradigm, researcher, code
parsing, storage path) may be illustrated as a supplementary workflow
schematic — distinct from the main-text claims — if a worked figure is
added later; that figure is not part of the current draft.

The free-tier deployment-cost pitch and the experiment-analysis-publication
single-DB workflow pitch live in the repository-root README, not in the
paper.
