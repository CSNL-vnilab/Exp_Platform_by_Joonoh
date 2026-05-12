# Introduction

## 1. Behavioral experiments depend on infrastructure that is rarely treated as a research artifact

A single behavioral experiment in psychology or cognitive neuroscience produces
far more files than the timestamped raw trial data it eventually publishes.
A typical study run inside a university laboratory generates, in parallel:
(i) a recruitment posting and its responses, (ii) calendar holds on a shared
booking system, (iii) one or more experiment-code repositories, (iv) per-session
stimulus tarballs and runtime configuration, (v) institutional review-board
records, (vi) per-participant payment receipts and the bank-transfer paperwork
required to disburse the participant fee. Each of these artifacts is necessary
to *re-run* the study at a later date or in a different group, yet they are
typically stored in unrelated systems — a shared spreadsheet, a calendar
account, a server folder, a paper binder — that have no machine-readable
linkage to each other. Replication failures and "lost-knowledge" handover
problems consequently arise not from any single missing file but from the
*join* between files that nobody documented.

This paper describes a working alternative: a single, self-hostable web
application that internalizes the full eleven-step life-cycle of a behavioral
experiment — from publication to participant-fee disbursement — and emits a
single auditable record per study. The platform is built on free-tier managed
infrastructure — a managed Postgres host with built-in object storage and
authentication, a serverless-function host, a transactional-email relay, a
shared-calendar API, and a knowledge-base service — and an opinionated
relational schema that forces every artifact to be addressable from every
other. Before describing the system itself, we document the two problem
classes that motivated it.

## 2. Problem 1 — Fragmentation in the offline (in-lab) workflow

In an in-person research laboratory, the recruitment-to-payment workflow is
typically distributed across the following independent surfaces.

- **Recruitment.** Posters, social-network posts, and lab websites collect
  prospective participants. Responses arrive by email or web form and are
  hand-copied into a scheduling spreadsheet.
- **Scheduling.** A shared calendar (often institutional Google or Microsoft
  365) is annotated by the experimenter with the participant's identifier.
  Re-bookings require manual deletion and re-creation of calendar events,
  which silently breaks downstream links.
- **Experiment code.** The runtime sits in a git repository on a personal
  laptop or lab server; the version actually run on a given session is
  identified only by the calendar event description, if at all.
- **Raw data.** Output files are written to a lab-server directory named by the
  experimenter, sometimes with a per-session subfolder, sometimes not.
- **Per-participant fee paperwork.** The experimenter walks the participant
  through a paper form, collects resident-registration information, copies a
  signed bankbook, and physically transports a packet to the administrative
  office for disbursement.

Each surface is individually defensible, but the *joins* between them are not
machine-readable. The same study acquires six different identifiers — a row
number in the spreadsheet, a calendar event ID, a code-repository commit hash,
a data-folder name, an administrative receipt number, and a published-paper
session label — and reconciling them after the fact requires the original
experimenter's memory. We have observed five concrete failure modes that
recur across multi-year experimental programs.

1. **Drift in data conventions.** Two experimenters running the same paradigm
   inevitably store the raw output in slightly different folder structures,
   filename templates, or column orderings, which makes pooled analysis
   labor-intensive and bias-prone.
2. **Manual time-sink.** A senior experimenter running ~50 sessions across a
   semester spends, by informal estimate in the present laboratory, on the
   order of 8–12 hours on reminder emails, calendar updates, and fee
   paperwork that adds no scientific value but cannot be delegated because
   the steps require institutional credentials. A controlled comparison is
   not reported here.
3. **Database noise.** The institutional database — when it exists — accrues
   incomplete rows because experimenters fill it at semester-end from memory
   rather than at session-end from system state, producing systematic
   under-reporting of edge-case attrition and exclusion.
4. **Budget planning is opaque.** With no per-experiment, per-session
   participant-fee record at the institutional rate, lab principal investigators
   cannot estimate the marginal cost of a new study or compute year-end
   participant-cost statistics without manually re-aggregating the
   administrative-office paper receipts.
