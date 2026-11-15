/**
 * Speech recognition, in a process of its own.
 *
 * Runs as an Electron utilityProcess so a decode never stalls the main process,
 * which moves the cursor and draws the overlay. Audio arrives as 16 kHz mono
 * Float32 chunks; a voice-activity detector decides where the utterance ends,
 * and the recognizer turns it into text. Nothing leaves the machine.
 *
 * Messages in:  start {model} · begin · listen · voiceprint {print, learned?} · teaching {on} · keep {dir} · audio {samples} · end · abort · transcribe {samples}
 * Messages out: ready {model, loadMs} · speech · partial {text} · final {text, decodeMs} · wake · heard {text, decodeMs, afterMs, score, enrolled, seconds, unsure?, voice?, learn?} · stranger {score, enrolled, seconds} · error {detail}
 *
 * `begin` hears one command. `listen` never stops: every utterance comes out as
 * `heard`, for the continuous assistant, and only a second or so is kept in
 * between. While someone's still talking, the start of it is read twice for
 * his name, and `wake` says it's there: only that, never the words.
 * Nothing heard this way is saved, whatever JESTER_SAVE_SPEECH says, unless the
 * user has turned on keeping what he wasn't sure of (`keep {dir}`, Settings ›
 * Assistant and voice): then a voice that scored near theirs without being
 * taken as theirs is kept as a WAV with its score, the newest KEEP_MOST of
 * them, on this computer only, for tuning voiceprint.js against the real voice
 * (scripts/hear-check.mjs reads them).
 * With a voiceprint set, a voice that isn't the user's is never even decoded:
 * no text of what anyone else says exists, here or anywhere. One that's only
 * maybe theirs (voiceprint.js MAYBE) is, marked `unsure`: it needs his name.
 *
 * JESTER_SAVE_SPEECH=folder keeps each utterance as a WAV with what was
 * heard beside it, for comparing models on a real voice. Off unless set.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { judged, scored, worthLearning } from '../voiceprint.js';
import { wakesEarly } from '../wake.js';
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
/** This far into speech, what's been said so far is read for his name. Two reads at most: it comes first. */
const PEEK_AT_S = [1, 2];
/** All that's kept before speech while listening: the preroll, and a little. */
const KEPT_WINDOWS = Math.ceil((PREROLL_S * SAMPLE_RATE) / WINDOW) + 2;
/** The detector counts samples in 32 bits and finds nothing past 37 hours of them (measured), so it starts over. */
const VAD_RESTART_S = 6 * 60 * 60;
const SAVE_DIR = process.env.JESTER_SAVE_SPEECH || '';
/** Kept for tuning, when the user's said to: voices that scored at least this, and weren't plainly theirs. */
const KEEP_FLOOR = 0.2;
const KEEP_MOST = 200;

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
/** Where what he wasn't sure of is kept for tuning, or '' when the user hasn't said to. */
let keepDir = '';
/** Other ways the user's been heard to sound, learned from use (voiceprint.js). */
let learned = [];
/** Reading the lines that make a voiceprint: each utterance comes with its voice. */
let teaching = false;

