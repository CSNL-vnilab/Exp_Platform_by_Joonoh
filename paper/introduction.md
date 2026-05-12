# Introduction

## 1. Behavioral experiments resist the standardization that worked for neuroimaging

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

It is tempting to ask why the behavioral sciences have no equivalent of
the Brain Imaging Data Structure (Gorgolewski et al., 2016), which gave
the neuroimaging community a portable on-disk format. The answer is
structural rather than sociological. Neuroimaging acquires data through
a comparatively small number of well-characterized scanner modalities
(MRI, MEG, EEG) whose parameters can be enumerated; the voxel-grid floor
of neuroimaging data is uniform across paradigms even when the
cognitive content above it differs. Behavioral experiments do not have
this property. A psychophysical staircase, a developmental looking-time
study, a clinical-population working-memory battery, an
ecological-momentary-assessment protocol, and a survey-with-eye-tracking
study each have apparatus, stimulus, response, exclusion-criteria, and
parameter spaces that share almost nothing in common. The combinatorial
space of valid behavioral paradigms exceeds the combinatorial space of
valid scanner protocols by orders of magnitude, and a single on-disk
schema standardizing the behavioral output of all paradigms is, in our
judgment, not an achievable target. Psych-DS (Hartshorne et al.) is the
most ambitious current attempt and is explicitly scoped to the metadata
layer rather than to paradigm-internal structure.

In the absence of a community-wide format, each laboratory — and often
each researcher within a laboratory — evolves its own folder layout,
file-naming convention, column ordering, metadata encoding, parameter-
file location, random-seed convention, and counterbalance representation.
Most of this practice goes unwritten. This paper takes the position that
the productive response to that absence is not another attempted
standard at the community level, but a substrate at the *laboratory* or
*project* level that records the artifacts a study produces — and the
relationships between them — as queryable schema state. Below we
identify three problem classes that motivate this position.

## 2. Problem 1 — Fragmentation, human error, and the informal record in the offline workflow

In an in-person laboratory, the recruitment-to-payment workflow is
distributed across independent surfaces. Recruitment posters collect
prospective participants whose responses arrive by email or web form
and are hand-copied into a scheduling spreadsheet. A shared calendar is
annotated by the experimenter with the participant's identifier. The
experiment-code runtime sits in a git repository on a personal laptop
or lab server, and the version actually run on a given session is
identified only by the calendar event description, if at all. Output
files are written to a lab-server directory named by the experimenter.
The participant-fee paperwork is collected on a paper form and
physically transported to the administrative office.

Each surface is individually defensible. The joins between them are not
machine-readable: the same study acquires a row number in the
spreadsheet, a calendar event id, a commit hash, a data-folder name, an
administrative receipt number, and a published-paper session label, and
reconciling them after the fact requires the original experimenter's
memory. Two consequences follow at the laboratory level. First, data
conventions drift between experimenters: two researchers running the
same paradigm store the raw output in slightly different folder
structures, filename templates, or column orderings, which makes pooled
analysis labor-intensive. Second, when a graduate student leaves the
laboratory, the knowledge of how to actually re-run a study —
recruitment channel, exclusion-criteria implementation, stimulus
version, payment account — is not in any single place.

A third consequence is rarely surfaced in methodology discussions but
recurs in practising laboratories: implementation errors in the
experiment code itself. A random-seed call that is not seeded with the
participant identifier and silently reuses the previous session's
sequence; a parameter file that is overwritten in place when an
exploratory notebook runs to completion; a save call that fails
silently when the target directory is unmounted; a counterbalancing
table whose ordering diverges across sessions because the lookup logic
depends on the system locale or on a file-modification timestamp. None
of these are detectable by reading the published manuscript, and few of
them are detectable by the principal investigator without sitting down
at the runtime and re-tracing the session in question. In our experience, such errors recur in graduate-student-mediated
wet-lab work and are exacerbated by turnover and by the limited
code-review practices typical at the laboratory scale relative to
industry software. The structural gap that allows them to persist
undetected is the same gap that allows the spreadsheet/calendar/folder
fragmentation to persist: no integrated record binds the registered
code version, the parameter-file checksum, the random-seed and
counterbalance state, and the resulting raw-data row.

