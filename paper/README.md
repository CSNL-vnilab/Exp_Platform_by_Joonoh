# Paper Draft — Methodology Manuscript

Working draft of a methodology paper that describes a self-hosted,
laboratory-scoped behavioral-experiment platform consolidating an
eleven-step study lifecycle under one relational schema. Target venues:
Nature Methods, NeurIPS (Datasets & Benchmarks or methodology track), or
a comparable methodology outlet.

## Files

| File | Purpose |
|---|---|
| [`abstract.md`](./abstract.md) | Structured abstract |
| [`introduction.md`](./introduction.md) | Five-section introduction: fragmentation in the offline workflow, cost/skew/data-residency in the online workflow, and our approach (one schema, one pipeline, one fork per laboratory) |
| [`graphical-abstract/`](./graphical-abstract/) | drawio source; canonical version is `v4-polished.drawio` |
| [`instructions.md`](./instructions.md) | Manual: eleven sequential operations from publication to fee dispatch, at the platform-feature level |

## Anonymity policy

The paper text contains no deployment-specific identifiers: no
institutional name, no principal-investigator name, no project or grant
number, no demo paradigm name, and no demo researcher initials. The
instructions describe the eleven operations at the platform-feature
level only. The deployment-specific case (paradigm, researcher, code
parsing, storage path) may be illustrated as a supplementary workflow
schematic — distinct from the main-text claims — if a worked figure is
added later; that figure is not part of the current draft.

The free-tier deployment-cost pitch lives in the repository-root README,
not in the paper.
