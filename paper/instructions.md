# Instructions — Adopting the Platform for a New Study

This section documents the eleven sequential operations a researcher performs
when running a behavioral experiment through the platform, in the order they
occur in practice. Each operation describes (a) the user action, (b) the
artifact the platform produces, and (c) the row(s) added or modified in the
relational schema.

The running example is the *TimeExp1* paradigm (a time-reproduction task,
≈ 90 min single in-person session) run by an anonymized demo researcher
JOP; example values are illustrative.

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
the experiment. An automated analysis pass over the registered path (an
LLM-based summary in our deployment) drafts a candidate description of
the task layout, the manipulation variables and their levels, the
dependent variables and their data types, the stimulus classes, and the
raw-data storage path that the runtime will write into. The draft is
presented to the researcher in a pre-flight panel: the researcher
accepts each label as-is, corrects it inline, or flags it for
clarification. The experiment cannot transition out of *draft* state
until the researcher has signed off; no accuracy claim is made for the
automated analyzer, and the platform's contract is that the draft is
*reviewed*, not *trusted*. The accepted labels are persisted as
queryable columns on the experiment row and on each session's booking
row, and the same summary is mirrored to the knowledge-base page.

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

In the TimeExp1 deployment the recruitment URL is shared with the
institution's psychology-student channel; each claimed slot adds one row
to `bookings` and is foreign-keyed to the single `experiments` row.

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

## Appendix C — Anonymity and demo

The TimeExp1 walkthrough above is a redacted demonstration of an actual
deployment. Specific institutional identifiers (project number, grant
identifier, principal-investigator name, administrative recipient address,
laboratory account address) are intentionally omitted from the public paper
and instead live in the platform's environment-variable configuration. A
laboratory adopting the codebase replaces these values for their own
institution; no source-level change is required.