Existing partial solutions address single surfaces. Experiment-code
frameworks — Psychtoolbox (Brainard, 1997; Kleiner et al., 2007),
PsychoPy (Peirce, 2007), jsPsych (de Leeuw, 2015), and similar
MATLAB-, Python-, and JavaScript-based runtime libraries — standardize
how a paradigm is executed on a participant's screen, but not
recruitment, payment, handover, or the integrated record. Lab-management products such as
Sona Systems address recruitment and scheduling but do not store
experiment code, raw data, or implementation-level metadata. The
end-to-end record remains, in practice, every laboratory's local
invention.

## 3. Problem 2 — Questionable research practices and the role of systematic tracking

A second problem class is harder to discuss but methodologically
central. Even when a runtime is correctly implemented, behavioral
findings remain vulnerable to questionable research practices that
operate after data collection (Simmons et al., 2011; John et al.,
2012): the selective exclusion of participants on post-hoc,
unprincipled criteria; the parameter sweep that is run repeatedly,
with only the configuration producing the desired significant result
retained in the manuscript; the analysis branch that is tried,
abandoned, and silently absent from the published methods.
Pre-registration (Nosek et al., 2018) addresses part of this problem at
the publication-protocol layer but cannot observe what the researcher
actually does between the filing of the protocol and the submission of
the manuscript.

A systematic record of the operational pipeline does not by itself
prevent these practices, because the researcher retains the discretion
to act on the data. It does change the audit posture: a reviewer, a
co-author, or a future replicator can reconstruct, from queryable
schema state, what exclusions were made when and by whom, what
parameter values were active per session, which code version produced
each raw-data row, and which analysis branches were attempted, without
depending on the experimenter's recollection or on the manuscript's
narrative. The substrate does not perform the audit; it makes the audit
tractable rather than archaeological.

## 4. Problem 3 — Cost, demographic skew, and data residency in the online workflow

The contemporary alternative to in-lab recruitment is remote-participant
marketplaces, most prominently Prolific and Amazon Mechanical Turk.
These services solve recruitment, scheduling, and payment in one
product but bill at a substantial premium over the institutional
participant-fee rate that a university laboratory pays, and the
participant pool has been reported to skew toward English-language
regions, toward younger and more educated workers, and toward
high-trial-count workers whose familiarity with cognitive-task
structure complicates task-naïveté assumptions (Chmielewski & Kucker,
2020). Crowd-marketplace platforms also route participant identifiers
and payment information through third-party infrastructure that the
laboratory neither hosts nor audits, which can be incompatible with
institutional data-residency requirements or cross-border-transfer
restrictions on participant identifiers.

For research programs that depend on careful psychophysical control,
on sampling from a local population, or on participant-identifier
handling that complies with institutional data-residency requirements,
the in-lab workflow remains the methodology of choice, and returns us
to Problems 1 and 2.

## 5. Our approach — a lab-scoped substrate, not a community standard

We make explicit what §1 already implies: the goal of this work is
not to standardize behavioral experiments. The combinatorial
heterogeneity of paradigms makes a universal on-disk format an
unproductive target. The goal is more modest: to give a laboratory —
or a research project within a laboratory — a single substrate on
which its own conventions, errors, and operational state become
explicit, typed, and queryable, and on which inter-researcher
coordination (handover, co-work, post-hoc audit) becomes a query
rather than a recollection.

We make the following design commitments.

1. Every experiment, every booking, every participant, every payment
   record, every code-registration event, and every external-service
   delivery attempt is a row in one Postgres schema with foreign-key
   integrity to a single `experiments.id`. The schema is authoritative
   for the laboratory's own records; copies in shared calendars and
   external knowledge-base products are mirrors. The schema is not
   intended as a community-wide standard, and no claim of cross-lab
   interoperability is made; the unit of consolidation is the
   laboratory.

2. The codebase is forkable and each laboratory hosts its own
   deployment. Locale-specific paperwork, institutional conventions,
   and language-specific researcher- and participant-facing
   communications live in deployment configuration rather than in
   source code. New tables and routes attach to the schema as
   laboratory-specific extensions.

3. Automation is bounded by human confirmation at both ends of the
   pipeline. At registration, an automated analysis pass over the
   registered experiment code (an LLM-based summary in our deployment)
   drafts a candidate description of the task layout, manipulation
   variables, dependent variables, random-seed handling, parameter
   files, counterbalancing structure, and raw-data storage path; the
   researcher reviews this draft and confirms or corrects it before
   the experiment can open for recruitment. No accuracy claim is made
   for the automated analyzer; its role is to draft, not to decide,
   and the resulting human-confirmed labels are persisted as queryable
   columns. At dispatch, every action that emits a record outside the
   laboratory boundary is preceded by an explicit modal-level
   confirmation from the researcher.

