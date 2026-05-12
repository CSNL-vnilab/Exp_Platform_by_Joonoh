# Abstract

Running human behavioral experiments inside a single research laboratory
splits the study lifecycle across spreadsheets, shared calendars, code
repositories, lab-server folders, email, and paper forms. Each artifact
may be individually well-formed, but the *joins* between them — which
session belongs to which booking, which commit produced which raw-data
file, which payment receipt corresponds to which consent record — are
maintained by hand and can be lost when an experimenter leaves.

We describe a self-hosted platform that consolidates this workflow
under one Postgres schema, such that a published session label resolves
by foreign-key walk to its recruitment posting, runtime commit,
raw-data path, and disbursement record. The platform is delivered as a
forkable codebase: each laboratory hosts its own deployment, and
locale-specific paperwork, fee regimes, and language live in deployment
configuration rather than in source. Automation is bounded by human
confirmation at both ends of the pipeline: at registration, an automated
analysis pass over the registered experiment code (an LLM-based summary
in our deployment) drafts a candidate description of the task layout,
manipulation variables, dependent variables, and raw-data storage path,
which the researcher reviews and confirms or corrects before recruitment
opens; at dispatch, every action that emits a record outside the
laboratory boundary is preceded by an explicit researcher confirmation.

The system is in production use at one laboratory and has handled
approximately 200 confirmed bookings. We report the schema-level
consolidation as an existence proof; controlled measurement of
operational gains is left to future work.

**Keywords:** behavioral-experiment infrastructure; lifecycle schema;
self-hosted research platform; methodology.
