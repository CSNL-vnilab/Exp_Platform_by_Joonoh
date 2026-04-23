// Minimal online experiment: a digit-span "type the number you saw + click 확인"
// paradigm. 3 blocks × 5 trials. Uses only mouse click + keyboard number input,
// no keyboard-shortcut listening, so it works on tablets.
//
// Contract (exposed by the /run shell):
//   window.expPlatform.subject         — integer subject number
//   window.expPlatform.experimentId    — uuid
//   window.expPlatform.bookingId       — uuid
//   window.expPlatform.blocksSubmitted — how many blocks the server already has
//   window.expPlatform.submitBlock({ blockIndex, trials, blockMetadata, isLast })
//
// The shell loads this file via <script src> inside a sandboxed iframe.
// No same-origin, so no cookies / storage access — all state is in-memory.

(function () {
  var EP = window.expPlatform;
  if (!EP) {
    document.body.innerHTML =
      '<p style="padding:24px;color:#555">Load this via the experiment runtime.</p>';
    return;
  }

  var BLOCKS = 3;
  var TRIALS_PER_BLOCK = 5;
  // 3-digit numbers to remember. Random per trial, deterministic per subject
  // across reloads would be nicer but not required for the demo.
  function randDigit() { return Math.floor(Math.random() * 9) + 1; }
  function randomNumber() {
    return '' + randDigit() + randDigit() + randDigit();
  }

  var root = document.getElementById('exp-root') || document.body;
  root.style.cssText =
    'font-family: -apple-system, "Segoe UI", sans-serif; color: #e5e7eb; padding: 32px; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; box-sizing: border-box;';

  function el(tag, style, children) {
    var n = document.createElement(tag);
    if (style) n.style.cssText = style;
    (children || []).forEach(function (c) {
      if (c == null) return;
      if (typeof c === 'string') n.appendChild(document.createTextNode(c));
      else n.appendChild(c);
    });
    return n;
  }

  function clear() { root.innerHTML = ''; }

  function showMessage(title, body, buttonLabel, onClick) {
    clear();
    var wrap = el('div', 'text-align:center; max-width:520px;', [
      el('h1', 'font-size:22px; margin:0 0 16px;', [title]),
      el('p', 'color:#9ca3af; line-height:1.6; margin:0 0 24px;', [body]),
    ]);
    if (buttonLabel) {
      var btn = el('button', 'padding:12px 24px; border:0; border-radius:8px; background:#2563eb; color:white; font-size:16px; cursor:pointer;', [buttonLabel]);
      btn.onclick = onClick;
      wrap.appendChild(btn);
    }
    root.appendChild(wrap);
  }

  function showNumberFor(n, ms) {
    return new Promise(function (resolve) {
      clear();
      root.appendChild(el('div', 'text-align:center;', [
        el('p', 'color:#9ca3af; font-size:14px; margin:0 0 16px;', ['이 숫자를 기억해 주세요']),
        el('div', 'font-size:84px; font-weight:700; letter-spacing:12px; color:#f9fafb;', [n]),
      ]));
      setTimeout(resolve, ms);
    });
  }

  function promptInput(blockIdx, trialIdx) {
    return new Promise(function (resolve) {
      clear();
      var t0 = performance.now();
      var input = el('input', 'font-size:48px; text-align:center; width:200px; padding:12px; border-radius:8px; border:2px solid #374151; background:#111827; color:#f9fafb; margin-bottom:16px;');
      input.type = 'text';
      input.inputMode = 'numeric';
      input.autocomplete = 'off';
      input.maxLength = 3;
      input.placeholder = '___';
      var err = el('p', 'color:#fca5a5; font-size:13px; min-height:18px; margin:0 0 12px;', ['']);
      var submitBtn = el('button', 'padding:12px 28px; border:0; border-radius:8px; background:#10b981; color:white; font-size:16px; cursor:pointer; min-width:140px;', ['확인']);
      submitBtn.onclick = function () {
        var val = input.value.trim();
        if (!/^\d{1,3}$/.test(val)) {
          err.textContent = '1~3자리 숫자를 입력해 주세요.';
          return;
        }
        var rt = performance.now() - t0;
        resolve({
          trial_index: trialIdx,
          response: val,
          rt_ms: Math.round(rt),
          timestamp: new Date().toISOString(),
        });
      };
      var wrap = el('div', 'text-align:center; max-width:480px;', [
        el('p', 'color:#9ca3af; font-size:13px; margin:0 0 16px;', [
          'Block ' + (blockIdx + 1) + ' / ' + BLOCKS +
          ' · Trial ' + (trialIdx + 1) + ' / ' + TRIALS_PER_BLOCK,
        ]),
        el('p', 'color:#e5e7eb; font-size:18px; margin:0 0 24px;', ['기억하신 숫자를 입력하세요']),
        input,
        err,
        submitBtn,
      ]);
      root.appendChild(wrap);
      input.focus();
    });
  }

  async function runTrial(blockIdx, trialIdx) {
    var stim = randomNumber();
    var shownAt = new Date().toISOString();
    await showNumberFor(stim, 1500);
    // brief blank to simulate the delay task
    clear();
    await new Promise(function (r) { setTimeout(r, 400); });
    var resp = await promptInput(blockIdx, trialIdx);
    return {
      trial_index: trialIdx,
      stim: stim,
      response: resp.response,
      correct: resp.response === stim,
      rt_ms: resp.rt_ms,
      shown_at: shownAt,
      responded_at: resp.timestamp,
    };
  }

  function blockIntro(blockIdx) {
    return new Promise(function (resolve) {
      showMessage(
        'Block ' + (blockIdx + 1) + ' / ' + BLOCKS,
        '숫자가 1.5초 동안 나타났다가 사라집니다. 사라진 뒤 입력창에 보셨던 숫자를 입력하고 "확인"을 눌러주세요. 총 ' + TRIALS_PER_BLOCK + '개의 시행이 있습니다.',
        '시작',
        function () { resolve(); },
      );
    });
  }

  async function runBlock(blockIdx) {
    await blockIntro(blockIdx);
    var trials = [];
    for (var i = 0; i < TRIALS_PER_BLOCK; i++) {
      var tr = await runTrial(blockIdx, i);
      trials.push(tr);
    }

    clear();
    root.appendChild(el('div', 'text-align:center;', [
      el('p', 'color:#9ca3af;', ['블록 결과를 업로드 중입니다…']),
    ]));

    var correct = trials.filter(function (t) { return t.correct; }).length;
    var accuracy = correct / trials.length;

    try {
      await EP.submitBlock({
        blockIndex: blockIdx,
        trials: trials,
        blockMetadata: {
          n_trials: trials.length,
          accuracy: accuracy,
          mean_rt_ms:
            Math.round(
              trials.reduce(function (a, t) { return a + t.rt_ms; }, 0) / trials.length,
            ),
        },
        isLast: blockIdx === BLOCKS - 1,
      });
    } catch (err) {
      // The shell surfaces the error in its outer UI; we still let the
      // participant see a fallback message in the iframe.
      showMessage(
        '업로드 실패',
        '블록 데이터를 전송하지 못했습니다. 위쪽 "새로고침" 버튼을 눌러 다시 시도해 주세요. (' + err.message + ')',
      );
      throw err;
    }
  }

  async function main() {
    await new Promise(function (resolve) {
      showMessage(
        '숫자 기억 과제',
        '3자리 숫자가 잠깐 나타났다 사라집니다. 같은 숫자를 입력하고 "확인"을 눌러 다음 시행으로 넘어가세요. 총 3개의 블록이 있으며 약 3분 소요됩니다. (참여자 번호: Sbj ' + EP.subject + ')',
        '시작하기',
        function () { resolve(); },
      );
    });

    // Resume-aware: if the server already has N blocks we skip past them.
    var resumeFrom = typeof EP.blocksSubmitted === 'number' ? EP.blocksSubmitted : 0;
    if (resumeFrom >= BLOCKS) {
      showMessage('완료', '모든 블록이 이미 제출되었습니다. 완료 코드가 표시됩니다.');
      return;
    }
    if (resumeFrom > 0) {
      await new Promise(function (resolve) {
        showMessage(
          '이어서 시작',
          resumeFrom + '개 블록까지 제출이 완료되어 있습니다. 남은 블록을 이어서 진행합니다.',
          '이어서 시작',
          function () { resolve(); },
        );
      });
    }
    for (var b = resumeFrom; b < BLOCKS; b++) {
      await runBlock(b);
    }
    showMessage('완료', '모든 블록이 제출되었습니다. 아래 완료 코드를 연구원에게 전달해 주세요.');
  }

  main().catch(function (err) {
    if (EP && EP.log) EP.log('Fatal: ' + (err && err.message));
  });
})();
