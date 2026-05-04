// Audiovisual SOA discrimination — lab.js + QUEST staircase
//
// Genre: psychophysics (cross-modal) with adaptive procedure
// Framework: lab.js
//
// IVs (per trial):
//   soa_ms          — adaptively sampled by QUEST (no fixed level vector)
//   modality_order  — counterbalanced within session ("audio_first" or "visual_first")
//
// DVs:
//   response, rt_ms, correct
//   quest_mean_estimate, quest_sd_estimate (per trial)
//
// Setup constants (parameters):
const QUEST_BETA           = 3.5;       // psychometric slope guess
const QUEST_GUESS_RATE     = 0.5;       // 2AFC chance
const QUEST_LAPSE_RATE     = 0.02;
const N_TRIALS             = 80;
const N_PRACTICE           = 8;
const AUDIO_DURATION_MS    = 50;
const VISUAL_DURATION_MS   = 50;
const ITI_MS               = 600;
const STARTING_SOA_MS      = 100;
const SOA_RANGE_MS         = [10, 400];
const SCREEN_REFRESH_HZ    = 60;

import lab from 'lab.js';

// QUEST helper (simplified)
class Quest {
  constructor({ tGuess, tGuessSd, beta, guessRate, lapseRate }) {
    this.tGuess = tGuess; this.tGuessSd = tGuessSd;
    this.beta = beta; this.guessRate = guessRate; this.lapseRate = lapseRate;
    this.history = [];
  }
  recommend() {
    // ... abbreviated for fixture
    return Math.max(SOA_RANGE_MS[0], Math.min(SOA_RANGE_MS[1], this.tGuess));
  }
  update(intensity, response) {
    this.history.push({ intensity, response });
    if (response === 1) this.tGuess *= 0.9;
    else this.tGuess *= 1.1;
  }
  mean() { return this.tGuess; }
  sd() { return this.tGuessSd; }
}

const quest = new Quest({
  tGuess: STARTING_SOA_MS,
  tGuessSd: 80,
  beta: QUEST_BETA,
  guessRate: QUEST_GUESS_RATE,
  lapseRate: QUEST_LAPSE_RATE,
});

// session-level: counterbalance modality order
const subject_id = prompt('Subject ID?');
const modality_first = (parseInt(subject_id, 10) % 2 === 0) ? 'audio_first' : 'visual_first';
const session_timestamp = new Date().toISOString();

const trials = [];
for (let i = 0; i < N_PRACTICE + N_TRIALS; i += 1) {
  const requested_soa = quest.recommend();
  const trial = new lab.html.Screen({
    parameters: {
      trial_index: i,
      phase: i < N_PRACTICE ? 'practice' : 'main',
      soa_requested: requested_soa,
      modality_first,
    },
    duration: AUDIO_DURATION_MS + requested_soa + VISUAL_DURATION_MS,
  });
  trial.on('end', (data) => {
    data.soa_actual           = data.soa_requested;
    data.response             = data.response_key;
    data.rt_ms                = data.duration;
    data.correct              = (data.response === 'expected') ? 1 : 0;
    data.quest_mean_estimate  = quest.mean();
    data.quest_sd_estimate    = quest.sd();
    data.session_timestamp    = session_timestamp;
    data.subject_id           = subject_id;
    quest.update(data.soa_actual, data.correct);
  });
  trials.push(trial);
}

const practice_block = new lab.flow.Sequence({
  content: trials.slice(0, N_PRACTICE),
  parameters: { block_kind: 'practice' },
});
const main_block = new lab.flow.Sequence({
  content: trials.slice(N_PRACTICE),
  parameters: { block_kind: 'main' },
});
const session = new lab.flow.Sequence({
  content: [practice_block, main_block],
});

session.on('end', () => {
  // Save to data/<subject>.csv
  session.options.datastore.save('data/' + subject_id + '.csv');
});

session.run();