5. **Handover is unsafe.** When a graduate student leaves the lab, the
   knowledge of "how to actually re-run this study" — the union of recruitment
   channel, schedule cadence, exclusion criteria implementation, stimulus
   version, and payment account — is not in any single place, and incoming
   researchers either restart from scratch or accept silent reproduction gaps.

Existing partial solutions address single surfaces. Calendar systems coordinate
scheduling but not data linkage; experiment-code frameworks such as PsychoPy
and jsPsych standardize the runtime but not the recruitment, payment, or
handover; lab-management products such as Sona Systems address recruitment
and scheduling but operate as proprietary silos that do not store experiment
code, raw data, or fee-claim records. The integrated end-to-end pipeline
remains, in practice, every laboratory's local invention.

## 3. Problem 2 — Cost and demographic bias in the online (remote-participant) workflow

The contemporary alternative to in-lab recruitment is remote-participant
marketplaces, most prominently Prolific and Amazon Mechanical Turk (MTurk).
These services solve recruitment, scheduling, and payment in one product but
introduce two structural problems for laboratory-grade research.

**Cost.** Both services bill at a substantial premium over the institutional
participant-fee rate that a university laboratory pays. Prolific's stated
minimum hourly compensation, plus platform service fees, places the effective
per-participant cost at multiple times the institutional rate. For
mid-size studies that intentionally recruit hundreds of participants — common
in psychophysics dose–response designs and individual-differences work — the
marketplace cost easily exceeds the budget envelope available to a single-PI
laboratory in many funding regimes.

**Participant bias.** The participant pool on these platforms is
demographically narrower than the general population in three respects
documented in the methodology literature (Stewart et al., 2015;
Chmielewski & Kucker, 2020; Peer et al., 2017; Palan & Schitter, 2018):

- *Demographic skew.* The active worker base is concentrated in English-
  language regions and skews younger and more educated than the general
  population.
- *Career-participant effect.* A small fraction of high-trial-count workers
  contribute a disproportionate share of completed studies, which inflates
  the population's familiarity with cognitive-task structure and complicates
  task naïveté assumptions.
- *Linguistic / cultural homogeneity.* Studies that depend on stimuli in
  non-English languages, on culture-specific knowledge, or on in-lab
  contextual cues are difficult or impossible to execute remotely.

For research programs that depend on careful psychophysical control or on
sampling from a local population, the in-lab workflow remains the methodology
of choice — which returns us to Problem 1.

## 4. Our approach — a single self-hosted platform on free-tier managed infrastructure

The platform described in this paper takes the position that the right unit
of consolidation is the laboratory, not the individual experimenter and not
the marketplace. A laboratory has stable institutional credentials (the
shared email account, the calendar, the data folders), a stable participant-fee
disbursement convention, and a stable set of physical locations and equipment.
By committing to one set of conventions at the laboratory level and emitting
every artifact through one auditable pipeline, the fragmentation problem
collapses without anyone paying marketplace prices.

We make three design commitments.

1. **One relational schema for every artifact.** Every experiment, every
   booking, every participant, every payment record, every external-service
   delivery attempt is a row in one Postgres database with foreign-key
   integrity. The schema is small enough to read end-to-end in one sitting
   (under sixty tables at present) and is the canonical source of truth.
   Mirror copies in calendar systems and external knowledge-base products
   are derived projections, not parallel sources of truth.
2. **Free-tier composition over custom infrastructure.** The platform is
   composed entirely of free-tier offerings: a managed Postgres host
   bundling authentication and object storage, a serverless-function host
   for the web layer and scheduled jobs, a transactional-email relay
   through the laboratory's institutional account, a regional
   short-message-service gateway (implementation appendix), a shared-calendar
   API for institutional visibility, and a knowledge-base service as a
   researcher-facing reference. No paid recruitment marketplace and no paid
   platform-as-a-service is on the cost path. A laboratory adopting the
   codebase pays for nothing the laboratory does not already have
   institutional access to.
3. **Automation behind an explicit confirmation gate.** Reminder delivery,
   calendar holds, knowledge-base mirroring, raw-data path registration,
   metadata-completion nudges, and end-to-end participant-fee claim
   including the administratively required form are produced by the system
   itself. Steps without a per-session scientific decision are automated,
   subject to researcher confirmation: the platform never auto-sends to an
   administrative recipient without an explicit modal-level confirmation
   from the researcher.

