/**
 * The microphone half of the engine: the five band levels the voice pill's bars
 * ride on, and the transcript.
 *
 * Lives in the offscreen document for the same reason the camera does — it's a
 * long-lived page, and both a MediaStream and a SpeechRecognition session need
 * one. Nothing here runs unless the pill is meant to be on screen, so the OS
 * microphone indicator tracks the pill exactly: finger up, light on.
 *
 * Two independent consumers of the same microphone:
 *
 *   levels — getUserMedia -> AnalyserNode, sampled on a timer and reduced to
 *            five numbers. Entirely local.
 *   words  — SpeechRecognition, which opens its own capture. In Chrome that is
 *            a *network* service: audio goes to Google's servers. It is the only
 *            part of Jester that leaves the machine, and it only runs while the
 *            pill is up.
 */

/** 25 Hz. The pill's bars carry a 70 ms transition, which fills the gaps. */
const FRAME_MS = 40;

/**
 * Band edges in Hz, five bars' worth. Roughly logarithmic and stopped at 4 kHz:
 * above that speech carries almost no energy, so a linear split would leave the
 * top two bars dead.
 */
const BANDS = [
  [85, 255],
  [255, 500],
  [500, 1000],
  [1000, 2000],
  [2000, 4000]
];

const FFT_SIZE = 512;
const ANALYSER_SMOOTHING = 0.6;

/** Below this a band reads as silence, so the bars rest as dots rather than jitter. */
const NOISE_FLOOR = 0.07;
const GAIN = 2.1;
/** Bars jump to a sound and fall away from it — the same asymmetry a VU meter has. */
const ATTACK = 0.55;
const DECAY = 0.16;

const MIC_TIMEOUT_MS = 8000;
const TIMED_OUT = Symbol('timed-out');

/** Chrome ends a recognition session on its own; this is how long we wait to re-open. */
const RESTART_DELAY_MS = 300;
/** A session that dies this fast is failing, not finishing. */
const RESTART_FLOOD_MS = 1000;
const RESTART_FLOOD_LIMIT = 5;
const RESTART_BACKOFF_MS = 4000;

/** Interim results arrive per syllable; the console only needs the shape of it. */
const INTERIM_THROTTLE_MS = 220;

export const MIC = {
  IDLE: 'idle',
  STARTING: 'starting',
  LISTENING: 'listening',
  NO_PERMISSION: 'no-permission',
  ERROR: 'error'
};

const SpeechRecognitionImpl =
  globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition || null;

function describeMicError(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return { state: MIC.NO_PERMISSION, detail: 'Microphone access has not been granted yet.' };
    case 'JesterMicTimeout':
      return { state: MIC.NO_PERMISSION, detail: err.message };
    case 'NotFoundError':
    case 'OverconstrainedError':
      return { state: MIC.ERROR, detail: 'No microphone found.' };
    case 'NotReadableError':
      return { state: MIC.ERROR, detail: 'The microphone is already in use by another app.' };
    default:
      return { state: MIC.ERROR, detail: String(err?.message || err) };
  }
}

/**
 * An offscreen document has no UI, so Chrome has nowhere to show a microphone
 * prompt: while the permission is still in the `prompt` state `getUserMedia`
 * doesn't reject, it simply never settles. Same trap the camera falls into, and
 * the same two-part guard — check first, and time out anyway.
 */
async function micPermissionState() {
  try {
    const status = await navigator.permissions.query({ name: 'microphone' });
    return status.state;
  } catch {
    return 'unknown';
  }
}

function openMicGuarded() {
  const pending = navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false
  });
  pending.catch(() => undefined); // the race below may leave this unobserved

  const timeout = new Promise((resolve) => setTimeout(() => resolve(TIMED_OUT), MIC_TIMEOUT_MS));

  return Promise.race([pending, timeout]).then((result) => {
    if (result !== TIMED_OUT) return result;
    pending.then((s) => s.getTracks().forEach((t) => t.stop())).catch(() => undefined);
    const error = new Error(
      'The microphone did not respond — this almost always means access has not been ' +
        'granted. Open the Jester options page and click "Allow microphone access".'
    );
    error.name = 'JesterMicTimeout';
    throw error;
  });
}

