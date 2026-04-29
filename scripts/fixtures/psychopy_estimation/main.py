"""
Time-bisection (estimation) demo — PsychoPy
Sequence:
    1) Show a tone of duration `stim_duration` (anchor short=0.4s, long=1.6s)
    2) Listener presses 'short' or 'long'.
    3) Adaptive procedure varies stim_duration around the bisection point.

Independent variable
    stim_duration : continuous, per-trial (sampled from log-uniform 0.4..1.6 s)

Saved variables
    expInfo['participant'], expInfo['session']  (per-session)
    rt, response, correct, stim_duration         (per-trial)
"""
from psychopy import visual, core, event, data, sound

expInfo = {'participant': '', 'session': '001', 'condition': 'main'}

n_blocks = 6
n_trials_per_block = 40
duration_anchors = (0.4, 1.6)         # seconds
fixation_duration = 0.5
iti = 0.6

trials = data.TrialHandler(
    trialList=data.importConditions('cond_bisection.csv'),
    nReps=n_trials_per_block,
    method='random',
)

win = visual.Window([1024, 768])
fix = visual.TextStim(win, text='+')

for block_i in range(n_blocks):
    for trial in trials:
        fix.draw()
        win.flip()
        core.wait(fixation_duration)

        tone = sound.Sound(value='C', secs=trial['stim_duration'])
        tone.play()
        core.wait(trial['stim_duration'])

        keys = event.waitKeys(keyList=['s', 'l'])
        rt = core.getTime() - trial['onset']
        response = 'short' if keys[0] == 's' else 'long'
        correct = response == trial['truth']

        trials.addData('rt', rt)
        trials.addData('response', response)
        trials.addData('correct', correct)
        trials.addData('stim_duration', trial['stim_duration'])

        core.wait(iti)

trials.saveAsWideText('data/' + expInfo['participant'] + '.csv')
win.close()
