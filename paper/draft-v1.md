# A Self-Hosted, Laboratory-Scoped Substrate for Behavioral-Experiment Workflows

**Working title; anonymized for review. Frozen as Draft v1.**

---

# Abstract

Behavioral experiments in psychology and cognitive neuroscience cannot
be standardized to a single on-disk format the way neuroimaging was by
the Brain Imaging Data Structure (BIDS): paradigms differ in apparatus,
parameter space, stimulus structure, response modality, and exclusion
criteria in ways that no community floor captures. In the absence of
such a floor, each laboratory — and often each researcher within a
laboratory — operates an informal record of how recruitment, runtime
code, parameter files, raw data, and participant payment relate to one
another. Replication failures, handover loss, silent implementation
errors (random-seed regressions, parameter-file overwrites, save-path
drift, counterbalance failures), and post-hoc questionable research
practices (unprincipled exclusion, parameter-sweep selective reporting)
all follow from the informality of this record rather than from any
particular missing artifact.

We describe a self-hosted platform that scopes consolidation to a
single laboratory or project rather than attempting a community
standard. Every artifact — recruitment posting, registered runtime
commit, parameter-file checksum, raw-data path, participant-fee
disbursement, external-dispatch record — is a foreign-key-linked row in
one Postgres schema that the laboratory owns and operates. At code
registration, an automated analysis pass (an LLM-based summary in our
deployment) drafts the inferred task layout, manipulation variables,
dependent variables, random-seed and counterbalance handling, and
storage path; the researcher reviews this draft and confirms or corrects
it before recruitment opens. Every action that emits a record outside
the laboratory boundary is preceded by an explicit researcher
confirmation.

The platform is in production use at one laboratory and has handled
approximately 200 confirmed bookings. We claim only the existence
proof: lab-scoped systematic record-keeping is offered as one
precondition for AI-powered research tooling and as infrastructure
for the inter-researcher coordination problems — handover, co-work,
post-hoc audit — that often remain implicit risks in the field. We do
not claim a community-wide behavioral data standard.

**Keywords:** behavioral-experiment infrastructure; lab-scoped data
management; research-ethics audit; reproducibility; methodology.

---

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


---

# Graphical Abstract

See `graphical-abstract/v4-polished.drawio` for the canonical rendering source.

---

# Instructions — Adopting the Platform for a New Study

This section documents the eleven sequential operations a researcher performs
when running a behavioral experiment through the platform, in the order they
occur in practice. Each operation describes (a) the user action, (b) the
artifact the platform produces, and (c) the row(s) added or modified in the
relational schema.

## 1. Experiment publication

The researcher opens the dashboard and selects *"New Experiment."* A form
collects the structural metadata that downstream operations depend on:

- experiment title and recruitment-page description,
- project / research-program reference (used to group experiments under one
  funding stream and one knowledge-base section),
- location reference (chosen from the laboratory's registered rooms — see
  §6),
- per-session duration and per-session participant capacity,
- number of sessions per participant (1 for a single-visit study, ≥ 2 for
  longitudinal designs),
- per-session participant fee at the institutional rate,
- recruitment window (start and end calendar dates),
- ethics-review identifier and any supporting documents,
- execution mode (in-person or browser-based),
- study-specific precautions to be communicated to participants (see §7).

Submission creates one row in the `experiments` table and immediately
produces (i) a knowledge-base page reflecting the experiment metadata
and (ii) the slot grid the recruitment page will render (the cartesian
product of the recruitment window and the per-day available time bands).

The experiment is created in *draft* state. To make it visible at the public
recruitment URL the researcher must explicitly enable the *"open for
recruitment"* toggle.

## 2. Code-repository registration

The researcher attaches the runtime that will execute the paradigm. Two
mechanisms are supported.

**Static path registration.** A path to a code directory (typically a
mounted laboratory file server or a public git repository) is stored on
the experiment. An automated analysis pass over the registered path (an
LLM-based summary in our deployment) drafts a candidate description of
the task layout, the manipulation variables and their levels, the
dependent variables and their data types, the stimulus classes, the
random-seed and counterbalance-handling convention, the parameter files
and their checksums, and the raw-data storage path that the runtime
will write into. The draft is presented to the researcher in a
pre-flight panel: the researcher accepts each label as-is, corrects it
inline, or flags it for clarification. The *open for recruitment* toggle introduced in §1 cannot be enabled
until the researcher has signed off on this pre-flight panel; no
accuracy claim is made for the automated analyzer, and the persisted
record reflects reviewed labels rather than raw analyzer output. The accepted labels are persisted as
queryable columns on the experiment row and on each session's booking
row, alongside the commit hash of the runtime that ran the session,
and the same summary is mirrored to the knowledge-base page.

