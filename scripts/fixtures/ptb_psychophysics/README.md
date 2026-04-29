# Contrast-detection psychophysics (PTB)

Adaptive contrast threshold experiment.

Genre: **psychophysics**
Framework: **psychtoolbox**
IV (per-trial, adaptive): `contrast` (continuous)
Setup constants: 5 blocks × 60 trials, fixation 0.5 s, stim 0.05 s, ITI 0.4 s
DV per-trial: response, correct, rt, contrast
DV per-block: blockThreshold
Saved: `results/<subID>.mat`

`par.condition = 1` is a single-value constant (not an IV) — the test of the analyzer is whether it correctly classifies it as parameter[shape=constant] vs. factor.