We note an honest limitation up front. No controlled before-and-after
comparison against the pre-platform workflow has been conducted; reductions
in researcher time, error rate, and handover loss are reported here as
qualitative observations and as the motivation for the design commitments,
not as benchmarked outcomes.

The resulting workflow is documented in the *Instructions* section of this
paper as a sequence of eleven operations, beginning with experiment
publication and ending with the dispatch of the institutional fee-claim form
to the administrative office. Each operation is performed once by a single
researcher in a single user-interface surface, and produces a row (or rows) in
the platform's relational schema; downstream systems consume those rows
through scheduled reconciliation jobs.

## 5. Roadmap

The single-schema commitment is also designed to host a future AI-assisted
experiment-design module: every experiment row already carries its design
metadata, code-repository pointer, raw-data path, and outcome status, so an
agent that reasons over the laboratory's historical corpus has access to
the full per-study record by foreign-key traversal. This extension is
outside the present paper's scope; we mention it here only to motivate the
schema commitments stated in §4, and defer concrete design and evaluation
to the Discussion.

## 6. Paper structure

The remainder of this paper is organized as follows. The next section
(*Graphical Abstract*) presents a single diagram summarizing the eleven-
operation pipeline at the level of who acts and what the system produces.
The *Instructions* section documents each operation from the perspective of
a researcher adopting the platform for a new study, with a worked example
(the TimeExp1 time-reproduction paradigm, run by an anonymized demo
researcher referred to as JOP). An appendix lists the cron-scheduled
reconciliation jobs and their failure-recovery semantics.

## References (placeholder — to be completed before submission)

- Anwyl-Irvine, A. L., Massonnié, J., Flitton, A., Kirkham, N., & Evershed,
  J. K. (2020). Gorilla in our midst: An online behavioral experiment
  builder. *Behavior Research Methods.*
- Chmielewski, M., & Kucker, S. C. (2020). An MTurk crisis? Shifts in data
  quality and the impact on study results. *Social Psychological and
  Personality Science.*
- Gorgolewski, K. J., et al. (2016). The brain imaging data structure (BIDS).
  *Scientific Data.*
- Hartshorne, J. K., et al. *Psych-DS — A data standard for psychological
  research.* (community specification.)
- Hauser, D. J., & Schwarz, N. (2016). Attentive Turkers: MTurk workers
  are more attentive than online subjects. *Behavior Research Methods.*
- Henninger, F., Shevchenko, Y., Mertens, U. K., Kieslich, P. J., & Hilbig,
  B. E. (2022). lab.js: A free, open, online study builder. *Behavior
  Research Methods.*
- de Leeuw, J. R. (2015). jsPsych: A JavaScript library for creating
  behavioral experiments in a web browser. *Behavior Research Methods.*
- Palan, S., & Schitter, C. (2018). Prolific.ac — A subject pool for online
  experiments. *Journal of Behavioral and Experimental Finance.*
- Peer, E., Brandimarte, L., Samat, S., & Acquisti, A. (2017). Beyond the
  Turk: Alternative platforms for crowdsourcing behavioral research.
  *Journal of Experimental Social Psychology.*
- Peirce, J. W. (2007). PsychoPy — Psychophysics software in Python.
  *Journal of Neuroscience Methods.*
- Peirce, J. W., et al. (2019). PsychoPy2: Experiments in behavior made
  easy. *Behavior Research Methods.* (Pavlovia online runner.)
- Pennycook, G., Cheyne, J. A., Koehler, D. J., & Fugelsang, J. A. (2018).
  Going with your gut: Investigating the time-course of attention checks
  on cognitive-reflection-style problems. *Behavior Research Methods.*
- Sona Systems. *Sona Systems Cloud-based experiment management.*
  (commercial product, cited as representative recruitment-and-scheduling
  silo.)
- Stewart, N., et al. (2015). The average laboratory samples a population
  of 7,300 Amazon Mechanical Turk workers. *Judgment and Decision Making.*
