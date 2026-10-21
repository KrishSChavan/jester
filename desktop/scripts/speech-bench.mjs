/**
 * How fast and how accurately each speech model hears a set of commands.
 *
 *   node scripts/speech-bench.mjs <folder> [model ...]
 *
 * <folder> holds commands.txt (one command per line) and WAV files named
 * NN-anything.wav, where NN is the 1-based line number they say. Any mono
 * 16 kHz recording works — macOS `say -o` output or real microphone takes.
 *
 * Latency is the decode time after the utterance has ended, i.e. what the
 * user waits for on top of the end-of-speech pause itself.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelDir, SPEECH_MODELS } from '../src/main/speech/models.js';
import { sameWords, wer } from '../src/main/speech/words.js';

const require = createRequire(import.meta.url);
const sherpa = require('sherpa-onnx-node');

/** A quarter second of silence either side, as a voice-activity detector's segment would have. */
function padded(wave, seconds = 0.25) {
  const pad = Math.round(wave.sampleRate * seconds);
  const samples = new Float32Array(wave.samples.length + pad * 2);
  samples.set(wave.samples, pad);
  return samples;
}

function transcribeOffline(recognizer, wave) {
  const stream = recognizer.createStream();
  stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: padded(wave) });
  const started = performance.now();
  recognizer.decode(stream);
  return { text: recognizer.getResult(stream).text, ms: performance.now() - started };
}

/** Feeds 100 ms chunks as a microphone would; times only what's left after the last one. */
function transcribeStreaming(recognizer, wave) {
  const stream = recognizer.createStream();
  const chunk = Math.round(wave.sampleRate / 10);
  for (let at = 0; at < wave.samples.length; at += chunk) {
    stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples.subarray(at, at + chunk) });
    while (recognizer.isReady(stream)) recognizer.decode(stream);
  }
  const started = performance.now();
  // The silence a speaker leaves before the endpoint fires flushes the
  // model's lookahead; then the input ends.
  stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: new Float32Array(Math.round(wave.sampleRate * 1.5)) });
  stream.inputFinished();
  while (recognizer.isReady(stream)) recognizer.decode(stream);
  return { text: recognizer.getResult(stream).text, ms: performance.now() - started };
}

async function bench(folder, name) {
  const model = SPEECH_MODELS[name];
  const loadStarted = performance.now();
  const recognizer = model.kind === 'streaming'
    ? new sherpa.OnlineRecognizer(model.config(modelDir(name)))
    : new sherpa.OfflineRecognizer(model.config(modelDir(name)));
  const loadMs = performance.now() - loadStarted;

  const commands = fs.readFileSync(path.join(folder, 'commands.txt'), 'utf8').split('\n').map((line) => line.trim()).filter(Boolean);
  const files = fs.readdirSync(folder).filter((file) => /^\d+-.*\.wav$/.test(file)).sort();
  const rows = [];
  for (const file of files) {
    const reference = commands[Number(file.split('-')[0]) - 1];
    // `false`: no external buffer, so this also runs inside Electron.
    const wave = sherpa.readWave(path.join(folder, file), false);
    const result = model.kind === 'streaming' ? transcribeStreaming(recognizer, wave) : transcribeOffline(recognizer, wave);
    rows.push({ file, reference, ...result, wer: wer(reference, result.text), exact: sameWords(reference, result.text), seconds: wave.samples.length / wave.sampleRate });
  }

  const mean = (pick) => rows.reduce((sum, row) => sum + pick(row), 0) / rows.length;
  const sorted = rows.map((row) => row.ms).sort((a, b) => a - b);
  console.log(`\n## ${name} (${model.kind}) — load ${Math.round(loadMs)} ms`);
  console.log(`exact ${rows.filter((row) => row.exact).length}/${rows.length} · WER ${(mean((row) => row.wer) * 100).toFixed(1)}% · decode median ${Math.round(sorted[sorted.length >> 1])} ms, max ${Math.round(sorted.at(-1))} ms (audio ${mean((row) => row.seconds).toFixed(1)} s avg)`);
  for (const row of rows.filter((row) => !row.exact)) console.log(`  ${row.file}: "${row.text.trim()}"  (wanted "${row.reference}")`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [folder, ...names] = process.argv.slice(2);
  if (!folder) {
    console.error('usage: node scripts/speech-bench.mjs <folder> [model ...]');
    process.exit(2);
  }
  for (const name of names.length ? names : Object.keys(SPEECH_MODELS)) await bench(path.resolve(folder), name);
}
