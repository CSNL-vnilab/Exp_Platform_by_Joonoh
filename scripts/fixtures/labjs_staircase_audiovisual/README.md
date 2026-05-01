# Audiovisual SOA discrimination (lab.js + QUEST)

Genre: **psychophysics**
Framework: **lab.js**
IVs (per-trial):
  - `soa_ms` — *adaptively sampled* by QUEST (continuous, no fixed level vector). role=per_trial, shape=expression.
  - `modality_order` — counterbalanced between subjects: `mod(subjNum, 2)` → `audio_first` or `visual_first`. role=between_subject.

DVs (per-trial): response, rt_ms, correct, quest_mean_estimate, quest_sd_estimate
Setup constants: 8 practice + 80 main trials, audio 50 ms, visual 50 ms, ITI 600 ms, starting SOA 100 ms.
Phases: 1 practice + 1 main → `meta.block_phases` length 2.
Saved file: `data/<subject_id>.csv`.

Trap: model often classifies `soa_ms` as `parameter[shape=constant]` because it's never assigned a literal numeric vector — the IV value comes from `quest.recommend()` per trial. The strengthened prompt rule 14(b) tells the model to register adaptive IVs as `per_trial / shape=expression`.
