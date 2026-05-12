# Introduction

## 1. Behavioral experiments depend on infrastructure that is rarely treated as a research artifact

A behavioral experiment in psychology or cognitive neuroscience produces
many more files than the timestamped raw trial data it eventually
publishes. A typical study generates a recruitment posting and its
responses, calendar holds on a shared booking system, one or more
experiment-code repositories, per-session stimulus and runtime
configuration, ethics-review records, and per-participant payment
receipts. These artifacts are typically stored in unrelated systems — a
shared spreadsheet, a calendar account, a server folder, a paper binder
— with no shared identifier across them. Replication failures and
handover problems consequently arise not from any single missing file
but from the *joins* between files that nobody documented.

This problem is sharper in behavioral methodology than in adjacent
fields. The neuroimaging community has converged on the Brain Imaging
Data Structure (Gorgolewski et al., 2016) as a portable on-disk format
that downstream analysis tools bind against. Behavioral methodology has
no on-disk standard of comparable adoption; Psych-DS (Hartshorne et al.)
is a community specification under active development. In its absence,
each laboratory, and often each researcher within a laboratory, evolves
its own folder layout, file-naming convention, column ordering, and
metadata encoding. An analyst opening another laboratory's data deposit
must first infer the local convention from examples before any analysis
can proceed; a researcher porting a paradigm to a different laboratory
ports not only the runtime code but the undocumented filesystem
conventions on which it depends.

This paper describes a working alternative: a single, self-hostable web
application that consolidates the lifecycle of a behavioral experiment
under one relational schema, deployed and owned by the host laboratory.
Before describing the system itself, we document the two problem
classes that motivated it.

## 2. Problem 1 — Fragmentation in the offline workflow

In an in-person laboratory, the recruitment-to-payment workflow is
distributed across independent surfaces. Recruitment posters collect
prospective participants whose responses arrive by email or web form and
are hand-copied into a scheduling spreadsheet. A shared calendar is
annotated by the experimenter with the participant's identifier. The
experiment-code runtime sits in a git repository on a personal laptop or
lab server, and the version actually run on a given session is
identified only by the calendar event description, if at all. Output
files are written to a lab-server directory named by the experimenter.
The participant-fee paperwork is collected on a paper form, with
resident-registration information and a signed bankbook, and physically
transported to the administrative office.

Each surface is individually defensible. The joins between them are not
machine-readable: the same study acquires a row number in the
spreadsheet, a calendar event id, a commit hash, a data-folder name, an
administrative receipt number, and a published-paper session label, and
reconciling them after the fact requires the original experimenter's
memory. Two consequences follow. First, data conventions drift between
experimenters: two researchers running the same paradigm store the raw
output in slightly different folder structures, filename templates, or
column orderings, which makes pooled analysis labor-intensive. Second,
when a graduate student leaves the laboratory, the knowledge of how to
actually re-run a study — recruitment channel, exclusion-criteria
implementation, stimulus version, payment account — is not in any single
place, and incoming researchers either restart from scratch or accept
silent reproduction gaps.

Existing partial solutions address single surfaces. Experiment-code
frameworks such as jsPsych (de Leeuw, 2015) standardize the runtime but
not recruitment, payment, or handover. Lab-management products such as
Sona Systems address recruitment and scheduling but do not store
experiment code, raw data, or fee-claim records. The integrated
end-to-end pipeline remains, in practice, every laboratory's local
invention.

## 3. Problem 2 — Cost, demographic skew, and data residency in the online workflow

The contemporary alternative to in-lab recruitment is remote-participant
marketplaces, most prominently Prolific and Amazon Mechanical Turk.
These services solve recruitment, scheduling, and payment in one product
but bill at a substantial premium over the institutional participant-fee
rate that a university laboratory pays, and the participant pool has
been reported to skew toward English-language regions, toward younger
and more educated workers, and toward high-trial-count workers whose
familiarity with cognitive-task structure complicates task-naïveté
assumptions (Chmielewski & Kucker, 2020). Crowd-marketplace platforms
also route participant identifiers and payment information through
third-party infrastructure that the laboratory neither hosts nor audits,
which can be incompatible with institutional data-residency requirements
or cross-border-transfer restrictions on participant identifiers.

For research programs that depend on careful psychophysical control, on
sampling from a local population, or on participant-identifier handling
that complies with institutional data-residency requirements, the
in-lab workflow remains the methodology of choice, and returns us to
Problem 1.

## 4. Our approach — one schema, one pipeline, one fork per laboratory

The platform takes the position that the right unit of consolidation is
the laboratory itself, which has stable institutional credentials (the
shared email account, the shared calendar, the data folders), a
participant-fee disbursement convention, and a set of physical
locations. By emitting every artifact through one pipeline that the
laboratory itself hosts, artifact relationships are stored as foreign
keys rather than spreadsheet conventions.

We make the following design commitments.

1. Every experiment, every booking, every participant, every payment
   record, and every external-service delivery attempt is a row in one
   Postgres schema with foreign-key integrity to a single
   `experiments.id`. The schema is under sixty tables at present and is
   authoritative; copies in shared calendars and external knowledge-base
   products are mirrors.

2. The codebase is forkable and each laboratory hosts its own
   deployment. Locale-specific paperwork (fee-form layouts, regulatory
   identifiers, reimbursement regimes), institutional conventions
   (calendar identifiers, knowledge-base targets, mailing-list
   addresses), and language-specific researcher- and participant-facing
   communications live in deployment configuration rather than in
   source code. New operations attach as added tables and routes rather
   than patches to the core.

3. Automation is bounded by human confirmation at both ends of the
   pipeline. At registration, an automated analysis pass over the
   registered experiment code (an LLM-based summary in our deployment,
   though the architecture is agnostic to the analyzer) drafts a
   candidate description of the task layout, manipulation variables,
   dependent variables, and raw-data storage path; the researcher
   reviews this draft and confirms or corrects it before the experiment
   can open for recruitment. No accuracy claim is made for the
   automated analyzer; its role is to draft, not to decide. At dispatch,
   every action that emits a record outside the laboratory boundary — a
   message to a participant, a packet to an administrative office, a
   row to the external knowledge base — is preceded by an explicit
   modal-level confirmation from the researcher.

We report the schema-level consolidation as an existence proof; no
controlled before-and-after comparison against the pre-platform workflow
has been conducted, and operational gains (researcher time, error rate,
handover loss) are not measured here.

## 5. Paper structure

The remainder of this paper is organized as follows. The next section
(*Graphical Abstract*) presents a single diagram summarizing the
eleven-operation pipeline. The *Instructions* section documents each
operation from the perspective of a researcher adopting the platform
for a new study, with a worked walkthrough of the TimeExp1
time-reproduction paradigm under an anonymized demo researcher referred
to as JOP. An appendix lists the scheduled reconciliation jobs and
their failure-recovery semantics.

## References (placeholder — to be completed before submission)

- Chmielewski, M., & Kucker, S. C. (2020). An MTurk crisis? Shifts in
  data quality and the impact on study results. *Social Psychological
  and Personality Science.*
- Gorgolewski, K. J., et al. (2016). The brain imaging data structure
  (BIDS), a format for organizing and describing outputs of
  neuroimaging experiments. *Scientific Data.*
- Hartshorne, J. K., et al. *Psych-DS — A data standard for psychological
  research.* (community specification.)
- de Leeuw, J. R. (2015). jsPsych: A JavaScript library for creating
  behavioral experiments in a web browser. *Behavior Research Methods.*
- Sona Systems. *Sona Systems Cloud-based experiment management.*
  (commercial product, cited as representative recruitment-and-scheduling
  silo.)
