# Random-dot-motion 2AFC (jsPsych)

Perceptual decision experiment — left/right motion choice with varying coherence and reward bias.

Genre: **decision**
Framework: **jspsych**
IVs (per-trial, factorial):
- `coherence` ∈ {0.04, 0.08, 0.16, 0.32}
- `direction` ∈ {left, right}
- `payoff` ∈ {neutral, biased}
DV: `choice`, `correct`, `rt`
Setup: 4 blocks, 64 trials/block (factorial × 2 repetitions), 800 ms stim, 2500 ms response window
Saved (per-trial): rt, choice, correct, coherence, direction, payoff
Saved (per-session): participant_id (via addProperties)
