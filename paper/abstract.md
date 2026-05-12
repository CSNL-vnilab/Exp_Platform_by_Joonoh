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