We report the schema-level consolidation as an existence proof; no
controlled before-and-after comparison against the pre-platform
workflow has been conducted, and operational gains (researcher time,
error rate, handover loss, audit time) are not measured here.

## 6. A note on AI-powered research, day science, and night science

Yanai and Lercher (2019) distinguish two complementary registers in
which scientific knowledge is produced: *day science*, the formal,
hypothesis-driven, methodologically explicit register that produces
published findings; and *night science*, the intuitive, exploratory,
free-associative register in which hypotheses are first generated,
experimental designs first sketched, and parameter spaces first
probed. Adjacent to their distinction — and separately from Yanai and
Lercher's argument — we observe that day science is what manuscripts
record, whereas much of what a laboratory actually knows in practice
(the parameter sweep that was tried and abandoned, the intuitive
judgment that a stimulus duration "should be" 500 ms, the unwritten
reason a particular exclusion was applied) is not retained in any
formal artifact and is consequently lost when a researcher leaves.

We do not claim that the platform described here preserves night
science in any direct sense. We observe, more carefully, that a
substrate which records every code-registration event, every
parameter-file checksum, every exclusion-criterion application, every
re-run of an analysis branch, and every text-based explanation that
the researcher attaches to a study at registration time accumulates an
operational record more granular than what manuscripts and
supplementary materials retain. Whether this granularity is useful to
future AI-powered research tooling is a question the present paper
does not adjudicate. We note only that such a substrate constitutes
one of several plausible preconditions: a laboratory-scoped corpus of
integrated operational artifacts cannot be reconstructed retroactively
from publications alone, and a laboratory that adopts a systematic
record-keeping substrate before AI-powered research tooling matures is
positioned differently from one that does not. This is offered as
observation rather than claim.

## 7. Paper structure

The remainder of this paper is organized as follows. The next section
(*Graphical Abstract*) presents a single diagram summarizing the
eleven-operation pipeline. The *Instructions* section documents each
operation from the perspective of a researcher adopting the platform
for a new study. An appendix lists the scheduled reconciliation jobs
and their failure-recovery semantics.

## References (placeholder — to be completed before submission)

- Brainard, D. H. (1997). The Psychophysics Toolbox. *Spatial Vision.*
- Chmielewski, M., & Kucker, S. C. (2020). An MTurk crisis? Shifts in
  data quality and the impact on study results. *Social Psychological
  and Personality Science.*
- Gorgolewski, K. J., et al. (2016). The brain imaging data structure
  (BIDS), a format for organizing and describing outputs of
  neuroimaging experiments. *Scientific Data.*
- Hartshorne, J. K., et al. *Psych-DS — A data standard for
  psychological research.* (community specification.)
- John, L. K., Loewenstein, G., & Prelec, D. (2012). Measuring the
  prevalence of questionable research practices with incentives for
  truth telling. *Psychological Science.*
- Kleiner, M., Brainard, D., & Pelli, D. (2007). What's new in
  Psychtoolbox-3? *Perception, 36 ECVP Abstract Supplement.*
- de Leeuw, J. R. (2015). jsPsych: A JavaScript library for creating
  behavioral experiments in a web browser. *Behavior Research Methods.*
- Nosek, B. A., Ebersole, C. R., DeHaven, A. C., & Mellor, D. T.
  (2018). The preregistration revolution. *PNAS.*
- Peirce, J. W. (2007). PsychoPy — Psychophysics software in Python.
  *Journal of Neuroscience Methods.*
- Simmons, J. P., Nelson, L. D., & Simonsohn, U. (2011). False-positive
  psychology: Undisclosed flexibility in data collection and analysis
  allows presenting anything as significant. *Psychological Science.*
- Sona Systems. *Sona Systems Cloud-based experiment management.*
  (commercial product, cited as representative recruitment-and-
  scheduling silo.)
- Yanai, I., & Lercher, M. (2019). Night science. *Genome Biology,*
  20, 179. <https://doi.org/10.1186/s13059-019-1800-6>
