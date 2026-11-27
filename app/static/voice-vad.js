(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.VoiceVad = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const TARGET_SAMPLE_RATE = 16000;

  const VAD_PRESETS = {
    quiet: {
      minSpeechMs: 360,
      onsetHoldMs: 140,
      silenceMs: 1200,
      hangoverMs: 200,
      rmsFloor: 0.012,
      noiseMult: 2.5,
      bandMin: 14,
      bargeInRmsFloor: 0.036,
      bargeInNoiseMult: 4.2,
      bargeInHoldMs: 260,
      postTtsCooldownMs: 260,
      preRollMs: 450,
      maxUtteranceMs: 25000,
    },
    balanced: {
      minSpeechMs: 420,
      onsetHoldMs: 180,
      silenceMs: 1400,
      hangoverMs: 220,
      rmsFloor: 0.020,
      noiseMult: 3.1,
      bandMin: 20,
      bargeInRmsFloor: 0.048,
      bargeInNoiseMult: 4.8,
      bargeInHoldMs: 280,
      postTtsCooldownMs: 280,
      preRollMs: 450,
      maxUtteranceMs: 25000,
    },
    noisy: {
      minSpeechMs: 550,
      onsetHoldMs: 240,
      silenceMs: 1500,
      hangoverMs: 220,
      rmsFloor: 0.034,
      noiseMult: 3.8,
      bandMin: 26,
      bargeInRmsFloor: 0.068,
      bargeInNoiseMult: 5.5,
      bargeInHoldMs: 320,
      postTtsCooldownMs: 320,
      preRollMs: 450,
      maxUtteranceMs: 25000,
    },
  };

  function getVadConfig(sensitivity = "balanced", overrides = {}) {
    const base = VAD_PRESETS[sensitivity] || VAD_PRESETS.balanced;
    return { ...base, ...overrides };
  }

  function computeFrameFeatures(samples) {
    const len = samples ? samples.length : 0;
    if (!len) return { rms: 0, zcr: 0 };
    let sumSq = 0;
    let zeroCrossings = 0;
    let prev = samples[0];
    for (let i = 0; i < len; i++) {
      const s = samples[i];
      sumSq += s * s;
      if (i > 0 && ((s >= 0 && prev < 0) || (s < 0 && prev >= 0))) {
        zeroCrossings += 1;
      }
      prev = s;
    }
    return {
      rms: Math.sqrt(sumSq / len),
      zcr: len > 1 ? zeroCrossings / (len - 1) : 0,
    };
  }

  function downsampleFloat32ToInt16(float32Samples, inputSampleRate, targetSampleRate = TARGET_SAMPLE_RATE) {
    if (!float32Samples || !float32Samples.length) return new Int16Array(0);
    const inRate = inputSampleRate || targetSampleRate;
    if (inRate === targetSampleRate) {
      const out = new Int16Array(float32Samples.length);
      for (let i = 0; i < float32Samples.length; i++) {
        const clamped = Math.max(-1, Math.min(1, float32Samples[i]));
        out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      }
      return out;
    }
    const ratio = inRate / targetSampleRate;
    const outLen = Math.max(1, Math.floor(float32Samples.length / ratio));
    const out = new Int16Array(outLen);
    let offsetResult = 0;
    let offsetBuffer = 0;
    while (offsetResult < outLen) {
      const nextOffsetBuffer = Math.min(
        float32Samples.length,
        Math.round((offsetResult + 1) * ratio)
      );
      let accum = 0;
      let count = 0;
      for (let i = offsetBuffer; i < nextOffsetBuffer; i++) {
        accum += float32Samples[i];
        count += 1;
      }
      const sample = count > 0 ? accum / count : float32Samples[Math.min(offsetBuffer, float32Samples.length - 1)];
      const clamped = Math.max(-1, Math.min(1, sample));
      out[offsetResult] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      offsetResult += 1;
      offsetBuffer = nextOffsetBuffer;
    }
    return out;
  }

  function createResampler(inputSampleRate, targetSampleRate = TARGET_SAMPLE_RATE) {
    const inRate = inputSampleRate || targetSampleRate;
    const ratio = inRate / targetSampleRate;
    let pending = new Float32Array(0);

    return {
      push(float32Samples) {
        if (!float32Samples || !float32Samples.length) return new Int16Array(0);
        if (inRate === targetSampleRate) {
          return downsampleFloat32ToInt16(float32Samples, inRate, targetSampleRate);
        }
        const combined = new Float32Array(pending.length + float32Samples.length);
        combined.set(pending, 0);
        combined.set(float32Samples, pending.length);

        const outLen = Math.floor(combined.length / ratio);
        if (outLen === 0) {
          pending = combined;
          return new Int16Array(0);
        }
        const consumedInput = Math.round(outLen * ratio);
        const out = new Int16Array(outLen);
        for (let i = 0; i < outLen; i++) {
          const start = Math.round(i * ratio);
          const end = Math.min(combined.length, Math.round((i + 1) * ratio));
          let accum = 0;
          let count = 0;
          for (let j = start; j < end; j++) {
            accum += combined[j];
            count += 1;
          }
          const sample = count > 0 ? accum / count : combined[Math.min(start, combined.length - 1)];
          const clamped = Math.max(-1, Math.min(1, sample));
          out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
        }
        pending = combined.slice(consumedInput);
        return out;
      },
      reset() {
        pending = new Float32Array(0);
      },
    };
  }

  function detectLanguageSwitchCommand(text) {
    const clean = String(text || "").trim();
    if (!clean) return null;
    const match = clean.match(
      /\b(?:(?:change|switch|set)(?:\s+(?:the\s+)?language)?|speak|talk|respond|reply|answer|use)\s+(?:to|in)?\s*(english|hindi|telugu|hinglish)\b/i
    );
    if (!match) return null;
    const map = { english: "en", hindi: "hi", telugu: "te", hinglish: "mixed" };
    return map[match[1].toLowerCase()] || null;
  }

  function isNoiseFragment(text, activeSpeechMs = 0, minSpeechMs = 0) {
    const clean = String(text || "").trim();
    if (!clean) return true;
    const hasLetterOrDigit = /[\p{L}\p{N}]/u.test(clean);
    if (!hasLetterOrDigit) return true;
    if (minSpeechMs > 0 && activeSpeechMs > 0 && activeSpeechMs < minSpeechMs) {
      return true;
    }
    return false;
  }

  class PcmRingBuffer {
    constructor(maxSamples) {
      this.maxSamples = Math.max(1, maxSamples);
      this.buf = new Int16Array(this.maxSamples);
      this.writePos = 0;
      this.filled = 0;
    }

    push(int16Chunk) {
      if (!int16Chunk || !int16Chunk.length) return;
      if (int16Chunk.length >= this.maxSamples) {
        this.buf.set(int16Chunk.subarray(int16Chunk.length - this.maxSamples), 0);
        this.writePos = 0;
        this.filled = this.maxSamples;
        return;
      }
      const firstPart = Math.min(int16Chunk.length, this.maxSamples - this.writePos);
      this.buf.set(int16Chunk.subarray(0, firstPart), this.writePos);
      const remaining = int16Chunk.length - firstPart;
      if (remaining > 0) {
        this.buf.set(int16Chunk.subarray(firstPart), 0);
      }
      this.writePos = (this.writePos + int16Chunk.length) % this.maxSamples;
      this.filled = Math.min(this.maxSamples, this.filled + int16Chunk.length);
    }

    drain() {
      if (this.filled === 0) return new Int16Array(0);
      const out = new Int16Array(this.filled);
      if (this.filled < this.maxSamples) {
        out.set(this.buf.subarray(0, this.filled), 0);
      } else {
        const tailLen = this.maxSamples - this.writePos;
        out.set(this.buf.subarray(this.writePos), 0);
        if (this.writePos > 0) {
          out.set(this.buf.subarray(0, this.writePos), tailLen);
        }
      }
      this.writePos = 0;
      this.filled = 0;
      return out;
    }

    clear() {
      this.writePos = 0;
      this.filled = 0;
    }
  }

  function createTurnDetector(options = {}) {
    let config = getVadConfig(options.sensitivity || "balanced", options.config || {});
    let stateName = options.initialState || "listening";
    let noiseFloor = options.initialNoiseFloor || 0.006;
    let ttsEchoFloor = 0.01;
    let speakingStartedAt = 0;
    let cooldownUntil = 0;
    let onsetSpeechMs = 0;
    let bargeInSpeechMs = 0;
    let speechStartedAt = 0;
    let lastSpeechAt = 0;
    let lastFrameAt = 0;
    let activeSpeechMs = 0;
    let hangoverRemainingMs = 0;
    let utteranceSeq = 0;
    let currentUtteranceId = 0;
    let resampler = null;
    let resamplerRate = 0;

    const ringSamples = Math.round((TARGET_SAMPLE_RATE * config.preRollMs) / 1000);
    const ring = new PcmRingBuffer(ringSamples);

    const callbacks = {
      onUtteranceStart: options.onUtteranceStart || (() => {}),
      onUtteranceChunk: options.onUtteranceChunk || (() => {}),
      onUtteranceEnd: options.onUtteranceEnd || (() => {}),
      onUtteranceRejected: options.onUtteranceRejected || (() => {}),
      onBargeIn: options.onBargeIn || (() => {}),
      onLevel: options.onLevel || (() => {}),
    };

    function resetSpeechCounters() {
      onsetSpeechMs = 0;
      bargeInSpeechMs = 0;
      speechStartedAt = 0;
      lastSpeechAt = 0;
      activeSpeechMs = 0;
      hangoverRemainingMs = 0;
    }

    function setState(nextState, nowMs = Date.now()) {
      const prev = stateName;
      stateName = nextState;
      if (nextState === "speaking") {
        speakingStartedAt = nowMs;
        ttsEchoFloor = Math.max(noiseFloor * 2.0, 0.012);
        bargeInSpeechMs = 0;
        onsetSpeechMs = 0;
      } else if (prev === "speaking" && nextState === "listening") {
        cooldownUntil = nowMs + config.postTtsCooldownMs;
        resetSpeechCounters();
      } else if (nextState === "listening" || nextState === "paused" || nextState === "muted" || nextState === "off") {
        resetSpeechCounters();
        if (nextState === "paused" || nextState === "muted" || nextState === "off") {
          ring.clear();
        }
      }
    }

    function setConfig(sensitivity, overrides = {}) {
      config = getVadConfig(sensitivity || "balanced", overrides);
    }

    function startCapturing(nowMs, initialPcm, bargeIn = false) {
      utteranceSeq += 1;
      currentUtteranceId = utteranceSeq;
      stateName = "capturing";
      speechStartedAt = nowMs;
      lastSpeechAt = nowMs;
      activeSpeechMs = bargeIn ? config.bargeInHoldMs : config.onsetHoldMs;
      hangoverRemainingMs = config.hangoverMs;
      onsetSpeechMs = 0;
      bargeInSpeechMs = 0;
      callbacks.onUtteranceStart({
        utteranceId: currentUtteranceId,
        initialPcm,
        bargeIn,
      });
    }

    function pushAudioFrame(float32Samples, sampleRate, nowMs = Date.now(), extra = {}) {
      if (stateName === "off" || stateName === "paused" || stateName === "muted") {
        lastFrameAt = nowMs;
        return;
      }

      const frameDurationMs = float32Samples && sampleRate
        ? (float32Samples.length / sampleRate) * 1000
        : 20;
      const dt = lastFrameAt > 0
        ? Math.min(120, Math.max(4, nowMs - lastFrameAt))
        : Math.min(120, Math.max(4, frameDurationMs));
      lastFrameAt = nowMs;

      const { rms, zcr } = computeFrameFeatures(float32Samples);
      const speechBandAvg = extra.speechBandAvg;
      const bandOk = speechBandAvg === undefined || speechBandAvg > config.bandMin;
      const zcrOk = zcr >= 0.008 && zcr <= 0.48;

      const adaptiveThresh = Math.max(config.rmsFloor, noiseFloor * config.noiseMult);
      const silenceThresh = Math.max(config.rmsFloor * 0.72, noiseFloor * 2.1);
      const isSpeechLike = rms > adaptiveThresh && bandOk && zcrOk;

      callbacks.onLevel({ rms, isSpeechLike, state: stateName, noiseFloor });

      const pcm = (resampler && resamplerRate === sampleRate)
        ? resampler.push(float32Samples)
        : (() => {
            resamplerRate = sampleRate || TARGET_SAMPLE_RATE;
            resampler = createResampler(resamplerRate, TARGET_SAMPLE_RATE);
            return resampler.push(float32Samples);
          })();

      if (stateName === "listening" || stateName === "speaking") {
        ring.push(pcm);
      }

      if (stateName === "speaking") {
        const speakingElapsed = nowMs - speakingStartedAt;
        if (speakingElapsed <= 500) {
          ttsEchoFloor = ttsEchoFloor * 0.85 + Math.min(rms, 0.25) * 0.15;
          return;
        }
        const bargeInThresh = Math.max(
          config.bargeInRmsFloor,
          noiseFloor * config.bargeInNoiseMult,
          ttsEchoFloor * 2.0
        );
        if (rms > bargeInThresh && bandOk && zcrOk) {
          bargeInSpeechMs += dt;
          if (bargeInSpeechMs >= config.bargeInHoldMs) {
            const preRoll = ring.drain();
            callbacks.onBargeIn({ utteranceId: utteranceSeq + 1, rms });
            startCapturing(nowMs, preRoll, true);
          }
        } else {
          bargeInSpeechMs = Math.max(0, bargeInSpeechMs - dt * 0.6);
          ttsEchoFloor = ttsEchoFloor * 0.96 + Math.min(rms, 0.2) * 0.04;
        }
        return;
      }

      if (stateName === "listening") {
        if (nowMs < cooldownUntil) {
          onsetSpeechMs = 0;
          return;
        }
        if (isSpeechLike) {
          onsetSpeechMs += dt;
          if (onsetSpeechMs >= config.onsetHoldMs) {
            const preRoll = ring.drain();
            startCapturing(nowMs, preRoll, false);
          }
        } else {
          onsetSpeechMs = Math.max(0, onsetSpeechMs - dt * 0.75);
          noiseFloor = noiseFloor * 0.97 + Math.min(rms, 0.025) * 0.03;
        }
        return;
      }

      if (stateName === "capturing") {
        if (pcm.length > 0) {
          callbacks.onUtteranceChunk({ utteranceId: currentUtteranceId, pcm });
        }

        const utteranceAge = nowMs - speechStartedAt;
        const softBandOk = speechBandAvg === undefined || speechBandAvg > config.bandMin * 0.7;
        const isActiveFrame = rms > silenceThresh && softBandOk;

        if (isActiveFrame) {
          lastSpeechAt = nowMs;
          activeSpeechMs += dt;
          hangoverRemainingMs = config.hangoverMs;
        } else if (hangoverRemainingMs > 0) {
          hangoverRemainingMs = Math.max(0, hangoverRemainingMs - dt);
          activeSpeechMs += dt * 0.5;
        }

        const silenceElapsed = nowMs - lastSpeechAt;
        if (utteranceAge >= config.maxUtteranceMs || silenceElapsed >= config.silenceMs) {
          const finishedId = currentUtteranceId;
          const totalSpeechMs = Math.round(activeSpeechMs);
          if (totalSpeechMs < config.minSpeechMs) {
            stateName = "listening";
            resetSpeechCounters();
            callbacks.onUtteranceRejected({
              utteranceId: finishedId,
              reason: "too_short",
              activeSpeechMs: totalSpeechMs,
            });
          } else {
            stateName = "finalizing";
            resetSpeechCounters();
            callbacks.onUtteranceEnd({
              utteranceId: finishedId,
              activeSpeechMs: totalSpeechMs,
              durationMs: Math.round(utteranceAge),
            });
          }
        }
      }
    }

    function forceEndUtterance(nowMs = Date.now()) {
      if (stateName !== "capturing") return;
      const finishedId = currentUtteranceId;
      const totalSpeechMs = Math.round(activeSpeechMs);
      const utteranceAge = Math.round(nowMs - speechStartedAt);
      stateName = "finalizing";
      resetSpeechCounters();
      callbacks.onUtteranceEnd({
        utteranceId: finishedId,
        activeSpeechMs: totalSpeechMs,
        durationMs: utteranceAge,
      });
    }

    return {
      setState,
      setConfig,
      pushAudioFrame,
      forceEndUtterance,
      getState: () => stateName,
      getNoiseFloor: () => noiseFloor,
      getConfig: () => ({ ...config }),
    };
  }

  async function negotiateMicConstraints(mediaDevices, preferredDeviceId = "") {
    if (!mediaDevices || typeof mediaDevices.getUserMedia !== "function") {
      throw new Error("Microphone capture is not supported in this browser.");
    }
    const supported = typeof mediaDevices.getSupportedConstraints === "function"
      ? mediaDevices.getSupportedConstraints() || {}
      : {};

    const baseAudio = {};
    if (supported.echoCancellation !== false) baseAudio.echoCancellation = true;
    if (supported.noiseSuppression !== false) baseAudio.noiseSuppression = true;
    if (supported.autoGainControl !== false) baseAudio.autoGainControl = true;

    const attempts = [];
    if (preferredDeviceId) {
      attempts.push({ ...baseAudio, deviceId: { exact: preferredDeviceId } });
    }
    attempts.push(Object.keys(baseAudio).length ? baseAudio : true);
    if (Object.keys(baseAudio).length) {
      attempts.push(true);
    }

    let lastErr = null;
    for (const audioConstraint of attempts) {
      try {
        const stream = await mediaDevices.getUserMedia({ audio: audioConstraint });
        const track = stream.getAudioTracks ? stream.getAudioTracks()[0] : null;
        const settings = track && typeof track.getSettings === "function" ? track.getSettings() : {};
        return {
          stream,
          supported: {
            echoCancellation: supported.echoCancellation !== false,
            noiseSuppression: supported.noiseSuppression !== false,
            autoGainControl: supported.autoGainControl !== false,
          },
          settings,
        };
      } catch (err) {
        lastErr = err;
        const name = err && err.name ? err.name : "";
        if (name === "NotAllowedError" || name === "PermissionDeniedError") {
          throw err;
        }
        if (name !== "OverconstrainedError" && name !== "ConstraintNotSatisfiedError" && name !== "NotFoundError") {
          throw err;
        }
      }
    }
    throw lastErr || new Error("Could not acquire microphone stream.");
  }

  return {
    TARGET_SAMPLE_RATE,
    VAD_PRESETS,
    getVadConfig,
    computeFrameFeatures,
    downsampleFloat32ToInt16,
    createResampler,
    detectLanguageSwitchCommand,
    isNoiseFragment,
    PcmRingBuffer,
    createTurnDetector,
    negotiateMicConstraints,
  };
});
