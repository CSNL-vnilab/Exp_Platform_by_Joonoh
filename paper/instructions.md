# Instructions — Adopting the Platform for a New Study

This section documents the eleven sequential operations a researcher performs
when running a behavioral experiment through the platform, in the order they
occur in practice. Each operation describes (a) the user action, (b) the
artifact the platform produces, and (c) the row(s) added or modified in the
relational schema.

For concreteness we ground the description in a running example: the
*TimeExp1* paradigm, a time-reproduction task in which participants observe a
stimulus interval and reproduce it via key-press. The example researcher is
referred to as JOP. The example values used below are illustrative and reflect
a single in-person session structure (≈ 90 min, single visit, in-laboratory).

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

*TimeExp1 example.* The researcher publishes a single-session study with
duration 90 min, capacity 1 participant per slot, a per-session fee equal
to the host institution's standard participant-fee rate, and a recruitment
window of three weeks.

## 2. Code-repository registration

The researcher attaches the runtime that will execute the paradigm. Two
mechanisms are supported.

**Static path registration.** A path to a code directory (typically a
mounted laboratory file server or a public git repository) is stored on
the experiment. An AI-assisted static analysis pass runs over the
registered path and proposes a structured summary of the inferred task
layout, the manipulation variables and their levels, the dependent
variables and their data types, the stimulus classes, and the raw-data
storage path that the runtime will write into. The proposal is
surfaced to the researcher in a pre-flight confirmation panel: the
researcher accepts each inferred label as-is, corrects it inline, or
flags it for clarification before the experiment can transition out of
*draft* state. The accepted labels are persisted as queryable columns on
the experiment row and on each session's booking row, and the same
summary is mirrored to the knowledge-base page so that any analyst
opening the page later can identify the version of code, the variable
schema, and the storage convention associated with this row.

The methodological intent of this confirmation panel is reproducibility
*at intake* rather than reproducibility *post hoc*: an experimenter
running a paradigm that another laboratory member has previously run
sees, in the confirmation panel, the labels the prior experimenter
accepted, and is forced to either align with them or declare a
deliberate divergence. Data-convention drift that pre-platform
workflows discovered weeks later during analysis is here surfaced
before the first participant arrives.

**Runtime integration (in-browser execution).** For experiments executed
in the participant's browser, the registered URL is loaded inside a
sandboxed iframe at run time. The researcher's code interfaces with the
platform through a single function (`window.expPlatform.submitBlock(...)`)
that hands trial-level data to the platform for durable storage; the
platform handles counterbalancing, attention-check insertion, refresh-rate
synchronization, electronic signature collection, and per-block result
upload to object storage. The same AI-assisted pre-flight verification
runs over the registered URL's task script before the experiment can open
for recruitment.

In either mechanism, the connection between the experiment row and the
code artifact is now machine-readable, and the manipulation-variable
and storage-path declarations have been signed off by a human.

## 3. Knowledge-base synchronization

Every change to the experiment metadata (creation, edit, status transition,
booking confirmation, booking cancellation, observation entry) is mirrored
to the laboratory's external knowledge-base service. The mirror is one-way
(the platform owns the canonical record; the external knowledge base is a
derived projection). The mirrored fields cover:

- experiment title, project, schedule, capacity, and progress status,
- per-booking session number and gamma-hashed participant identifier
  (participant names are never written to the knowledge base),
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

*TimeExp1 example.* The researcher (JOP) shares the recruitment URL with the
institution's psychology-student channel. Three participants confirm
sessions across the three-week window; the schema now contains three
`bookings` rows linked to the one experiment row.

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

The field is unstructured by design. Researcher-specific phrasing and
language-tailored instructions are common, and experience indicates that a
free field with a stable rendering position is more useful than a structured
"list of common precautions."

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

The participant-fee disbursement workflow is the operation where the
platform's consolidation has the largest practical effect, because the
institutional administrative process for participant fees is paperwork-
heavy in many funding regimes. The exact form fields and document
attachments are locale-specific to the funding body that disburses
participant fees in the host jurisdiction; this section describes the
seven-step round-trip the platform implements at the abstraction level
that ports between regimes, and the locale-specific form fields and
templates live in the deployment configuration rather than in source code.

### 11.1 Initiation — automated dispatch to the participant

A scheduled reconciliation job examining slot end-times notices when a
booking has been completed (the slot has elapsed plus a grace window,
default seven days) and dispatches an email to the participant containing
a single-use signed link to a fee-information form. The email is sent
through the laboratory's institutional account so that it carries the
laboratory's organizational identity.

