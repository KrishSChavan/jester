/**
 * Speech recognition, in a process of its own.
 *
 * Runs as an Electron utilityProcess so a decode never stalls the main process,
 * which moves the cursor and draws the overlay. Audio arrives as 16 kHz mono
 * Float32 chunks; a voice-activity detector decides where the utterance ends,
 * and the recognizer turns it into text. Nothing leaves the machine.
 *
 * Messages in:  start {model} · begin · listen · voiceprint {print} · teaching {on} · audio {samples} · end · abort · transcribe {samples}
 * Messages out: ready {model, loadMs} · speech · partial {text} · final {text, decodeMs} · heard {text, decodeMs, score, seconds, voice?} · stranger {score, seconds} · error {detail}
 *
 * `begin` hears one command. `listen` never stops: every utterance comes out as
 * `heard`, for the continuous assistant, and only a second or so is kept in
 * between. Nothing heard this way is saved, whatever JESTER_SAVE_SPEECH says.
 * With a voiceprint set, a voice that isn't the user's is never even decoded:
 * no text of what anyone else says exists, here or anywhere.
 *
 * JESTER_SAVE_SPEECH=folder keeps each utterance as a WAV with what was
 * heard beside it, for comparing models on a real voice. Off unless set.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { sounds, likeness } from '../voiceprint.js';
import { modelDir, SPEECH_MODELS, VAD_MODEL, VOICE_MODEL } from './models.js';

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
/** All that's kept before speech while listening: the preroll, and a little. */
const KEPT_WINDOWS = Math.ceil((PREROLL_S * SAMPLE_RATE) / WINDOW) + 2;
/** The detector counts samples in 32 bits and finds nothing past 37 hours of them (measured), so it starts over. */
const VAD_RESTART_S = 6 * 60 * 60;
const SAVE_DIR = process.env.JESTER_SAVE_SPEECH || '';

const port = process.parentPort;
const send = (message) => port.postMessage(message);

let recognizer = null;
let vad = null;
let state = null;
/** Windows since the detector last started over. */
let sinceRestart = 0;
let decoding = false;
/** The newest utterance overheard while another was decoding. */
let waiting = null;
/** Each `listen` starts one: what was said before it doesn't count, however late its decode ends. */
let listens = 0;
let voices = null;
/** The user's voice, once known. */
let voiceprint = null;
/** Reading the lines that make a voiceprint: each utterance comes with its voice. */
let teaching = false;

function freshState(listening = false) {
  // `windows` is everything since `begin`; `speechAt` the window where speech was first detected.
  return { carry: new Float32Array(0), windows: [], speechAt: -1, lastPartialAt: 0, partialBusy: false, done: false, listening };
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

/** A speaker's voice as numbers, or null with no model or too little to go on. */
function voiceOf(samples) {
  if (!voices) return null;
  const stream = voices.createStream();
  stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
  stream.inputFinished();
  // Not an external buffer: Electron has none (see README, sherpa-onnx).
  return voices.isReady(stream) ? voices.compute(stream, false) : null;
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
  // Without its model, everyone's heard, as before it existed.
  if (fs.existsSync(VOICE_MODEL)) voices = new sherpa.SpeakerEmbeddingExtractor({ model: VOICE_MODEL, numThreads: 1, debug: 0, provider: 'cpu' });
  state = freshState();
  send({ type: 'ready', model: modelName, loadMs: Math.round(performance.now() - started) });
}

async function finish(samples) {
  if (state.done) return;
  state.done = true;
  const { text, decodeMs } = samples.length ? await decode(samples) : { text: '', decodeMs: 0 };
  if (SAVE_DIR && samples.length) save(samples, text);
  send({ type: 'final', text, decodeMs });
}

function save(samples, text) {
  try {
    const name = path.join(SAVE_DIR, new Date().toISOString().replace(/[:.]/g, '-'));
    fs.mkdirSync(SAVE_DIR, { recursive: true });
    sherpa.writeWave(`${name}.wav`, { samples, sampleRate: SAMPLE_RATE });
    fs.writeFileSync(`${name}.txt`, `${text}\n`);
  } catch (err) {
    console.error('could not save the utterance:', err.message);
  }
}

/** Decodes off the audio's path, so nothing said meanwhile is lost. Falling behind keeps only the newest. */
async function overheard(samples) {
  if (decoding) {
    waiting = samples;
    return;
  }
  decoding = true;
  try {
    for (let next = samples; next; ) {
      await hear(next);
      next = waiting;
      waiting = null;
    }
  } finally {
    decoding = false;
  }
}

/** Who it was, then, if that's someone to listen to, what they said. */
async function hear(samples) {
  const during = listens;
  const seconds = samples.length / SAMPLE_RATE;
  const voice = voiceprint || teaching ? voiceOf(samples) : null;
  const score = voiceprint ? (voice ? likeness(voice, voiceprint) : 0) : null;
  if (voiceprint && !teaching && !sounds(score, seconds)) return send({ type: 'stranger', score, seconds });
  const { text, decodeMs } = await decode(samples);
  if (!text || during !== listens) return undefined;
  return send({ type: 'heard', text, decodeMs, score, seconds, ...(teaching && voice ? { voice: Array.from(voice) } : {}) });
}

/** One utterance over, and straight on to the next. */
function endOverheard() {
  const samples = utterance();
  state = freshState(true);
  if (samples.length) overheard(samples).catch((err) => send({ type: 'error', detail: String(err?.message || err) }));
}

/** One more window of listening: quiet ones aren't kept. */
function keepListening() {
  sinceRestart += 1;
  if (state.speechAt >= 0) {
    if ((state.windows.length - state.speechAt) * WINDOW >= MAX_CAPTURE_S * SAMPLE_RATE) endOverheard();
    return;
  }
  if (state.windows.length > KEPT_WINDOWS) state.windows.shift();
  if (sinceRestart * WINDOW >= VAD_RESTART_S * SAMPLE_RATE) {
    vad.reset();
    sinceRestart = 0;
  }
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
      if (state.listening) {
        endOverheard();
        continue;
      }
      await finish(utterance());
      return;
    }
    if (state.listening) {
      keepListening();
      continue;
    }
    if (state.windows.length * WINDOW >= MAX_CAPTURE_S * SAMPLE_RATE) {
      await finish(utterance());
      return;
    }
  }
  state.carry = buffer.slice(at);
  if (!state.listening && state.speechAt >= 0 && performance.now() - state.lastPartialAt >= PARTIAL_EVERY_MS) {
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
      case 'voiceprint':
        voiceprint = data.print ? Float32Array.from(data.print) : null;
        break;
      case 'teaching':
        teaching = !!data.on;
        break;
      case 'listen':
        vad?.reset();
        listens += 1;
        waiting = null;
        sinceRestart = 0;
        state = freshState(true);
        break;
      // A capture called off: forget it, say nothing.
      case 'abort':
        vad?.reset();
        state = { ...freshState(), done: true };
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
