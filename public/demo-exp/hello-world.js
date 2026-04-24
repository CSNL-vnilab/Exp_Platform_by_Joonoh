// Minimal online-experiment stub. Exists so the guide in
// docs/online-experiment-designer-guide.md has a copy-paste starting
// point. Runs one block of three trivial trials and submits. No real
// task — the point is to show the bridge contract end-to-end in the
// smallest surface area possible.
//
// To try this, set the experiment's entry URL to:
//   https://lab-reservation-seven.vercel.app/demo-exp/hello-world.js
// (or the local equivalent on :3000).

(function () {
  var EP = window.expPlatform;
  if (!EP) {
    document.body.innerHTML =
      '<p style="padding:24px;color:#555">Load this via the experiment runtime (/run/[bookingId]).</p>';
    return;
  }

  // UI — bare minimum so the participant sees something while blocks submit.
  document.body.style.fontFamily = "system-ui, sans-serif";
  document.body.style.padding = "24px";
  var status = document.createElement("p");
  status.textContent = "안녕하세요, Sbj" + EP.subject + "님. 과제를 준비하는 중입니다…";
  document.body.appendChild(status);

  // Pretend to run three trials. Real experiments put stimuli + timers here.
  var trials = [
    { trial_index: 0, stim: "red",   response: "R", rt_ms: 320, correct: true },
    { trial_index: 1, stim: "green", response: "G", rt_ms: 295, correct: true },
    { trial_index: 2, stim: "blue",  response: "R", rt_ms: 410, correct: false },
  ];

  EP.submitBlock({
    blockIndex: 0,
    trials: trials,
    blockMetadata: { demo: "hello-world", condition: EP.condition },
    completedAt: new Date().toISOString(),
    isLast: true, // single-block demo — mint the completion code now.
  }).then(function (res) {
    status.textContent =
      "참여가 완료되었습니다. 완료 코드: " + (res && res.completion_code ? res.completion_code : "(없음)");
  }).catch(function (err) {
    status.textContent = "제출 실패: " + (err && err.message ? err.message : String(err));
  });
})();