**Runtime integration (in-browser execution).** For experiments executed
in the participant's browser, the registered URL is loaded inside a
sandboxed iframe at run time. The researcher's code interfaces with the
platform through a single function (`window.expPlatform.submitBlock(...)`)
that hands trial-level data to the platform for durable storage; the
platform handles counterbalancing, attention-check insertion,
refresh-rate synchronization, electronic signature collection, and
per-block result upload to object storage. The same pre-flight panel
applies before the experiment can open for recruitment.

## 3. Knowledge-base synchronization

Every change to the experiment metadata (creation, edit, status transition,
booking confirmation, booking cancellation, observation entry) is mirrored
to the laboratory's external knowledge-base service. The mirror is one-way
(the platform's database is authoritative; the external knowledge base is
a mirror). The mirrored fields cover:

- experiment title, project, schedule, capacity, and progress status,
- per-booking session number and an irreversibly hashed participant
  identifier (participant names are never written to the knowledge base),
- registered code path and registered raw-data path,
- per-booking observation notes entered post-session by the researcher.

If a synchronization attempt fails (network partition, knowledge-base API
rate limit, schema drift), it is retried on a thirty-minute cadence up to
five attempts. The dashboard surfaces a status card listing rows whose
mirror is currently stale. A manual *"resync"* control is exposed on each
experiment page.

## 4. Raw-data directory linkage

The path under which raw output will accumulate is stored on the experiment
row.

- For in-person studies, the path is supplied by the researcher (typically a
  subdirectory of the laboratory's data server, named by paradigm and
  participant identifier).
- For browser-based studies, the path is assigned automatically by the
  platform under managed object storage; each session writes per-block
  result files under `experiment-data/<experiment-id>/<booking-id>/`.

Because the path is stored on the same row as the registered code path
(§2), an analyst can locate code and data for any historical session from
the experiment row alone.

## 5. Participant recruitment

Enabling the *open for recruitment* toggle activates a public URL of the
form `/<experiment-id>`. The researcher distributes this URL through
existing channels (laboratory mailing lists, institutional bulletin boards,
campus channels). The platform does not run a recruitment marketplace; it
runs an opt-in registration interface that the researcher fronts with their
own outreach.

The recruitment page displays the slot grid produced at experiment creation
(§1). Slots that have been claimed by another participant, or that have
been blocked by the shared institutional calendar at that time, are
filtered out before render. Selecting a slot opens a participant-side form
collecting name, contact information, and explicit informed-consent
confirmation.

Submission attempts an atomic claim of the slot at the database level —
two simultaneous submissions on the same slot result in exactly one
confirmed booking, with the other surfaced a "slot no longer available"
message. On confirmation the platform writes a row to `bookings`, issues
an immediate confirmation email and short message to the participant,
creates an event on the laboratory's shared calendar, and triggers the
knowledge-base sync described in §3.

## 6. Location dispatch

The platform maintains a curated list of laboratory rooms registered by an
administrator. Each registered location carries a display name, the postal
address (multi-line), and a public map link.

When the researcher selects a location at experiment creation (§1), the
chosen location is automatically embedded in every participant-facing email
the system sends about that experiment: the confirmation email at booking,
the day-before reminder, the day-of reminder, and (for fee disbursement)
the participant-fee form.

Researchers without administrator privilege cannot register new locations;
location registration is a deliberate gate to prevent ad-hoc address strings
from proliferating across studies.

## 7. Study-specific precautions

A free-form text field on the experiment row carries study-specific
instructions to participants (caffeine restrictions, glasses recommendations,
arrival logistics, etc.). The platform embeds this text into the same
participant-facing emails described in §6.

The field is unstructured by design; researcher-specific phrasing and
language-tailored instructions are common.

## 8. Reminder delivery

For each confirmed booking the platform schedules two automated reminder
emails by default: one the day before the slot at 18:00 local time and one
the day of the slot at 09:00 local time. Both contain the location and
precautions text described in §6 and §7.

