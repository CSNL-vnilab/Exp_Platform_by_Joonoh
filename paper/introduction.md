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
linkage to each other. Replication failures and "lost-knowledge" handover problems consequently
arise not from any single missing file but from the *join* between files
that nobody documented.

We name this failure class **the join problem**: a reproducibility or
handover failure that arises not from any individual artifact being missing,
malformed, or non-standard, but from the absence of a machine-readable
referential identity binding two or more artifacts that were co-produced by
a single research event. The join problem is distinct from, and orthogonal
to, the failure modes that FAIR data principles (Wilkinson et al., 2016)
and file-layout standards such as BIDS (Gorgolewski et al., 2016) and
Psych-DS (Hartshorne et al.) are designed to address: each standardizes the
*shape* of a single artifact in isolation, while the join problem concerns
the *referential closure* across artifacts that live in heterogeneous
systems (a scheduling database, an institutional code host, a lab-server
folder, an administrative-office paper packet). The platform described in
this paper is a working instance of join-completion at the laboratory
scale — a single self-hostable web application that internalizes the full
eleven-step life-cycle of a behavioral experiment, from publication to
participant-fee disbursement, and emits a single auditable record per
study under an opinionated relational schema that the host laboratory owns
and extends. Before describing the system itself, we document the two
problem classes that motivated it.

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

Crowd-marketplace platforms also relocate the locus of data ownership to a
vendor: participants' identifying information, payment-account details, and
behavioral responses pass through, and are retained by, third-party
infrastructure that the laboratory neither hosts nor audits. For laboratories
subject to institutional data-residency requirements, jurisdiction-specific
participant-protection rules, or IRB constraints on cross-border data
transfer, the in-lab workflow is not merely cheaper than the marketplace
alternative — it is the only deployment posture compatible with the
laboratory's regulatory obligations.

For research programs that depend on careful psychophysical control, on
sampling from a local population, or on data-residency-compliant handling
of participant identifiers, the in-lab workflow remains the methodology of
choice — which returns us to Problem 1.

## 4. Our approach — one schema, one pipeline, one fork per laboratory

The platform described in this paper takes the position that the right
unit of consolidation is the laboratory itself, not the individual
experimenter and not the marketplace. A laboratory has stable institutional
credentials (the shared email account, the shared calendar, the lab-server
folders), a stable participant-fee disbursement convention, and a stable
set of physical locations and equipment. By committing to one set of
conventions at the laboratory level and emitting every artifact through
one auditable pipeline that the laboratory itself hosts, the join problem
collapses without ceding ownership to a vendor.

We make three design commitments.

1. **Referential closure of the study record.** Every experiment, every
   booking, every participant, every payment record, every external-service
   delivery attempt is a row in one Postgres schema with foreign-key
   integrity to a single `experiments.id`. The schema is small enough to
   read end-to-end in one sitting (under sixty tables at present) and is
   the canonical source of truth; mirror copies in calendar systems and
   external knowledge-base products are derived projections rather than
   parallel sources of truth. The methodological consequence: a published
   session label resolves to its recruitment posting, the commit hash of
   the runtime that produced its data, the object-storage path of its raw
   data, the participant's consented identifier, and the institutional
   disbursement receipt by a single foreign-key path. Provenance, in the
   FAIR-data sense (Wilkinson et al., 2016), is closed over the operational
   lifecycle rather than over the raw-data deposit alone.

2. **Schema-as-contract, deployment-as-customization.** The platform is
   delivered as a forkable codebase that each laboratory clones, hosts,
   and extends as its own deployment. Locale-specific paperwork (fee-form
   layouts, regulatory identifiers, reimbursement regimes), institutional
   conventions (calendar identifiers, knowledge-base targets, mailing-list
   addresses), and language-specific researcher- and participant-facing
   communications live in deployment configuration rather than in source
   code: the schema's invariant fields form the inter-laboratory contract,
   while the deployment-config layer absorbs the heterogeneity that
   distinguishes one laboratory from another. New operations attach to the
   schema by adding tables and routes rather than by patching the core,
   so a laboratory that needs (for example) an eye-tracker-calibration
   record or a longitudinal participant-pool table does so as a localized,
   typed extension that preserves interoperability with the upstream
   schema. This is the inverse of crowd-marketplace and lab-management
   SaaS products, which standardize by hosting all adopters on one shared
   schema instance and exposing only the configuration knobs the vendor
   anticipated. Here, each laboratory owns the schema instance and the
   deployment that runs against it. The operational-cost envelope of a
   typical deployment — managed Postgres, serverless functions,
   transactional email, a shared-calendar API, a knowledge-base API, and
   a regional short-message-service gateway, all available under free-tier
   offerings that a host institution typically already has access to — is
   documented in the implementation appendix; in this paper we treat the
   deployment cost as below the contribution threshold and focus on the
   schema-level commitments.