function freshState(listening = false) {
  // `windows` is everything since `begin`; `speechAt` the window where speech was first detected.
  return { carry: new Float32Array(0), windows: [], speechAt: -1, lastPartialAt: 0, partialBusy: false, done: false, listening, peeks: 0, peeking: false };
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

/**
 * Keeps a voice he wasn't sure of, for tuning: its sound, and beside it what it scored and how it was judged. What
 * was said is there only for a voice that was decoded anyway (maybe the user's). The oldest go past KEEP_MOST.
 */
function keepUnsure(samples, facts) {
  try {
    fs.mkdirSync(keepDir, { recursive: true });
    const name = path.join(keepDir, new Date().toISOString().replace(/[:.]/g, '-'));
    sherpa.writeWave(`${name}.wav`, { samples, sampleRate: SAMPLE_RATE });
    fs.writeFileSync(`${name}.json`, `${JSON.stringify(facts)}\n`);
    const kept = fs.readdirSync(keepDir).filter((file) => file.endsWith('.wav')).sort();
    for (const old of kept.slice(0, Math.max(0, kept.length - KEEP_MOST))) {
      fs.rmSync(path.join(keepDir, old), { force: true });
      fs.rmSync(path.join(keepDir, old.replace(/\.wav$/, '.json')), { force: true });
    }
  } catch (err) {
    console.error('could not keep the utterance:', err.message);
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
  const began = performance.now();
  const during = listens;
  const seconds = samples.length / SAMPLE_RATE;
  const voice = voiceprint || teaching ? voiceOf(samples) : null;
  const { score, enrolled } = voiceprint ? (voice ? scored(voice, voiceprint, learned) : { score: 0, enrolled: 0 }) : { score: null, enrolled: null };
  const who = voiceprint && !teaching ? judged(score, seconds) : 'you';
  const round = (value) => Math.round(value * 1000) / 1000;
  if (who === 'stranger') {
    if (keepDir && score >= KEEP_FLOOR) keepUnsure(samples, { who, score: round(score), enrolled: round(enrolled), seconds: round(seconds) });
    return send({ type: 'stranger', score, enrolled, seconds });
  }
  const { text, decodeMs } = await decode(samples);
  if (keepDir && who === 'maybe') keepUnsure(samples, { who, score: round(score), enrolled: round(enrolled), seconds: round(seconds), text });
  if (!text || during !== listens) return undefined;
  // The voice goes along while teaching, and when it's one more way the user sounds: kept only if this was for him.
  const keep = !!voice && (teaching || (who === 'you' && !!voiceprint && worthLearning(voice, { score, enrolled, seconds }, learned)));
  // afterMs: how long after the last word this is: the pause that ended it, then telling whose voice and what it said.
  return send({ type: 'heard', text, decodeMs, afterMs: Math.round(END_SILENCE_S * 1000 + performance.now() - began), score, enrolled, seconds, ...(who === 'maybe' ? { unsure: true } : {}), ...(keep ? { voice: Array.from(voice), ...(teaching ? {} : { learn: true }) } : {}) });
}

/** One utterance over, and straight on to the next. */
function endOverheard() {
  const samples = utterance();
  state = freshState(true);
  if (samples.length) overheard(samples).catch((err) => send({ type: 'error', detail: String(err?.message || err) }));
}

/**
 * Whether what's being said so far starts with his name. Not while teaching,
 * nor while the last utterance is still decoding; and a voiceprint keeps
 * everyone else's words from being decoded here too.
 */
async function peek() {
  const during = state;
  during.peeks += 1;
  during.peeking = true;
  try {
    const samples = utterance();
    if (voiceprint) {
      // Only his name wakes him early, so maybe the user's will do.
      const voice = voiceOf(samples);
      if (judged(voice ? scored(voice, voiceprint, learned).score : 0, samples.length / SAMPLE_RATE) === 'stranger') return;
    }
    const { text } = await decode(samples);
    if (state !== during || !wakesEarly(text)) return;
    during.peeks = PEEK_AT_S.length;
    send({ type: 'wake' });
  } finally {
    during.peeking = false;
  }
}

/** One more window of listening: quiet ones aren't kept. */
function keepListening() {
  sinceRestart += 1;
  if (state.speechAt >= 0) {
    const said = (state.windows.length - state.speechAt) * WINDOW;
    if (said >= MAX_CAPTURE_S * SAMPLE_RATE) return endOverheard();
    if (!teaching && !decoding && !state.peeking && said >= PEEK_AT_S[state.peeks] * SAMPLE_RATE) {
      peek().catch((err) => send({ type: 'error', detail: String(err?.message || err) }));
    }
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
        learned = voiceprint && Array.isArray(data.learned) ? data.learned.map((voice) => Float32Array.from(voice)) : [];
        break;
      case 'teaching':
        teaching = !!data.on;
        break;
      case 'keep':
        keepDir = typeof data.dir === 'string' ? data.dir : '';
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
