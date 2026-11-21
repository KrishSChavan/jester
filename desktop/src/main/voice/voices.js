/**
 * Jester's voice: Kokoro v1.0 (Apache-2.0), run on this computer by sherpa-onnx.
 * Nothing he says leaves the machine, and there's no account or allowance.
 *
 * The model is 334 MB to fetch (scripts/fetch-models.mjs kokoro) and too big for
 * git; without it he speaks with the computer's own voice.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MODELS_DIR } from '../speech/models.js';

export const KOKORO_FOLDER = 'kokoro-multi-lang-v1_0';

/**
 * The voices Settings offers, of the model's 54: `sid` is the model's own number for it, and `accent` picks the
 * pronunciation list ("gb" says "schedule" the British way).
 */
export const VOICES = Object.freeze([
  { id: 'george', name: 'George', about: 'British, male', sid: 26, accent: 'gb' },
  { id: 'lewis', name: 'Lewis', about: 'British, male', sid: 27, accent: 'gb' },
  { id: 'fable', name: 'Fable', about: 'British, male', sid: 25, accent: 'gb' },
  { id: 'daniel', name: 'Daniel', about: 'British, male', sid: 24, accent: 'gb' },
  { id: 'emma', name: 'Emma', about: 'British, female', sid: 21, accent: 'gb' },
  { id: 'michael', name: 'Michael', about: 'American, male', sid: 16, accent: 'us' },
  { id: 'fenrir', name: 'Fenrir', about: 'American, male', sid: 14, accent: 'us' },
  { id: 'puck', name: 'Puck', about: 'American, male', sid: 18, accent: 'us' },
  { id: 'heart', name: 'Heart', about: 'American, female', sid: 3, accent: 'us' },
  { id: 'bella', name: 'Bella', about: 'American, female', sid: 2, accent: 'us' }
]);
export const DEFAULT_VOICE = 'george';

/** The voice a setting names, or the default: a setting from another version never leaves him silent. */
export const voiceNamed = (id) => VOICES.find((voice) => voice.id === id) || VOICES.find((voice) => voice.id === DEFAULT_VOICE);

export const kokoroDir = (models = MODELS_DIR) => path.join(models, KOKORO_FOLDER);

/** Whether the model's been fetched. */
export const kokoroInstalled = (models = MODELS_DIR) => fs.existsSync(path.join(kokoroDir(models), 'model.onnx')) && fs.existsSync(path.join(kokoroDir(models), 'voices.bin'));

/**
 * How many threads make a line. Measured on an M4 Pro (12 cores, 2026-11-15): a 24-character sentence takes 650 ms
 * on two, 380 on four, 310 on six and 255 on eight; Core ML was slower than four. Four cores are left for everything
 * else, and nothing else of his is busy while he's working out how to say something.
 *
 * A server (JESTER_SERVER) has nothing to leave them for: no hands, camera, gestures or overlays of his run there, so
 * it uses them all. Measured on his Oracle server (four Neoverse-N1 cores, 2026-11-21): "Hey, good evening." took
 * 1.8 s on the two it was given, longer than the 1.4 s it takes to say, so every sentence after it was waited for
 * too; on four, 1.0 s, and each sentence made in about 0.65 of the time it takes to say. (Its int8 model was twice
 * as slow there.)
 */
export const kokoroThreads = (cores = os.availableParallelism(), { server = false } = {}) => Math.max(2, Math.min(8, server ? cores : cores - 4));

/** sherpa-onnx's config for one accent. One pronunciation list at a time: given both, it warns of every shared word. */
export function kokoroConfig(accent, { dir = kokoroDir(), threads = kokoroThreads() } = {}) {
  return {
    model: {
      kokoro: {
        model: path.join(dir, 'model.onnx'),
        voices: path.join(dir, 'voices.bin'),
        tokens: path.join(dir, 'tokens.txt'),
        dataDir: path.join(dir, 'espeak-ng-data'),
        lexicon: path.join(dir, accent === 'us' ? 'lexicon-us-en.txt' : 'lexicon-gb-en.txt')
      },
      numThreads: threads,
      provider: 'cpu',
      debug: 0
    },
    maxNumSentences: 1
  };
}

/** Quieter than this is quiet. */
const QUIET = 0.01;
const LEAD_S = 0.015;
/** What's left after a piece that runs on: the gap between two words said without a breath. */
const TIGHT_TAIL_S = 0.03;

/** The samples without the quiet before them, and, `tight`, without most of the quiet after. */
export function trimmed(samples, sampleRate, tight = false) {
  let from = 0;
  while (from < samples.length && Math.abs(samples[from]) < QUIET) from += 1;
  if (from === samples.length) return samples;
  from = Math.max(0, from - Math.round(LEAD_S * sampleRate));
  let to = samples.length;
  if (tight) {
    while (to > from && Math.abs(samples[to - 1]) < QUIET) to -= 1;
    to = Math.min(samples.length, to + Math.round(TIGHT_TAIL_S * sampleRate));
  }
  return samples.subarray(from, to);
}

/** 16-bit mono WAV: what Chromium's <audio> plays without being told anything. */
export function wav(samples, sampleRate) {
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(36 + samples.length * 2, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(samples.length * 2, 40);
  for (let index = 0; index < samples.length; index++) bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[index])) * 32767), 44 + index * 2);
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length);
}
