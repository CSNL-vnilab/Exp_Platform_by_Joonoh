# Abstract

Running human behavioral experiments inside a single research laboratory currently
involves a fragmented toolchain. Participant recruitment, scheduling, location
notifications, reminders, experiment-code distribution, raw-data collection, and
the institutional fee-claim paperwork are handled by separate spreadsheets, email
threads, calendar entries, lab-server folders, and physical forms. The
fragmentation produces three concrete failure modes that compound over years of
running studies: data conventions drift between experimenters, accounting
records and behavioral records cannot be cross-referenced without manual
reconciliation, and an experimenter who leaves the lab effectively takes the
recipe for reproducing each study with them. The popular alternative —
outsourcing recruitment to remote-participant marketplaces such as Prolific and
Amazon Mechanical Turk — replaces fragmentation with cost and demographic-coverage
trade-offs: per-participant fees are an order of magnitude above the
institutional rate, and the participant pool is demographically narrower than the
general population, skewing toward English-speaking, high-trial-count workers.

We present a self-hosted, lab-scoped experiment platform that internalizes the
full life-cycle of a study into one auditable pipeline. The platform makes
three design commitments: (i) a single relational schema spanning recruitment
through participant-fee claim; (ii) composition of free-tier managed services
rather than custom infrastructure; and (iii) automation of every
researcher-visible step behind an explicit confirmation gate before any
externally visible action. Eleven sequenced operations are exposed in this
order — experiment publication, code-repository registration, mirror-database
synchronization, raw-result directory linkage, participant recruitment,
location dispatch, study-specific precautions, reminder delivery, booking
modification, metadata-completion nudging, and end-to-end participant-fee
claim including the administratively required form. The platform is in
production use at a single laboratory and has handled approximately 200
confirmed bookings across multiple researchers; reported reductions in
researcher time are observational, not the result of a controlled comparison.
The same schema is intended to host a future AI-assisted experiment-design
extension, which is deferred to the Discussion.

**Keywords:** psychological experiment infrastructure, reproducibility, lab
automation, self-hosted platform, fee-claim automation, methodology.
