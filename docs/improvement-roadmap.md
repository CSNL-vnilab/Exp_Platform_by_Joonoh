# Research Platform Improvement Roadmap

**Date:** 2026-04-24 · **Owner:** 박준오 (JOP) · **Notion:** https://www.notion.so/Notion-DB-2026-04-24-34c2a38e4f5f81deb50feb0511e30a7f

Agent handoff doc — tight version of the Notion page. Use when resuming work on the SLab platform.

## Why

Platform ships reservations + observations + Notion mirror cleanly. But 2 years from now, nothing guarantees a session's data can be reanalyzed: no git commit, no env lockfile, no raw-vs-derivatives split, no preregistration link, no exclusion flag, no BIDS/Psych-DS export path. Benchmark against BIDS · Psych-DS · NWB · DataLad · ReproNim · OSF · Poldrack / Niv / Saxe / Kording labs showed 9 specific gaps.

## Top-level priorities (short form)

**P0 — reproducibility floor (1-2 weeks)**
- C1 · bookings gets `git_sha` · `env_lockfile_hash` · `container_image_digest` (runtime captures on session start)
- C2 · experiments.data_path → `raw_data_path` · `derivatives_path` · `analysis_notebook_url` · `figures_path`
- C3 · Projects DB gains `preregistration_url` · `irb_protocol_id` · `irb_version` (flows to SLab via relation)
- C4 · bookings gains `exclusion_flag` · `exclusion_reason` · `data_quality` (good/flag/exclude)

**P1 — standards compliance (2-4 weeks)**
- C5 · `scripts/export-psych-ds.mjs` emits dataset_description.json + participants.tsv + sessions.tsv per project. Download button on /experiments/[id].
- C6 · pre_experiment_checklist structured schema: `consent_signed_at · irb_protocol_verified · eligibility_confirmed · equipment_calibrated · payment_info_collected · contraindications_checked · attention_check_pretest_passed`
- C7 · status=완료 gate: `actual_duration_min · exit_questionnaire_complete · researcher_notes nonempty · data_file_count > 0 · raw|derivatives present`
- C8 · expose EXPERIMENT_EXCLUDED rationale in the booking UI (RPC already enforces it)
- C9 · session row: `device_id · room_id · stimulus_set_version`
- C10 · participants: `handedness · vision_correction · native_language`

**P2 — workflow polish (background)**
- C11 · bookings/experiments audit log (append-only, per-field diff + who/when)
- C12 · document Notion-vs-native decision rubric
- C13 · reanalysis-readiness score 0-100 (dashboard donut)
- C14 · per-experiment `osf_project_url · datalad_dataset_id · openneuro_accession · publication_doi`
- C15 · per-session QC: attention-check pass rate · total response time · bot screener → auto-set `data_quality=flag` on low quality
- C16 · participant_class transition evidence log (session count · on-time rate · attention rate · researcher rating)

## Sprint sequence (~6 weeks)

| Sprint | Duration | Deliverables |
|---|---|---|
| **A** — P0 reproducibility | 1-2w | migration adds git_sha/env_digest/container_digest/exclusion/data_quality · /run environment capture hook · data_path split |
| **B** — IRB / prereg | 1w | Projects DB schema + experiment-form UI + SLab autopopulate |
| **C** — Standards export | 2w | `scripts/export-psych-ds.mjs` + /experiments/[id] download button |
| **D** — Checklist + audit | 1w | structured pre_experiment_checklist + bookings_audit table + trigger |
| **E** — QC + readiness score | 1w | attention-check aggregation + /dashboard readiness donut |

## Key references

- BIDS — https://bids.neuroimaging.io/
- Psych-DS — https://psych-ds.github.io/
- DataLad — https://handbook.datalad.org/
- ReproNim — https://repronim.org/
- OSF Preregistration — https://help.osf.io/article/330-welcome-to-registrations
- Poldrack Lab — https://www.poldracklab.org/
- Niv Lab — https://github.com/nivlab
- Sona disqualifier-studies — https://www.sona-systems.com/

## How to use this doc

- **Humans:** work from the Notion page (has to-do blocks, check off as you go).
- **Agents:** this .md is the canonical plan; each C-tag is a discrete deliverable. Prefer P0 first. When starting a task, search `C\d+` in recent commit messages to see if someone already shipped it.
- **Regenerate Notion page:** `node scripts/create-improvement-roadmap.mjs` — idempotent (archives old, creates new).

## Current state snapshot (2026-04-24)

- Repo: 20 commits ahead of origin/main covering calendar consistency · D6 retry services · D9 exclusion · parser tests · dashboard reminders.
- Migrations on disk not yet applied to prod: `00044_notion_health_check_type_outbox` · `00045_book_slot_exclude_experiments` · `00046_pending_work_outbox_coverage`. Stream 2's `00024_participant_payment_info` deferred separately.
- Background QC green iter=58+ (~20h runtime).
- No code references to: `git_sha` · `container_digest` · `preregistration` · `irb_protocol_id` · `raw_data_path` · `derivatives` · `exclusion_reason` · `data_quality`. Every P0/P1 gap listed above is a genuine greenfield addition.