3. **Human-in-the-loop verification at both ends of the pipeline.** The
   platform pairs every machine-proposed record with an explicit
   researcher confirmation, at the two boundaries where automated
   inference is most useful and most error-prone.
   - *At registration (the intake boundary).* When a researcher attaches
     a code repository to a new experiment row, an AI-assisted static
     analysis pass reads the registered code and proposes the inferred
     task layout, the manipulation variables, the dependent variables,
     the stimulus classes, and the raw-data storage path. The researcher
     reviews this proposal in a confirmation panel and either accepts it
     or supplies corrections; the experiment row cannot be opened for
     recruitment until the analysis is signed off. The methodological
     consequence is that data-convention drift between experimenters is
     detected at the moment a paradigm enters the system rather than at
     end-of-semester reconciliation: two experimenters running the same
     time-reproduction task are forced, by the confirmation panel, to
     agree on whether the manipulation variable is called *interval* or
     *stimulus_duration* and on which directory will accumulate the
     output.
   - *At dispatch (the egress boundary).* Reminder delivery, calendar
     holds, knowledge-base mirroring, metadata-completion nudges, and
     end-to-end participant-fee claim including the administratively
     required form are assembled by the system itself. Every action that
     emits a record outside the laboratory boundary — a message to a
     participant, a packet to an administrative office, a row to the
     external knowledge base — is preceded by an explicit modal-level
     confirmation from the researcher, so the audit trail records human
     intent at every external dispatch.

   The pattern is the same at both ends: the platform proposes, the
   human confirms, the schema records. Automation is bounded by human
   sign-off, and that sign-off is preserved as a queryable artifact of
   the study record rather than as a private intention of the
   experimenter.

We note an honest limitation up front. No controlled before-and-after
comparison against the pre-platform workflow has been conducted; reductions
in researcher time, error rate, and handover loss are reported here as
qualitative observations and as the motivation for the design commitments,
not as benchmarked outcomes. The contribution claimed in this paper is the
schema-level closure property and the deployment-customization posture,
demonstrated as an existence proof over approximately 200 confirmed
bookings; controlled evaluation of operational gains is left to future work.

The resulting workflow is documented in the *Instructions* section of this
paper as a sequence of eleven operations, beginning with experiment
publication and ending with the dispatch of the institutional fee-claim form
to the administrative office. Each operation is performed once by a single
researcher in a single user-interface surface, and produces a row (or rows) in
the platform's relational schema; downstream systems consume those rows
through scheduled reconciliation jobs.

## 5. Operational consequences — rigor, ethics, handover, co-work

The three commitments of §4 are stated as design choices. We close the
introduction by recording four operational consequences that follow from
them, each of which addresses a category of failure that the literature on
reproducibility, research ethics, and laboratory practice has long
identified but that the platform now resolves as a property of the schema
rather than as a virtue of the experimenter.

**Experimental rigor enforced by construction.** Because every booking,
every code commit, every stimulus version, every storage path, and every
manipulation-variable definition is a column in the same schema, two
sessions of the same paradigm are forced into identical structural
provenance: same commit hash, same stimulus classes, same storage layout,
same fee schedule, same location. Inter-experimenter drift of the kind
that makes pooled analyses bias-prone (Problem 1, failure mode 1) is
removed *at the system level*, not at the experimenter's discretion. Where
prior workflows treated experimental rigor as a procedural ideal that
experimenters were exhorted to uphold, the schema reifies the same ideal
as a referential-integrity constraint that the database itself refuses to
violate.

**Pre-flight verification of experiment code and storage paths.** The
human-in-the-loop verification at registration described in §4
commitment (iii) is, methodologically, the moment at which the platform
catches the most damaging silent failures: an experimenter committing the
wrong runtime version, a manipulation-variable column whose units differ
from the rest of the lab's corpus, an output directory that does not match
the analysis-pipeline convention. AI-assisted static analysis surfaces
these as proposed labels; the researcher confirms or corrects; the schema
retains the confirmed labels as queryable fields. The operational effect
is that errors that pre-platform pipelines discovered weeks later — when
analysis scripts produced empty plots or when admin queried a missing
receipt — are surfaced before the first participant walks into the booth.