/**
 * @param onLevels     `(number[5])` — 0…1 per band, ~25×/second while listening.
 * @param onTranscript `({ text, final })` — never called for empty strings.
 * @param onStatus     `({ state, detail })` — see `MIC`.
 */
export function createVoice({ onLevels, onTranscript, onStatus }) {
  /** What the caller has asked for, which is not the same as what's open yet. */
  let wanted = false;
  let opening = false;

  let stream = null;
  // Reused across start/stop: contexts are expensive and a page gets few of
  // them, and finger-up/finger-down cycles through here constantly.
  let audioCtx = null;
  let source = null;
  let analyser = null;
  let bins = null;
  let bandRanges = null;
  let timer = null;

  let recognition = null;
  let recognitionLive = false;
  let restartTimer = null;
  let restartAt = 0;
  let restartCount = 0;

  let lastInterimAt = 0;
  let lastInterim = '';

  const levels = new Array(BANDS.length).fill(0);

  function report(state, detail = '') {
    onStatus?.({ state, detail });
  }

  // -------------------------------------------------------------------------
  // Levels
  // -------------------------------------------------------------------------

  function computeBandRanges() {
    const hzPerBin = audioCtx.sampleRate / FFT_SIZE;
    const top = analyser.frequencyBinCount - 1;
    return BANDS.map(([low, high]) => {
      const from = Math.min(top, Math.max(1, Math.round(low / hzPerBin)));
      const to = Math.min(top, Math.max(from + 1, Math.round(high / hzPerBin)));
      return [from, to];
    });
  }

  function sample() {
    if (!analyser) return;
    analyser.getByteFrequencyData(bins);

    for (let i = 0; i < bandRanges.length; i += 1) {
      const [from, to] = bandRanges[i];
      let total = 0;
      for (let bin = from; bin <= to; bin += 1) total += bins[bin];
      const mean = total / (to - from + 1) / 255;

      const target = Math.max(0, Math.min(1, (mean - NOISE_FLOOR) * GAIN));
      const rate = target > levels[i] ? ATTACK : DECAY;
      levels[i] += (target - levels[i]) * rate;
    }

    onLevels?.(levels.map((v) => Math.round(v * 100) / 100));
  }

  // -------------------------------------------------------------------------
  // Words
  // -------------------------------------------------------------------------

  function emitTranscript(event) {
    let interim = '';
    let final = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const text = result[0]?.transcript || '';
      if (result.isFinal) final += text;
      else interim += text;
    }

    final = final.trim();
    if (final) {
      lastInterim = '';
      onTranscript?.({ text: final, final: true });
      return;
    }

    interim = interim.trim();
    if (!interim || interim === lastInterim) return;
    const now = performance.now();
    if (now - lastInterimAt < INTERIM_THROTTLE_MS) return;
    lastInterimAt = now;
    lastInterim = interim;
    onTranscript?.({ text: interim, final: false });
  }

  function scheduleRestart() {
    if (!wanted || restartTimer) return;
    // A session that ends the instant it starts is failing rather than
    // finishing, and restarting it on a 300 ms timer would spin.
    const now = performance.now();
    restartCount = now - restartAt < RESTART_FLOOD_MS ? restartCount + 1 : 0;
    restartAt = now;
    const delay = restartCount >= RESTART_FLOOD_LIMIT ? RESTART_BACKOFF_MS : RESTART_DELAY_MS;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      startRecognition();
    }, delay);
  }

  function startRecognition() {
    if (!SpeechRecognitionImpl || !wanted || recognitionLive) return;

    recognition = new SpeechRecognitionImpl();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.lang = navigator.language || 'en-US';

    recognition.onresult = emitTranscript;

    recognition.onerror = (event) => {
      switch (event.error) {
        case 'no-speech':
        case 'aborted':
          return; // ordinary punctuation of a long session
        case 'not-allowed':
        case 'service-not-allowed':
          wanted = false;
          report(MIC.NO_PERMISSION, 'Microphone access was refused for speech recognition.');
          return;
        default:
          report(MIC.ERROR, `Speech recognition: ${event.error}`);
      }
    };

    recognition.onend = () => {
      recognitionLive = false;
      // Chrome ends a session by itself after a pause even with continuous set,
      // so staying listening means re-opening rather than trusting the flag.
      scheduleRestart();
    };

    try {
      recognition.start();
      recognitionLive = true;
    } catch (err) {
      recognitionLive = false;
      // `InvalidStateError` just means the previous session hasn't finished
      // unwinding; anything else is worth saying out loud.
      if (err?.name !== 'InvalidStateError') report(MIC.ERROR, String(err?.message || err));
      scheduleRestart();
    }
  }

  function stopRecognition() {
    clearTimeout(restartTimer);
    restartTimer = null;
    if (!recognition) return;
    const instance = recognition;
    recognition = null;
    recognitionLive = false;
    instance.onresult = null;
    instance.onerror = null;
    instance.onend = null;
    try {
      instance.abort();
    } catch {
      /* already finished */
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async function open() {
    const permission = await micPermissionState();
    if (permission === 'denied' || permission === 'prompt') {
      report(
        MIC.NO_PERMISSION,
        permission === 'denied'
          ? 'Microphone access is blocked for this extension. Re-allow it from the padlock ' +
              'icon on the options page.'
          : 'Microphone access has not been granted yet. Open the options page and click ' +
              '"Allow microphone access".'
      );
      return false;
    }

    stream = await openMicGuarded();
    if (!wanted) {
      // Stopped while we were waiting on the microphone. If the finger went
      // back up in the meantime `wanted` is true again and this open still
      // counts — that's the whole reason it's re-checked here rather than being
      // cancelled outright.
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
      return false;
    }

    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') await audioCtx.resume().catch(() => undefined);

    analyser = audioCtx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = ANALYSER_SMOOTHING;
    bins = new Uint8Array(analyser.frequencyBinCount);
    bandRanges = computeBandRanges();

    source = audioCtx.createMediaStreamSource(stream);
    source.connect(analyser);

    levels.fill(0);
    timer = setInterval(sample, FRAME_MS);
    return true;
  }

  function teardown() {
    clearInterval(timer);
    timer = null;
    stopRecognition();

    source?.disconnect();
    source = null;
    analyser = null;
    bins = null;
    bandRanges = null;

    stream?.getTracks().forEach((track) => track.stop());
    stream = null;

    levels.fill(0);
    lastInterim = '';
    restartCount = 0;
  }

  return {
    /** Idempotent — safe to call on every path that might want the pill up. */
    async start() {
      // Set before the guard, so a start that lands while an open is in flight
      // still counts: the open re-checks this flag when it lands.
      wanted = true;
      if (opening || timer) return;

      opening = true;
      report(MIC.STARTING);
      try {
        if (!(await open())) {
          wanted = false;
          teardown();
          return;
        }
      } catch (err) {
        wanted = false;
        teardown();
        const { state, detail } = describeMicError(err);
        report(state, detail);
        return;
      } finally {
        opening = false;
      }

      if (!SpeechRecognitionImpl) {
        console.warn('[jester] no SpeechRecognition in this browser — levels only, no transcript.');
      }
      startRecognition();
      report(MIC.LISTENING);
    },

    /** Idempotent. Releases the microphone outright — the OS indicator goes out. */
    stop() {
      if (!wanted && !stream && !timer) return;
      wanted = false;
      teardown();
      report(MIC.IDLE);
    },

    get listening() {
      return wanted && !!timer;
    },

    /** False when the browser has no speech engine — levels still work. */
    get canTranscribe() {
      return !!SpeechRecognitionImpl;
    }
  };
}