Per-experiment overrides are available: the researcher can disable either
reminder, or change the local time at which it is dispatched. Reminder
sending is performed by a scheduled reconciliation job that runs every
fifteen minutes; transient delivery failures are retried with exponential
backoff up to five attempts.

A milestone reminder is not the same as a calendar invitation. The calendar
event created at booking confirmation (§5) is the long-lived structural
record; the email is the at-need attention prompt.

## 9. Booking modification and cancellation

Both researchers (on behalf of participants) and participants themselves can
modify or cancel a confirmed booking before the slot start time.

The researcher path is reached through the experiment's *Bookings* tab; the
participant path is the *change/cancel* link embedded in the original
confirmation email and signed with a single-use, scoped token.

In either case the platform performs the same downstream reconciliation:
the new slot (if any) is atomically claimed, the participant is notified of
the change with both the prior and the new time, the calendar event is
updated in place, the knowledge-base page is re-synced, and the reminder
schedule (§8) is recomputed for the new slot start.

## 10. Metadata-completion nudging

Once a study has begun running, the experiment row's required metadata
(code path, raw-data path, ethics identifier, stimulus-set version, and any
study-specific required fields) must be filled if it is to be
reproducible without the original experimenter. Researchers nonetheless
forget. The platform runs a weekly job that scans each researcher's
experiments for missing-required-metadata conditions and emails a
per-researcher digest summarizing which experiments are incomplete and
which fields are missing. The digest is delivered on Monday at 09:00 local
time; the dashboard surfaces the same information as a card so it is
visible without opening the email.

## 11. Participant-fee claim — end-to-end

Section 11 implements the participant-fee disbursement workflow. The
exact form fields and document attachments are locale-specific to the
funding body that disburses participant fees in the host jurisdiction;
the locale-specific form fields and templates live in the deployment
configuration rather than in source code, and the description below is
at the abstraction level that ports between regimes.

The round-trip is as follows. Once a session has elapsed (plus a default
seven-day grace window), a scheduled job emails the participant a
single-use signed link to a fee-information form; the participant fills
in the fields the administrative office requires (legal name, contact,
bank account, the regulatory identifier the funding body needs for
tax-withholding accounting, an in-browser signature, and an upload of
the bank-account scan), and the platform writes a `participant_payment_info`
row with the sensitive fields encrypted at rest. The researcher then
opens the experiment's *Bookings* tab, sees a card listing every
participant ready for claim, reviews a confirmation dialog naming each
participant and the total amount, and clicks *Claim*. This triggers a
one-shot bundle build that fills a deployment-supplied template
(maintained as a configuration artifact, not in source code), assembles
the per-participant forms with the batch-upload template and bank-account
scans into a zip, and atomically transitions the affected rows from
*submitted-to-admin* to *claimed* — the transition is the gate that
prevents the same participant from being double-claimed by a second
click. A second button opens a preview modal showing the recipient
address (a configurable environment variable for the administrative
office, editable in-modal), a carbon-copy to the researcher, the
subject and body text, and the attachment list; nothing is sent until
the researcher confirms.

Every send attempt is stamped in the database with the attempt count,
the most recent error message (if any), and the timestamp, and a failed
send surfaces the error text in the modal on the next open, so that
silent failures become visible artifacts on the claim row.

## Appendix A — Operational reconciliation schedule

| Cadence | Job | Effect |
|---|---|---|
| every 15 min | reminder dispatch | sends reminders for bookings whose dispatch time has elapsed |
| every 30 min | external-service retry | retries failed knowledge-base / calendar / email / SMS deliveries |
| daily 01:00 local | knowledge-base integrity scan | reports stale or missing knowledge-base mirrors |
| daily 02:15 local | session-completion audit + fee dispatch | marks elapsed sessions as completed and sends fee-info link to participants |
| weekly Monday 09:00 local | metadata-completion digest | emails researchers about experiments with missing required metadata |

## Appendix B — Permission model

| Role | Capability |
|---|---|
| researcher | create / edit / publish own experiments; manage bookings, observations, and fee claims for own experiments |
| administrator | view and edit all experiments; approve researcher signups; register locations and shared precaution templates |

## Appendix C — Deployment configuration

Institutional identifiers (project number, grant identifier,
principal-investigator name, administrative recipient address,
laboratory account address) are not part of the codebase; they live in
the platform's deployment configuration. A laboratory adopting the
codebase supplies its own values; no source-level change is required.

---

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
