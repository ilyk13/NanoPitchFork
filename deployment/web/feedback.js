/**
 * Hardcoded heuristic feedback: live chips + Stage-2 summary assembly.
 */
(function (global) {
  'use strict';

  function uniqueCap(arr, max) {
    const out = [];
    const seen = new Set();
    for (let i = 0; i < arr.length && out.length < max; i++) {
      const s = arr[i];
      if (!s || seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
    return out;
  }

  function feedbackLiveChips(liveMetrics) {
    const chips = [];
    const v = liveMetrics.vibrato;
    if (liveMetrics.isTransition) {
      chips.push('Transition');
    }
    if (v.active) {
      if (liveMetrics.flags.vibUnstable) chips.push('Vibrato unstable');
      else chips.push(`Vibrato ~${v.rateHz.toFixed(1)} Hz`);
    } else if (liveMetrics.vad > 0.35 && liveMetrics.f0 > 0 && !liveMetrics.isTransition) {
      chips.push('Little vibrato');
    }
    if (liveMetrics.flags.breathRising) chips.push('Breathiness rising');
    if (liveMetrics.flags.loudWobble) chips.push('Dynamics uneven');
    return uniqueCap(chips, 5);
  }

  function feedbackPostProcess(post, snapshots) {
    const successes = [];
    const failures = [];

    if (post.noteCount >= 3) successes.push('Clear note changes detected across the take.');
    if (post.noteCount === 0 || post.noteCount === 1)
      failures.push('Few note boundaries detected — try longer phrases or clearer pitch steps.');

    if (post.vibratoSampleCount >= 10 && post.vibratoRateStd < 0.45 && post.vibratoRateMean > 4.2)
      successes.push('Vibrato rate stayed fairly steady when present.');
    if (post.vibratoSampleCount >= 6 && post.vibratoRateStd >= 0.65)
      failures.push('Vibrato rate jumped around — aim for steady oscillation.');

    if (post.avgNoteLoudnessStd < 2.2 && post.noteCount >= 2)
      successes.push('Dynamics were relatively consistent within notes.');
    if (post.avgNoteLoudnessStd > 3.5) failures.push('Dynamics wandered — practice steadier breath support.');

    if (Math.abs(post.tiltDrift) < 0.15 && snapshots > 200)
      successes.push('Breathiness profile stayed fairly stable.');
    if (post.tiltDrift > 0.22) failures.push('Breathiness crept brighter — watch air/noise creeping in.');
    if (post.breathinessVarSecond > post.breathinessVarFirst * 1.35 && snapshots > 200)
      failures.push('Breathiness control less even in the second half.');

    const summaryParts = [];
    if (post.durationSec >= 5) {
      summaryParts.push(`You sang for about ${post.durationSec.toFixed(1)} seconds across ${post.noteCount} detected notes.`);
    } else {
      summaryParts.push('Short take — longer phrases will unlock richer feedback.');
    }
    if (failures.length === 0 && successes.length >= 2) {
      summaryParts.push('Overall this sounded controlled for a demo pass.');
    } else if (failures.length > successes.length) {
      summaryParts.push('Focus next time on the highlighted improvement areas below.');
    } else {
      summaryParts.push('Mix of strengths and rough spots — see bullets for detail.');
    }

    return {
      summary: summaryParts.join(' '),
      successes: uniqueCap(successes, 5),
      failures: uniqueCap(failures, 5),
    };
  }

  global.NPFeedback = { feedbackLiveChips, feedbackPostProcess };
})(typeof window !== 'undefined' ? window : globalThis);