**Research-ethics auditability and data residency by construction.**
Institutional Review Boards increasingly require demonstrable provenance
between a consenting participant, the data produced from that
participant's session, and the disbursement record of the participant's
compensation. Pre-platform, this audit was an archaeological exercise
across paper packets, server folders, and email. Under referential closure
(§4 commitment (i)), the IRB query *"show me the consent record, the
raw-data path, and the disbursement receipt for this participant in this
study"* resolves to a single SELECT. The sensitive identifying fields that
anchor the audit (consent signature, payment-account information, the
regulatory identifier required by the funding body) are encrypted at rest
inside the laboratory's own deployment; under the sovereignty commitment
(§4 (ii)), no third-party vendor processes, retains, or routes them. For
laboratories subject to jurisdiction-specific data-residency rules or
cross-border-transfer restrictions, this is not a marketing convenience
but a regulatory requirement: the platform stays compliant by construction
because the participant data never crosses the institutional boundary the
platform was deployed inside of.

**Handover and inter-researcher co-work.** Graduate-student turnover and
collaborative work between researchers in the same laboratory were two of
the most expensive sources of lost knowledge in the pre-platform regime
(Problem 1, failure mode 5). Under the schema's referential closure,
re-running a study is a foreign-key walk: the experiment row points at
the registered code, the verified manipulation-variable list, the storage
path, the fee schedule, the location, the location-specific precautions,
and the historical participant list with attrition. An incoming researcher
inheriting a paradigm does not interview the departing researcher; they
query the schema. Two researchers running the same paradigm in parallel —
increasingly the norm in lab-collective psychophysics and developmental
studies — produce row-comparable data without coordination overhead,
because the schema commitments forbid the kinds of structural divergence
(different folder names, different column orderings, different
stimulus-version labels) that previously required out-of-band
synchronization.

These four consequences are not ancillary benefits of an engineering
project. They are the *empirical content* of the methodological claim made
in §4: a laboratory whose operational substrate is referentially closed,
sovereignly deployed, and human-confirmed at both intake and egress runs
experiments under epistemic and ethical conditions that a fragmented or
vendor-hosted laboratory cannot replicate.

## 6. Roadmap

A laboratory that has run twenty studies under the schema of §4 has, by
construction, a join-completed corpus: every artifact each study produced
is addressable from every other by foreign-key traversal. This is a
precondition for laboratory-scoped AI tooling — an assistant that proposes
design parameters from in-lab attention-check performance, that priors a
pre-registration on the laboratory's own historical effect sizes, or that
explains a deviation from established protocol — because such tooling
otherwise spends most of its retrieval budget reconstructing joins that
the schema commitment removes. The present paper neither implements nor
evaluates such an extension; we note only that the schema commitment is a
prerequisite to it, and defer concrete design and evaluation to the
Discussion.

## 7. Paper structure

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
- Bowker, G. C., & Star, S. L. (1999). *Sorting Things Out: Classification
  and Its Consequences.* MIT Press.
- Chmielewski, M., & Kucker, S. C. (2020). An MTurk crisis? Shifts in data
  quality and the impact on study results. *Social Psychological and
  Personality Science.*
- Edwards, P. N., Mayernik, M. S., Batcheller, A. L., Bowker, G. C., &
  Borgman, C. L. (2011). Science friction: Data, metadata, and
  collaboration. *Social Studies of Science.*
- Gorgolewski, K. J., et al. (2016). The brain imaging data structure (BIDS).
  *Scientific Data.*
- Gorgolewski, K. J., et al. (2017). BIDS Apps: Improving ease of use,
  accessibility, and reproducibility of neuroimaging data analyses.
  *PLoS Computational Biology.*
- Hacking, I. (1992). The self-vindication of the laboratory sciences. In
  A. Pickering (Ed.), *Science as Practice and Culture* (pp. 29–64).
  University of Chicago Press.
- Harris, P. A., Taylor, R., Thielke, R., Payne, J., Gonzalez, N., & Conde,
  J. G. (2009). Research electronic data capture (REDCap) — A
  metadata-driven methodology and workflow process for providing
  translational research informatics support. *Journal of Biomedical
  Informatics.*
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
- Star, S. L., & Ruhleder, K. (1996). Steps toward an ecology of
  infrastructure: Design and access for large information spaces.
  *Information Systems Research.*
- Stewart, N., et al. (2015). The average laboratory samples a population
  of 7,300 Amazon Mechanical Turk workers. *Judgment and Decision Making.*
- Wilkinson, M. D., et al. (2016). The FAIR Guiding Principles for
  scientific data management and stewardship. *Scientific Data.*
