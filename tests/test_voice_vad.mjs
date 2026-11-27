import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const VoiceVad = require("../app/static/voice-vad.js");

function makeSineFrame(sampleRate, durationMs, freqHz, amplitude) {
  const len = Math.round((sampleRate * durationMs) / 1000);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  }
  return out;
}

function makeSilenceFrame(sampleRate, durationMs, noiseAmp = 0.001) {
  const len = Math.round((sampleRate * durationMs) / 1000);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = (i % 2 === 0 ? 1 : -1) * noiseAmp;
  }
  return out;
}

test("rejects brief noise burst without emitting utterance end", () => {
  const events = [];
  const detector = VoiceVad.createTurnDetector({
    sensitivity: "balanced",
    config: { silenceMs: 400, minSpeechMs: 420, onsetHoldMs: 120 },
    onUtteranceStart: (e) => events.push(["start", e.utteranceId]),
    onUtteranceEnd: (e) => events.push(["end", e.utteranceId]),
    onUtteranceRejected: (e) => events.push(["rejected", e.reason, e.activeSpeechMs]),
  });

  let now = 1000;
  const sr = 48000;
  // Brief 160ms noise burst (triggers onset 120ms, but well below minSpeechMs 420ms)
  for (let i = 0; i < 8; i++) {
    detector.pushAudioFrame(makeSineFrame(sr, 20, 440, 0.14), sr, now);
    now += 20;
  }
  // Followed by 600ms of silence
  for (let i = 0; i < 30; i++) {
    detector.pushAudioFrame(makeSilenceFrame(sr, 20), sr, now);
    now += 20;
  }

  assert.equal(events.some(([k]) => k === "end"), false);
  assert.equal(events.some(([k, r]) => k === "rejected" && r === "too_short"), true);
  assert.equal(detector.getState(), "listening");

  assert.equal(VoiceVad.isNoiseFragment("...", 600, 420), true);
  assert.equal(VoiceVad.isNoiseFragment("Hi", 200, 420), true);
  assert.equal(VoiceVad.isNoiseFragment("Hello there", 600, 420), false);
});

test("captures full utterance with pre-roll and mid-sentence pause, emitting exactly one end", () => {
  const starts = [];
  const chunks = [];
  const ends = [];
  const detector = VoiceVad.createTurnDetector({
    sensitivity: "balanced",
    config: { silenceMs: 900, minSpeechMs: 400, onsetHoldMs: 140, preRollMs: 300 },
    onUtteranceStart: (e) => starts.push(e),
    onUtteranceChunk: (e) => chunks.push(e),
    onUtteranceEnd: (e) => ends.push(e),
  });

  let now = 2000;
  const sr = 48000;
  // 200ms pre-speech onset audio
  for (let i = 0; i < 10; i++) {
    detector.pushAudioFrame(makeSineFrame(sr, 20, 350, 0.12), sr, now);
    now += 20;
  }
  // 500ms first clause
  for (let i = 0; i < 25; i++) {
    detector.pushAudioFrame(makeSineFrame(sr, 20, 380, 0.12), sr, now);
    now += 20;
  }
  // 350ms natural pause (< silenceMs 900ms)
  for (let i = 0; i < 18; i++) {
    detector.pushAudioFrame(makeSilenceFrame(sr, 20), sr, now);
    now += 20;
  }
  // 500ms second clause
  for (let i = 0; i < 25; i++) {
    detector.pushAudioFrame(makeSineFrame(sr, 20, 420, 0.12), sr, now);
    now += 20;
  }
  // 1100ms silence to end utterance
  for (let i = 0; i < 55; i++) {
    detector.pushAudioFrame(makeSilenceFrame(sr, 20), sr, now);
    now += 20;
  }

  assert.equal(starts.length, 1);
  assert.ok(starts[0].initialPcm.length > 0, "pre-roll ring buffer must preserve initial audio");
  assert.equal(ends.length, 1, "must submit exactly one complete utterance");
  assert.equal(ends[0].utteranceId, starts[0].utteranceId);
  assert.ok(chunks.length > 40);
});

