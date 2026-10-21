/** Command capture with local speech recognition only. Camera capture is separate. */
export const MIC = Object.freeze({
  IDLE: 'idle', STARTING: 'starting', LISTENING: 'listening',
  NO_PERMISSION: 'no-permission', ERROR: 'error'
});

const BANDS = [[85, 255], [255, 500], [500, 1000], [1000, 2000], [2000, 4000]];
const EMPTY_LEVELS = [0, 0, 0, 0, 0];
const STOP_TIMEOUT_MS = 1800;
const OPEN_TIMEOUT_MS = 8000;
const CAPTURE_TIMEOUT_MS = 30000;

/** Does not install a language pack or permit a network recognition fallback. */
export async function localSpeechAvailability(Recognition, language = 'en-US') {
  if (!Recognition || typeof Recognition.available !== 'function') return 'unsupported';
  const probe = new Recognition();
  if (!('processLocally' in probe)) return 'unsupported';
  return Recognition.available({ langs: [language], processLocally: true });
}

/**
 * The dependencies are injectable so cancellation and late browser callbacks can
 * be tested without a microphone or a browser. Interim results are display only.
 */
export function createVoice({
  onLevels, onTranscript, onStatus, onCommand, onComplete,
  Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition,
  mediaDevices = globalThis.navigator?.mediaDevices,
  permissions = globalThis.navigator?.permissions,
  AudioContextImpl = globalThis.AudioContext || globalThis.webkitAudioContext,
  timers = globalThis
} = {}) {
  let generation = 0;
  let active = false;
  let state = MIC.IDLE;
  let recognition = null;
  let stream = null;
  let audio = null;
  let source = null;
  let analyser = null;
  let frameTimer = null;
  let deadline = null;
  let stopTimer = null;
  let finals = '';
  let finalIndexes = new Set();
  let opening = null;

  const report = (next, detail = '') => {
    state = next;
    onStatus?.({ state, detail });
  };
  const current = (id) => active && id === generation;
  const release = (value) => value?.getTracks().forEach((track) => track.stop());

  function cleanup() {
    timers.clearInterval(frameTimer);
    timers.clearTimeout(deadline);
    timers.clearTimeout(stopTimer);
    frameTimer = deadline = stopTimer = null;
    if (recognition) {
      const previous = recognition;
      recognition = null;
      previous.onstart = previous.onresult = previous.onerror = previous.onend = null;
      try { previous.abort(); } catch { /* already stopped */ }
    }
    try { source?.disconnect(); } catch { /* already disconnected */ }
    source = analyser = null;
    release(stream);
    stream = null;
    const previousAudio = audio;
    audio = null;
    try { Promise.resolve(previousAudio?.close()).catch(() => {}); } catch { /* already closed */ }
    onLevels?.([...EMPTY_LEVELS]);
  }

  function end({ submit = false, error = null, detail = '' } = {}) {
    if (!active) return;
    const text = submit ? finals.replace(/\s+/g, ' ').trim().slice(0, 4000) : '';
    active = false;
    generation += 1;
    opening = null;
    cleanup();
    finals = '';
    finalIndexes.clear();
    report(error || MIC.IDLE, detail);
    if (text) onCommand?.({ text });
    onComplete?.({ submitted: !!text, state, detail });
  }

  function limited(promise, id, lateCleanup = () => {}) {
    let timer;
    const observed = Promise.resolve(promise).then((value) => {
      if (!current(id)) lateCleanup(value);
      return value;
    });
    const timeout = new Promise((_, reject) => {
      timer = timers.setTimeout(() => {
        const error = new Error('The microphone or local speech engine did not respond. Check Voice setup in Settings.');
        error.name = 'TimeoutError';
        reject(error);
      }, OPEN_TIMEOUT_MS);
    });
    return Promise.race([observed, timeout]).finally(() => timers.clearTimeout(timer));
  }

  function startLevels(id, opened) {
    if (!AudioContextImpl) return;
    audio = new AudioContextImpl();
    Promise.resolve(audio.resume?.()).catch(() => {});
    analyser = audio.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = .6;
    source = audio.createMediaStreamSource(opened);
    source.connect(analyser);
    const bins = new Uint8Array(analyser.frequencyBinCount);
    const previous = [...EMPTY_LEVELS];
    const hzPerBin = audio.sampleRate / 512;
    const ranges = BANDS.map(([low, high]) => [
      Math.max(1, Math.min(bins.length - 1, Math.round(low / hzPerBin))),
      Math.max(1, Math.min(bins.length - 1, Math.round(high / hzPerBin)))
    ]);
    frameTimer = timers.setInterval(() => {
      if (!current(id) || !analyser) return;
      analyser.getByteFrequencyData(bins);
      const levels = ranges.map(([from, to], i) => {
        let sum = 0;
        for (let n = from; n <= to; n++) sum += bins[n];
        const target = Math.max(0, Math.min(1, (sum / (to - from + 1) / 255 - .07) * 2.1));
        previous[i] += (target - previous[i]) * (target > previous[i] ? .55 : .16);
        return Math.round(previous[i] * 100) / 100;
      });
      onLevels?.(levels);
    }, 40);
  }

  async function open(id, language) {
    const availability = await limited(localSpeechAvailability(Recognition, language), id);
    if (!current(id)) return;
    if (availability !== 'available') {
      const detail = availability === 'unsupported'
        ? 'This browser does not support on-device speech recognition. Voice stays off.'
        : `On-device speech for ${language} is ${availability}. Open Settings to prepare the language pack.`;
      end({ error: MIC.ERROR, detail });
      return;
    }
    const permission = await limited(Promise.resolve().then(() => permissions?.query({ name: 'microphone' })).catch(() => null), id);
    if (!current(id)) return;
    if (permission?.state === 'prompt' || permission?.state === 'denied') {
      end({ error: MIC.NO_PERMISSION, detail: 'Allow microphone access in Jester Settings before starting a voice command.' });
      return;
    }
    const opened = await limited(mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false
    }), id, release);
    if (!current(id)) return;
    stream = opened;
    startLevels(id, opened);
    recognition = new Recognition();
    // Fail closed even when an implementation changes between the probe and start.
    if (!('processLocally' in recognition)) throw new Error('On-device speech recognition is unavailable.');
    recognition.processLocally = true;
    if (recognition.processLocally !== true) throw new Error('The browser refused on-device speech recognition.');
    recognition.lang = language;
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => { if (current(id)) report(MIC.LISTENING); };
    recognition.onresult = (event) => {
      if (!current(id)) return;
      let interim = '';
      let receivedFinal = false;
      for (let index = event.resultIndex || 0; index < event.results.length; index++) {
        const result = event.results[index];
        const text = String(result[0]?.transcript || '').trim().slice(0, 4000);
        if (!text) continue;
        if (result.isFinal) {
          if (finalIndexes.has(index)) continue;
          finalIndexes.add(index);
          finals = `${finals} ${text}`.trim().slice(0, 4000);
          receivedFinal = true;
          onTranscript?.({ text, final: true });
        } else interim += ` ${text}`;
      }
      if (interim.trim()) onTranscript?.({ text: interim.trim(), final: false });
      // A single-utterance recognizer finalizes after speech stops. One capture
      // emits at most one command; delayed events from this recognizer are stale.
      if (receivedFinal) end({ submit: true });
    };
    recognition.onerror = (event) => {
      if (!current(id)) return;
      if (event.error === 'no-speech' || event.error === 'aborted') {
        end({ detail: 'No command heard.' });
      } else {
        const denied = event.error === 'not-allowed' || event.error === 'service-not-allowed';
        end({ error: denied ? MIC.NO_PERMISSION : MIC.ERROR, detail: `Local speech recognition: ${event.error}. Check Voice setup in Settings.` });
      }
    };
    recognition.onend = () => { if (current(id)) end({ submit: true }); };
    recognition.start();
  }

  return {
    start({ language = 'en-US' } = {}) {
      if (active) return opening || Promise.resolve();
      active = true;
      const id = ++generation;
      finals = '';
      finalIndexes = new Set();
      report(MIC.STARTING);
      deadline = timers.setTimeout(() => {
        if (current(id)) end({ detail: 'Voice command timed out. Start again when ready.' });
      }, CAPTURE_TIMEOUT_MS);
      opening = open(id, language).catch((error) => {
        if (!current(id)) return;
        const denied = ['NotAllowedError', 'SecurityError'].includes(error?.name);
        end({ error: denied ? MIC.NO_PERMISSION : MIC.ERROR, detail: String(error?.message || error) });
      });
      return opening;
    },
    /** Request final recognition on a repeated gesture; interim text never executes. */
    finish() {
      if (!active) return;
      if (!recognition) { end(); return; }
      const id = generation;
      try { recognition.stop(); } catch { end(); return; }
      if (!current(id)) return;
      timers.clearTimeout(stopTimer);
      stopTimer = timers.setTimeout(() => { if (current(id)) end({ submit: true }); }, STOP_TIMEOUT_MS);
    },
    stop() { end(); },
    get listening() { return active && state === MIC.LISTENING; },
    get active() { return active; },
    get canTranscribe() { return !!Recognition && typeof Recognition.available === 'function'; }
  };
}
