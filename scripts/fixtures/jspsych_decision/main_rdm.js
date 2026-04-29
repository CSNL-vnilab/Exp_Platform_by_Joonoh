// Random-dot-motion 2AFC (jsPsych 7+)
// Genre: decision; Framework: jspsych
//
// Independent variables (factorial)
//   coherence ∈ {0.04, 0.08, 0.16, 0.32}    motion strength
//   direction ∈ {left, right}               signed
//   payoff    ∈ {neutral, biased}           reward asymmetry
//
// DVs: rt, choice, correct
// Setup: 4 blocks, 64 trials/block (16 cells × 2 reps × 2 directions)

const jsPsych = initJsPsych({on_finish: () => jsPsych.data.displayData()});

const factors = jsPsych.randomization.factorial({
  coherence:  [0.04, 0.08, 0.16, 0.32],
  direction:  ['left', 'right'],
  payoff:     ['neutral', 'biased'],
}, 1);

const trial = {
  type: 'rdk-2afc',
  stimulus_duration: 800,    // ms — single value, not IV
  trial_duration: 2500,      // ms response window
  data: function() {
    return {coherence: jsPsych.timelineVariable('coherence'),
            direction: jsPsych.timelineVariable('direction'),
            payoff:    jsPsych.timelineVariable('payoff')};
  },
  on_finish: function(data) {
    data.choice  = data.response;
    data.correct = data.choice === data.direction;
  }
};

const N_BLOCKS = 4;
const TRIALS_PER_BLOCK = factors.length * 2;   // 64

const timeline = [];
for (let b = 0; b < N_BLOCKS; b++) {
  timeline.push({
    timeline: [trial],
    timeline_variables: factors,
    randomize_order: true,
    repetitions: 2,
  });
}

jsPsych.data.addProperties({participant_id: prompt('Participant ID?')});
jsPsych.run(timeline);