test("explicit language switching only triggers on explicit commands", () => {
  assert.equal(VoiceVad.detectLanguageSwitchCommand("Hola amigo"), null);
  assert.equal(VoiceVad.detectLanguageSwitchCommand("I am learning Hindi"), null);
  assert.equal(VoiceVad.detectLanguageSwitchCommand("Please switch to Hindi"), "hi");
  assert.equal(VoiceVad.detectLanguageSwitchCommand("Speak in Telugu"), "te");
  assert.equal(VoiceVad.detectLanguageSwitchCommand("Change language to Hinglish"), "mixed");
  assert.equal(VoiceVad.detectLanguageSwitchCommand("Talk in English"), "en");
});

test("ignores TTS speaker echo and interrupts immediately on genuine user barge-in", () => {
  const events = [];
  const detector = VoiceVad.createTurnDetector({
    sensitivity: "balanced",
    config: { silenceMs: 500, minSpeechMs: 360, bargeInHoldMs: 240, preRollMs: 300 },
    onBargeIn: (e) => events.push(["bargeIn", e.utteranceId]),
    onUtteranceStart: (e) => events.push(["start", e.bargeIn, e.initialPcm.length]),
    onUtteranceEnd: (e) => events.push(["end", e.utteranceId]),
  });

  let now = 5000;
  const sr = 48000;
  detector.setState("speaking", now);

  // 800ms of moderate speaker echo should NOT trigger barge-in
  for (let i = 0; i < 40; i++) {
    detector.pushAudioFrame(makeSineFrame(sr, 20, 300, 0.03), sr, now);
    now += 20;
  }
  assert.equal(events.some(([k]) => k === "bargeIn"), false);
  assert.equal(detector.getState(), "speaking");

  // Sustained louder user speech (0.18 rms) should trigger barge-in and capture full utterance
  for (let i = 0; i < 30; i++) {
    detector.pushAudioFrame(makeSineFrame(sr, 20, 420, 0.18), sr, now);
    now += 20;
  }
  // Silence to complete the interrupting utterance
  for (let i = 0; i < 30; i++) {
    detector.pushAudioFrame(makeSilenceFrame(sr, 20), sr, now);
    now += 20;
  }

  assert.equal(events[0][0], "bargeIn");
  const startEv = events.find(([k]) => k === "start");
  assert.ok(startEv && startEv[1] === true && startEv[2] > 0);
  assert.equal(events.filter(([k]) => k === "end").length, 1);
});

test("negotiateMicConstraints handles unsupported constraints and OverconstrainedError gracefully", async () => {
  const fakeTrack = { getSettings: () => ({ echoCancellation: true, autoGainControl: true }) };
  const fakeStream = { getAudioTracks: () => [fakeTrack] };
  const seenConstraints = [];

  const mediaDevices = {
    getSupportedConstraints: () => ({
      echoCancellation: true,
      noiseSuppression: false,
      autoGainControl: true,
    }),
    getUserMedia: async ({ audio }) => {
      seenConstraints.push(audio);
      if (audio && audio.deviceId) {
        const err = new Error("Overconstrained");
        err.name = "OverconstrainedError";
        throw err;
      }
      return fakeStream;
    },
  };

  const res = await VoiceVad.negotiateMicConstraints(mediaDevices, "missing-device-id");
  assert.equal(res.stream, fakeStream);
  assert.equal(res.supported.noiseSuppression, false);
  assert.equal(seenConstraints.length, 2);
  assert.equal(seenConstraints[0].noiseSuppression, undefined);
  assert.equal(seenConstraints[1].deviceId, undefined);
});

test("createResampler preserves exact sample count across 128-sample 48kHz quanta without dropping samples", () => {
  const resampler = VoiceVad.createResampler(48000, 16000);
  let totalIn = 0;
  let totalOut = 0;
  // 300 quanta of 128 samples = 38400 samples = 800ms at 48kHz -> exactly 12800 samples at 16kHz
  for (let q = 0; q < 300; q++) {
    const frame = makeSineFrame(48000, (128 / 48000) * 1000, 440, 0.2);
    totalIn += frame.length;
    totalOut += resampler.push(frame).length;
  }
  assert.equal(totalIn, 38400);
  assert.equal(totalOut, 12800);
});

