# Abstract

Running human behavioral experiments inside a single research laboratory
currently involves a fragmented toolchain. Participant recruitment, scheduling,
location notifications, reminders, experiment-code distribution, raw-data
collection, and the institutional fee-claim paperwork are handled by separate
spreadsheets, email threads, calendar entries, lab-server folders, and physical
forms. Each artifact, considered alone, may already conform to community data
standards; what fails in practice is not the artifacts but the *joins* between
them. A study's spreadsheet row, calendar event, code-repository commit,
data-folder name, administrative receipt, and published-paper session label
share no machine-readable referential identity, and reconciling them after
the fact requires the original experimenter's memory. We call this class of
failure **the join problem**, distinguished from the artifact-level concerns
that FAIR principles and file-layout standards (BIDS, Psych-DS) are designed
to address. The popular alternative — outsourcing recruitment to crowd
marketplaces such as Prolific and Amazon Mechanical Turk — replaces
fragmentation with cost, demographic-coverage, and data-residency trade-offs
that are unacceptable for many laboratory-grade research programs.

We present a self-hosted, lab-scoped experiment platform as a working
instance of join-completion at the laboratory scale. The platform makes
three design commitments. (i) **Referential closure**: a single relational
schema spans recruitment through participant-fee claim, with foreign-key
integrity over every artifact a study emits, so that a published-paper
session label resolves to its recruitment record, code commit, raw-data
path, and disbursement record by a single foreign-key path. (ii)
**Schema-as-contract, deployment-as-customization**: the codebase is
forkable and laboratory-sovereign — each laboratory hosts its own
deployment under its own institutional accounts, with locale-specific
paperwork, fee regimes, knowledge-base targets, and language-specific
communications in deployment configuration rather than in source code, and
with new operations attached to the schema as typed extensions rather than
core patches. (iii) **Human-in-the-loop verification at both ends.** At
registration, the platform performs an AI-assisted static analysis of the
registered experiment code and proposes the inferred task layout,
manipulation variables, dependent variables, and raw-data storage path;
the researcher confirms or corrects this proposal before the study can
open for recruitment, so data-convention drift is detected at study
creation rather than at semester-end reconciliation. At dispatch, every
action that emits a record outside the laboratory boundary is preceded by
an explicit researcher confirmation, so the audit trail records human
intent at every external action. The system is in production use at a
single laboratory and has handled approximately 200 confirmed bookings
across multiple researchers, and the closure property has operational
consequences beyond reproducibility: research-ethics audits resolve to
single foreign-key paths, graduate-student handovers become FK walks
rather than tacit interviews, and two researchers running the same
paradigm produce row-comparable data without coordination overhead. The
same schema is intended to host a future AI-assisted experiment-design
extension, which is deferred to the Discussion.

**Keywords:** behavioral-experiment infrastructure; the join problem;
referential closure; lifecycle schema; laboratory sovereignty; reproducibility
substrate; forkable research software; self-hosted platform; methodology.