### 11.2 Collection — participant fills the form

The participant opens the link in a browser. The form collects the
identity, payment-account, and supporting-document fields that the
administrative office requires for disbursement: legal name; mobile and
email contact; bank name, account number, and account holder; the national
identifier required by the funding body for tax-withholding accounting; an
in-browser signature canvas; and an upload slot for the bank-account scan.
Sensitive fields (the national identifier in particular) are encrypted at
rest with an envelope cipher; the encryption key is held only in the
platform's production environment variables and is never exposed to the
user-interface bundle.

The form is rate-limited per token and per source address. On submission
the platform writes a `participant_payment_info` row, marks the booking
as *submitted-to-admin* state, and stores the signature and bank-account
scan in the object-storage service.

### 11.3 Submission audit — researcher confirms readiness

The researcher opens the experiment's *Bookings* tab. A card lists every
participant whose fee submission is *submitted-to-admin* and presents a
single button: *Claim N participants' fees*. The button is disabled until
at least one row is in the submitted-to-admin state. Clicking the button
opens a confirmation dialog naming each participant and the total amount.

### 11.4 Bundle generation

Confirmation triggers a one-shot bundle build. The platform retrieves the
institutional fee-form template (a deployment-supplied spreadsheet
maintained as a configuration artifact, not in source code, so that a
laboratory using a different funding regime supplies its own template
without code change), decrypts the national-identifier fields, downloads
the signatures and bank-account scans, and writes a per-participant filled
template plus a combined batch-upload template that the administrative
office consumes as bulk input. The resulting zip archive — containing the
filled per-participant forms, the batch-upload template, and the
bank-account scans — is offered to the researcher as a download.

The fee-status of the corresponding `participant_payment_info` rows is
atomically transitioned from *submitted-to-admin* to *claimed* as part of
the same operation; the transition is the gate that prevents the same
participant from being double-claimed by a second click.

### 11.5 Dispatch preview

A second button appears beside the claim button: *Send to the administrative
office.* Clicking it opens a preview modal showing:

- the recipient address (sourced from a configurable environment variable
  for the administrative office's email; editable in-modal for one-off
  destinations),
- a carbon-copy recipient (the researcher's own email, so they receive a
  copy on send),
- the subject line and body text the platform will send,
- the list of attachments the email will carry (the same filled forms and
  bank-account scans produced at §11.4).

The modal does not send anything. It is purely a preview surface.

### 11.6 Confirmation gate

The researcher reviews the preview. If they wish to proceed they click
*Send.* The platform issues the email through the laboratory's
institutional SMTP account with the researcher as carbon-copy recipient
and the researcher's contact email as the reply-to address — administrative
follow-up replies route directly to the researcher rather than to the
laboratory inbox. On successful send the platform records the message
identifier and the recipient address on the underlying claim row.

The confirmation gate is the platform's contract with the researcher:
no message leaves the system to an external administrative recipient
without an explicit modal-level confirmation. The same gate is enforced
on re-sends: opening the modal for a claim that has already been
dispatched produces an additional confirmation step ("this claim has
already been sent; re-send anyway?").

### 11.7 Failure-mode telemetry

Every attempt to send is stamped in the database with the attempt count,
the most recent error message (if any), and the timestamp. If a send fails
because the SMTP service refused the message or because the bundle build
threw, the next time the modal opens it surfaces a colored banner with the
exact error text and the time of the failed attempt. This converts the
otherwise-invisible "I clicked send and nothing happened" failure into a
visible, debuggable artifact.

*TimeExp1 example.* The researcher (JOP) returns to the dashboard one week
after the third session, sees three participants in *submitted-to-admin*
state, clicks claim, reviews the preview modal, confirms send. The
administrative office receives one email with five attachments (three
per-participant forms, one batch-upload template, one bank-account scan
archive). JOP receives a copy of the same email in their own inbox; any
follow-up question from the administrative office reaches JOP, not the
laboratory inbox.

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

## Appendix C — Anonymity and demo

The TimeExp1 walkthrough above is a redacted demonstration of an actual
deployment. Specific institutional identifiers (project number, grant
identifier, principal-investigator name, administrative recipient address,
laboratory account address) are intentionally omitted from the public paper
and instead live in the platform's environment-variable configuration. A
laboratory adopting the codebase replaces these values for their own
institution; no source-level change is required.
