/**
 * Speech recognition, in a process of its own.
 *
 * Runs as an Electron utilityProcess so a decode never stalls the main process,
 * which moves the cursor and draws the overlay. Audio arrives as 16 kHz mono
 * Float32 chunks; a voice-activity detector decides where the utterance ends,
 * and the recognizer turns it into text. Nothing leaves the machine.
 *
 * Messages in:  start {model} · begin · audio {samples} · end · transcribe {samples}
 * Messages out: ready {model, loadMs} · speech · partial {text} · final {text, decodeMs} · error {detail}
 */

import { createRequire } from 'node:module';
import { modelDir, SPEECH_MODELS, VAD_MODEL } from './models.js';

const require = createRequire(import.meta.url);
const sherpa = require('sherpa-onnx-node');

const SAMPLE_RATE = 16000;
/** Silero reads 512-sample windows. */
const WINDOW = 512;
/** How long the speaker must be quiet before the utterance counts as over. */
const END_SILENCE_S = 0.6;
/** Partial text is re-decoded from the audio so far this often while someone talks. */
const PARTIAL_EVERY_MS = 500;
/**
 * Decoding starts this long before the detector fired. It fires a syllable or
 * two into the first word, so its own segment loses "lock" in "lock the screen".
 */
const PREROLL_S = 1;
/** voice.js gives up on a capture after 30 s; so does this. */
const MAX_CAPTURE_S = 30;

const port = process.parentPort;
const send = (message) => port.postMessage(message);

let recognizer = null;
let vad = null;
let state = null;

function freshState() {
  // `windows` is everything since `begin`; `speechAt` the window where speech was first detected.
  return { carry: new Float32Array(0), windows: [], speechAt: -1, lastPartialAt: 0, partialBusy: false, done: false };
}

/** The utterance: from just before speech was detected to now. */
function utterance() {
  if (state.speechAt < 0) return new Float32Array(0);
  const from = Math.max(0, state.speechAt - Math.round((PREROLL_S * SAMPLE_RATE) / WINDOW));
  return concat(state.windows.slice(from));
}

function concat(chunks) {
  const out = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

async function decode(samples) {
  const stream = recognizer.createStream();
  // A quarter second of silence either side helps short words like "mute".
  const pad = new Float32Array(SAMPLE_RATE / 4);
  stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: concat([pad, samples, pad]) });
  const started = performance.now();
  const result = await recognizer.decodeAsync(stream);
  return { text: String(result?.text || '').trim(), decodeMs: Math.round(performance.now() - started) };
}

function start(modelName) {
  const model = SPEECH_MODELS[modelName];
  if (!model || model.kind !== 'offline') throw new Error(`"${modelName}" is not an offline speech model`);
  const started = performance.now();
  recognizer = new sherpa.OfflineRecognizer(model.config(modelDir(modelName)));
  vad = new sherpa.Vad({
    sileroVad: { model: VAD_MODEL, threshold: 0.5, minSilenceDuration: END_SILENCE_S, minSpeechDuration: 0.2, windowSize: WINDOW, maxSpeechDuration: 20 },
    sampleRate: SAMPLE_RATE,
    numThreads: 1,
    provider: 'cpu',
    debug: 0
  }, 30);
  state = freshState();
  send({ type: 'ready', model: modelName, loadMs: Math.round(performance.now() - started) });
}

async function finish(samples) {
  if (state.done) return;
  state.done = true;
  const { text, decodeMs } = samples.length ? await decode(samples) : { text: '', decodeMs: 0 };
  send({ type: 'final', text, decodeMs });
}

async function partial() {
  if (state.partialBusy || state.done || state.speechAt < 0) return;
  state.partialBusy = true;
  try {
    const { text } = await decode(utterance());
    if (!state.done && text) send({ type: 'partial', text });
  } finally {
    state.partialBusy = false;
  }
}

async function audio(samples) {
  if (!vad || state.done) return;
  let buffer = concat([state.carry, samples]);
  let at = 0;
  for (; at + WINDOW <= buffer.length; at += WINDOW) {
    const window = buffer.slice(at, at + WINDOW);
    state.windows.push(window);
    vad.acceptWaveform(window);
    if (vad.isDetected() && state.speechAt < 0) {
      state.speechAt = state.windows.length - 1;
      send({ type: 'speech' });
    }
    // The detector hands back a segment once the speaker has been quiet for
    // END_SILENCE_S: that is the end of the command. Only its timing is
    // used — see PREROLL_S.
    if (!vad.isEmpty()) {
      while (!vad.isEmpty()) vad.pop();
      await finish(utterance());
      return;
    }
    if (state.windows.length * WINDOW >= MAX_CAPTURE_S * SAMPLE_RATE) {
      await finish(utterance());
      return;
    }
  }
  state.carry = buffer.slice(at);
  if (state.speechAt >= 0 && performance.now() - state.lastPartialAt >= PARTIAL_EVERY_MS) {
    state.lastPartialAt = performance.now();
    partial().catch((err) => send({ type: 'error', detail: String(err?.message || err) }));
  }
}

port.on('message', async ({ data }) => {
  try {
    switch (data?.type) {
      case 'start':
        start(data.model);
        break;
      case 'begin':
        vad?.reset();
        state = freshState();
        break;
      case 'audio':
        await audio(data.samples instanceof Float32Array ? data.samples : new Float32Array(data.samples));
        break;
      case 'end':
        // Capture ended (gesture, timeout) before the speaker went quiet.
        if (vad && !state.done) {
          vad.flush();
          while (!vad.isEmpty()) vad.pop();
          await finish(utterance());
        }
        break;
      case 'transcribe':
        send({ type: 'final', ...(await decode(new Float32Array(data.samples))) });
        break;
      default:
        break;
    }
  } catch (err) {
    send({ type: 'error', detail: String(err?.message || err) });
  }
});
