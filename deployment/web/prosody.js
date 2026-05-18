/**
 * Session buffer + post-pass aggregates. All DSP runs in WASM (nanopitch.c).
 */
(function (global) {
  'use strict';

  const FRAME_HZ = 100;
  const VIZ = 320;

  function stdDev(arr) {
    if (!arr.length) return 0;
    const m = arr.reduce((a, b) => a + b, 0) / arr.length;
    let s = 0;
    for (let i = 0; i < arr.length; i++) {
      const d = arr[i] - m;
      s += d * d;
    }
    return Math.sqrt(s / arr.length);
  }

  function mean(arr) {
    if (!arr.length) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  /** High vs low mel-band mean (log-energy); difference reads ~dB of spectral tilt. */
  function melHighLowDiffDb(mel) {
    if (!mel || mel.length < 9) return 0;
    const n = mel.length;
    const third = Math.max(1, Math.floor(n / 3));
    let low = 0;
    let high = 0;
    for (let i = 0; i < third; i++) low += mel[i];
    for (let i = n - third; i < n; i++) high += mel[i];
    low /= third;
    high /= third;
    return high - low;
  }

  function createProsodyEngine() {
    return {
      frameIndex: 0,
      f0: [],
      vad: [],
      rmsDb: [],
      mel: [],
      noteId: [],
      isTransition: [],
      smoothDb: [],
      melTilt: [],
      vibDepthHistory: [],
      loudnessHistory: [],
      tiltHistory: [],
      breathDbHistory: [],
      vibratoRateSamples: [],
      lastVibrato: {
        active: false,
        rateHz: 0,
        depthCents: 0,
        stability: 0,
      },
    };
  }

  function prosodyReset(eng) {
    eng.frameIndex = 0;
    eng.f0.length = 0;
    eng.vad.length = 0;
    eng.rmsDb.length = 0;
    eng.mel.length = 0;
    eng.noteId.length = 0;
    eng.isTransition.length = 0;
    eng.smoothDb.length = 0;
    eng.melTilt.length = 0;
    eng.vibDepthHistory.length = 0;
    eng.loudnessHistory.length = 0;
    eng.tiltHistory.length = 0;
    eng.breathDbHistory.length = 0;
    eng.vibratoRateSamples.length = 0;
    eng.lastVibrato = {
      active: false,
      rateHz: 0,
      depthCents: 0,
      stability: 0,
    };
  }

  /**
   * @param {object|null} result from processAudioFrame() — includes WASM prosody fields
   */
  function prosodyAppendFrame(eng, result) {
    const fi = eng.frameIndex;
    let snap;

    if (!result) {
      eng.f0.push(0);
      eng.vad.push(0);
      eng.rmsDb.push(-100);
      eng.mel.push(new Float32Array(40));
      eng.noteId.push(0);
      eng.isTransition.push(false);
      eng.smoothDb.push(0);
      eng.melTilt.push(0);
      snap = {
        frameIndex: fi,
        noteId: 0,
        isTransition: false,
        vibrato: { active: false, rateHz: 0, depthCents: 0, stability: 0 },
        smoothDb: 0,
        tilt: 0,
        breathinessDb: 0,
        f0: 0,
        vad: 0,
        rmsDb: -100,
      };
    } else {
      const vib = {
        active: !!result.prosodyVibratoActive,
        rateHz: result.prosodyVibratoRateHz,
        depthCents: result.prosodyVibratoDepthCents,
        stability: result.prosodyVibratoStability,
      };
      eng.lastVibrato = vib;
      if (vib.active) {
        eng.vibratoRateSamples.push(vib.rateHz);
        while (eng.vibratoRateSamples.length > 4000) eng.vibratoRateSamples.shift();
      }

      eng.f0.push(result.f0);
      eng.vad.push(result.vad);
      eng.rmsDb.push(result.rmsDb);
      eng.mel.push(new Float32Array(result.mel));
      eng.noteId.push(result.prosodyNoteId | 0);
      eng.isTransition.push(!!result.prosodyIsTransition);
      eng.smoothDb.push(result.prosodySmoothRmsDb);
      eng.melTilt.push(result.prosodyMelTilt);
      const breathDb = melHighLowDiffDb(result.mel);

      snap = {
        frameIndex: fi,
        noteId: result.prosodyNoteId | 0,
        isTransition: !!result.prosodyIsTransition,
        vibrato: Object.assign({}, vib),
        smoothDb: result.prosodySmoothRmsDb,
        tilt: result.prosodyMelTilt,
        breathinessDb: breathDb,
        f0: result.f0,
        vad: result.vad,
        rmsDb: result.rmsDb,
      };
    }

    eng.frameIndex++;

    eng.vibDepthHistory.push(eng.lastVibrato.depthCents);
    while (eng.vibDepthHistory.length > VIZ) eng.vibDepthHistory.shift();
    eng.loudnessHistory.push(
      eng.smoothDb.length ? eng.smoothDb[eng.smoothDb.length - 1] : 0
    );
    while (eng.loudnessHistory.length > VIZ) eng.loudnessHistory.shift();
    eng.tiltHistory.push(eng.melTilt.length ? eng.melTilt[eng.melTilt.length - 1] : 0);
    while (eng.tiltHistory.length > VIZ) eng.tiltHistory.shift();
    eng.breathDbHistory.push(
      snap.breathinessDb != null ? snap.breathinessDb : 0
    );
    while (eng.breathDbHistory.length > VIZ) eng.breathDbHistory.shift();

    return snap;
  }

  function prosodyRunPostPass(eng) {
    const n = eng.f0.length;
    const byNote = new Map();
    for (let i = 0; i < n; i++) {
      const nid = eng.noteId[i] || 0;
      if (nid <= 0) continue;
      if (!byNote.has(nid)) {
        byNote.set(nid, { smoothDb: [], tilt: [], f0: [], voiced: 0 });
      }
      const b = byNote.get(nid);
      b.smoothDb.push(eng.smoothDb[i]);
      b.tilt.push(eng.melTilt[i]);
      if (eng.f0[i] > 0) {
        b.f0.push(eng.f0[i]);
        b.voiced++;
      }
    }

    const noteStats = [];
    byNote.forEach((v, nid) => {
      noteStats.push({
        noteId: nid,
        loudnessStdDb: stdDev(v.smoothDb),
        tiltMean: mean(v.tilt),
        tiltStd: stdDev(v.tilt),
        voicedFrames: v.voiced,
        meanF0: v.f0.length ? mean(v.f0) : 0,
      });
    });
    noteStats.sort((a, b) => a.noteId - b.noteId);

    const rates = eng.vibratoRateSamples.slice();
    const vibratoRateMean = mean(rates);
    const vibratoRateStd = stdDev(rates);

    const tilts = eng.melTilt.slice();
    const tiltDrift = (() => {
      if (tilts.length < 40) return 0;
      const half = Math.floor(tilts.length / 2);
      return mean(tilts.slice(half)) - mean(tilts.slice(0, half));
    })();

    const loudSeries = eng.smoothDb.slice();

    const phraseSplit = Math.floor(n / 2);
    const firstHalfTiltStd = stdDev(tilts.slice(0, phraseSplit));
    const secondHalfTiltStd = stdDev(tilts.slice(phraseSplit));

    return {
      totalFrames: n,
      durationSec: n / FRAME_HZ,
      noteStats,
      noteCount: noteStats.length,
      vibratoRateMean,
      vibratoRateStd,
      vibratoSampleCount: rates.length,
      tiltDrift,
      loudDrift: (() => {
        if (loudSeries.length < 40) return 0;
        const half = Math.floor(loudSeries.length / 2);
        return mean(loudSeries.slice(half)) - mean(loudSeries.slice(0, half));
      })(),
      breathinessVarFirst: firstHalfTiltStd,
      breathinessVarSecond: secondHalfTiltStd,
      avgNoteLoudnessStd: noteStats.length
        ? mean(noteStats.map((s) => s.loudnessStdDb))
        : 0,
    };
  }

  function prosodyLiveMetricsFromSnapshot(snap, eng) {
    const vibUnstable =
      snap.vibrato.active &&
      eng.vibratoRateSamples.length >= 8 &&
      stdDev(eng.vibratoRateSamples.slice(-12)) > 0.55;

    const breathRising =
      eng.breathDbHistory.length >= 25 &&
      mean(eng.breathDbHistory.slice(-25)) - mean(eng.breathDbHistory.slice(-50, -25)) >
        0.45;

    const loudWobble =
      eng.loudnessHistory.length >= 30 &&
      stdDev(eng.loudnessHistory.slice(-30)) > 2.8;

    return {
      vibrato: snap.vibrato,
      smoothDb: snap.smoothDb,
      tilt: snap.tilt,
      breathinessDb: snap.breathinessDb != null ? snap.breathinessDb : melHighLowDiffDb(
        eng.mel.length ? eng.mel[eng.mel.length - 1] : null
      ),
      noteId: snap.noteId,
      isTransition: snap.isTransition,
      f0: snap.f0,
      vad: snap.vad,
      rmsDb: snap.rmsDb,
      flags: { vibUnstable, breathRising, loudWobble },
    };
  }

  global.NPProsody = {
    FRAME_HZ,
    createProsodyEngine,
    prosodyReset,
    prosodyAppendFrame,
    prosodyRunPostPass,
    prosodyLiveMetricsFromSnapshot,
    melHighLowDiffDb,
  };
})(typeof window !== 'undefined' ? window : globalThis);
