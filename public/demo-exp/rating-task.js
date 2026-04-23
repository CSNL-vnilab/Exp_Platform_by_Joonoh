// Rating-task demo (phase 2 feature showcase).
//   * 3 blocks × 5 trials; Likert 1-5 by click only (no keyboard)
//   * Consumes window.expPlatform.condition to vary stimulus order:
//       condition "A" → nouns first, adjectives last
//       condition "B" → adjectives first, nouns last
//   * Embeds a built-in attention-probe trial (explicit "select 3"
//     instruction) that auto-flags via expPlatform.reportAttentionFailure
//     when the participant gets it wrong.
//   * Surfaces condition + subject number + pilot flag on the intro so
//     the researcher can confirm the session is wired correctly during
//     preview.
//
// Paired with the platform's attention-check overlay (configured per
// block in online_runtime_config.attention_checks), this demonstrates
// the full phase-2 data integrity stack.

(function () {
  var EP = window.expPlatform;
  if (!EP) {
    document.body.innerHTML =
      '<p style="padding:24px;color:#555">Load this via the platform /run shell.</p>';
    return;
  }

  var root = document.getElementById("exp-root") || document.body;
  root.style.cssText =
    'font-family: -apple-system, "Segoe UI", sans-serif; color: #e5e7eb; padding: 32px; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; box-sizing: border-box;';

  var BLOCKS = 3;
  var TRIALS_PER_BLOCK = 5;
  var condition = EP.condition || "A";
  var NOUNS = ["사과", "자동차", "하늘", "책상", "고양이", "바다", "시계", "편지"];
  var ADJECTIVES = ["맑은", "따뜻한", "예리한", "부드러운", "묵직한", "조용한", "선명한", "느슨한"];

  // Condition-dependent block-by-block stimulus pool
  function poolFor(blockIdx) {
    var first = condition === "B" ? ADJECTIVES : NOUNS;
    var second = condition === "B" ? NOUNS : ADJECTIVES;
    // Last block always uses the opposite pool for counterbalance symmetry.
    if (blockIdx === BLOCKS - 1) return second;
    return first;
  }

  function el(tag, style, children) {
    var n = document.createElement(tag);
    if (style) n.style.cssText = style;
    (children || []).forEach(function (c) {
      if (c == null) return;
      if (typeof c === "string") n.appendChild(document.createTextNode(c));
      else n.appendChild(c);
    });
    return n;
  }

  function clear() {
    root.innerHTML = "";
  }

  function intro(msg, buttonLabel) {
    return new Promise(function (resolve) {
      clear();
      var card = el("div", "text-align:center; max-width:520px; line-height:1.6;", [
        el("h2", "font-size:20px; margin:0 0 16px;", ["실험 안내"]),
        el("p", "color:#9ca3af; margin:0 0 24px;", [msg]),
        el(
          "button",
          "padding:12px 28px; border:0; border-radius:8px; background:#2563eb; color:white; font-size:16px; cursor:pointer;",
          [buttonLabel],
        ),
      ]);
      card.lastChild.onclick = resolve;
      root.appendChild(card);
    });
  }

  function presentTrial(blockIdx, trialIdx, prompt, isAttentionProbe) {
    return new Promise(function (resolve) {
      clear();
      var t0 = performance.now();
      var headline = el(
        "p",
        "color:#9ca3af; font-size:12px; margin:0 0 12px;",
        ["Block " + (blockIdx + 1) + " / " + BLOCKS + " · Trial " + (trialIdx + 1) + " / " + TRIALS_PER_BLOCK],
      );
      var stim = el(
        "div",
        "font-size:56px; font-weight:700; margin:40px 0 16px; color:#f9fafb;",
        [prompt],
      );
      var hint = el(
        "p",
        "margin:0 0 28px; font-size:14px; color:#9ca3af;",
        [isAttentionProbe ? "이 문항은 주의 확인입니다." : "이 단어가 얼마나 긍정적으로 느껴지나요?"],
      );
      var scale = el(
        "div",
        "display:flex; gap:10px; justify-content:center;",
        [],
      );
      for (var i = 1; i <= 5; i++) {
        (function (val) {
          var btn = el(
            "button",
            "width:56px; height:56px; border:2px solid #374151; background:#111827; color:#f9fafb; border-radius:50%; font-size:18px; font-weight:600; cursor:pointer;",
            [String(val)],
          );
          btn.onclick = function () {
            var rt = Math.round(performance.now() - t0);
            resolve({
              trial_index: trialIdx,
              stim: prompt,
              response: val,
              is_attention_probe: isAttentionProbe,
              correct_if_probe: isAttentionProbe ? val === 3 : null,
              rt_ms: rt,
              timestamp: new Date().toISOString(),
            });
          };
          scale.appendChild(btn);
        })(i);
      }
      var wrap = el("div", "text-align:center; max-width:520px;", [
        headline,
        stim,
        hint,
        scale,
      ]);
      root.appendChild(wrap);
    });
  }

  async function runBlock(blockIdx) {
    await intro(
      "Block " + (blockIdx + 1) + " — 단어를 읽고 1(부정적) ~ 5(긍정적) 중 하나를 눌러주세요.",
      "시작",
    );
    var pool = poolFor(blockIdx);
    var trials = [];
    for (var i = 0; i < TRIALS_PER_BLOCK; i++) {
      var isProbe = blockIdx === 1 && i === 2;
      var prompt = isProbe
        ? "이 문항에서 주의 확인을 위해 3을 선택해주세요"
        : pool[i % pool.length];
      var tr = await presentTrial(blockIdx, i, prompt, isProbe);
      trials.push(tr);
      if (isProbe && tr.correct_if_probe === false) {
        try {
          await EP.reportAttentionFailure();
        } catch (e) {}
      }
      await new Promise(function (r) {
        setTimeout(r, 300);
      });
    }

    clear();
    root.appendChild(
      el("div", "text-align:center;", [
        el("p", "color:#9ca3af;", ["블록 결과 전송 중…"]),
      ]),
    );

    try {
      await EP.submitBlock({
        blockIndex: blockIdx,
        trials: trials,
        blockMetadata: {
          condition: condition,
          stimulus_pool: blockIdx === BLOCKS - 1
            ? (condition === "B" ? "nouns" : "adjectives")
            : (condition === "B" ? "adjectives" : "nouns"),
          mean_rating:
            trials.reduce(function (a, t) {
              return a + t.response;
            }, 0) / trials.length,
        },
        isLast: blockIdx === BLOCKS - 1,
      });
    } catch (err) {
      clear();
      root.appendChild(
        el("div", "text-align:center; color:#fca5a5; max-width:480px;", [
          el("p", null, ["업로드 실패: " + err.message]),
          el("p", "margin-top:8px; font-size:12px;", ["위쪽 새로고침 버튼을 눌러 다시 시도해주세요."]),
        ]),
      );
      throw err;
    }
  }

  async function main() {
    await intro(
      "참여자 Sbj " + EP.subject + " · 조건 " + condition +
        (EP.isPilot ? " · 파일럿 모드" : "") +
        " — 각 블록에서 단어를 보고 긍정성(1~5)을 평가해 주세요. 약 2분 소요됩니다.",
      "시작하기",
    );
    var resumeFrom = typeof EP.blocksSubmitted === "number" ? EP.blocksSubmitted : 0;
    if (resumeFrom > 0) {
      await intro(
        resumeFrom + "개 블록이 이미 제출되어 있습니다. 다음 블록부터 이어서 진행합니다.",
        "이어서 시작",
      );
    }
    for (var b = resumeFrom; b < BLOCKS; b++) {
      await runBlock(b);
    }
    clear();
    root.appendChild(
      el("div", "text-align:center;", [
        el("h2", "font-size:20px;", ["완료"]),
        el("p", "margin-top:12px; color:#9ca3af;", ["모든 블록이 제출되었습니다. 완료 코드를 연구원에게 전달해주세요."]),
      ]),
    );
  }

  main().catch(function (err) {
    if (EP && EP.log) EP.log("Fatal: " + (err && err.message));
  });
})();
