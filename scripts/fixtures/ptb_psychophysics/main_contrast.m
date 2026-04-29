%% Contrast-detection psychophysics — PTB
% Sub-threshold contrast detection. Adaptive procedure (3-down 1-up) varies
% contrast around threshold; reports threshold + slope.
%
% IV (per-trial): contrast (continuous, adaptive)
% DV: response (yes/no), correct, RT
% Per-block: threshold estimate
% Per-session: subID, run-end RNG state

clear all; clc; rng('shuffle');

par = struct();
par.subID      = input('Subject ID: ', 's');
par.condition  = 1;                % single condition — IV is contrast (not condition)
par.nBlocks    = 5;
par.nT         = 60;               % trials per block (single number — not a stage array)
par.contrastRange = [0.005 0.5];   % adaptive limit
par.tStim      = 0.05;
par.tFixation  = 0.5;
par.iti        = 0.4;

[par.window, par.rect] = Screen('OpenWindow', 0, 128);

for iR = 1:par.nBlocks
    par.iR = iR;
    threshold = nan;
    for iT = 1:par.nT
        contrast = adaptive_step(par, iR, iT);
        Screen('FillRect', par.window, 128);
        Screen('Flip', par.window);
        WaitSecs(par.tFixation);
        % present grating with current contrast …
        WaitSecs(par.tStim);

        [keyDown, t0, keyCode] = KbCheck;
        rt = GetSecs - t0;
        response = KbName(keyCode);
        correct = strcmp(response, 'y');   % stimulus presence simulated

        par.results.contrast(iR, iT) = contrast;
        par.results.response{iR}{iT} = response;
        par.results.correct(iR, iT) = correct;
        par.results.rt(iR, iT) = rt;

        WaitSecs(par.iti);
    end
    % per-block threshold
    threshold = compute_threshold(par.results.contrast(iR, :), par.results.correct(iR, :));
    par.blockThreshold(iR) = threshold;
end

par.rng.runEnd = rng;
save(fullfile('results', [par.subID '.mat']), 'par');
sca;

function c = adaptive_step(par, iR, iT)
    if iT == 1
        c = mean(par.contrastRange);
    else
        prev = par.results.correct(iR, iT-1);
        last_c = par.results.contrast(iR, iT-1);
        c = max(par.contrastRange(1), min(par.contrastRange(2), ...
            last_c * (prev * 0.9 + (1-prev) * 1.2)));
    end
end

function t = compute_threshold(c, k)
    t = mean(c(k == 1));
end
