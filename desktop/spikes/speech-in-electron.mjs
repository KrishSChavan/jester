/**
 * Phase 0 spike: does sherpa-onnx run inside Electron's utilityProcess, and
 * how long after someone stops talking does the text arrive?
 *
 *   env -u ELECTRON_RUN_AS_NODE npx electron spikes/speech-in-electron.mjs <folder>
 *
 * (VS Code sets ELECTRON_RUN_AS_NODE for its terminals; see scripts/start.mjs.)
 *
 * <folder> is the same as for scripts/speech-bench.mjs. Each WAV is streamed
 * in 100 ms chunks at real-time pace, followed by silence, the way a
 * microphone would deliver it.
 */

import { app, utilityProcess } from 'electron';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sameWords } from '../src/main/speech/words.js';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const folder = path.resolve(process.argv.at(-1));
const CHUNK_MS = 100;

app.whenReady().then(async () => {
  const sherpa = require('sherpa-onnx-node');
  const service = utilityProcess.fork(path.join(here, '../src/main/speech/service.js'), [], { serviceName: 'Jester speech', stdio: 'inherit' });
  service.on('exit', (code) => {
    console.error(`speech process exited (${code})`);
    app.exit(1);
  });
  const next = (type) => new Promise((resolve) => {
    const listener = (message) => {
      if (message.type === type || message.type === 'error') {
        service.off('message', listener);
        if (message.type === 'error') console.error('speech error:', message.detail);
        resolve(message);
      }
    };
    service.on('message', listener);
  });

  service.postMessage({ type: 'start', model: process.env.JESTER_SPEECH_MODEL || 'parakeet-110m' });
  const ready = await next('ready');
  console.log('ready', ready);

  const commands = fs.readFileSync(path.join(folder, 'commands.txt'), 'utf8').split('\n').map((line) => line.trim()).filter(Boolean);
  const files = fs.readdirSync(folder).filter((file) => /^\d+-.*\.wav$/.test(file)).sort();
  const waits = [];
  let exact = 0;
  for (const file of files) {
    const wave = sherpa.readWave(path.join(folder, file), false);
    const chunk = (wave.sampleRate * CHUNK_MS) / 1000;
    service.postMessage({ type: 'begin' });
    const final = next('final');
    let partials = 0;
    const onPartial = (message) => message.type === 'partial' && (partials += 1);
    service.on('message', onPartial);
    // Speech at real-time pace, then up to two seconds of silence.
    const silence = new Float32Array(wave.sampleRate * 2);
    const samples = new Float32Array(wave.samples.length + silence.length);
    samples.set(wave.samples);
    let speechEndedAt = 0;
    let result = null;
    final.then((message) => (result = message));
    for (let at = 0; at < samples.length && !result; at += chunk) {
      service.postMessage({ type: 'audio', samples: samples.slice(at, at + chunk) });
      if (at + chunk >= wave.samples.length && !speechEndedAt) speechEndedAt = performance.now();
      await new Promise((resolve) => setTimeout(resolve, CHUNK_MS));
    }
    if (!result) {
      service.postMessage({ type: 'end' });
      result = await final;
    }
    service.off('message', onPartial);
    const waited = Math.round(performance.now() - speechEndedAt);
    waits.push(waited);
    const reference = commands[Number(file.split('-')[0]) - 1];
    if (sameWords(reference, result.text)) exact += 1;
    console.log(`${file}  ${String(waited).padStart(4)} ms after speech (decode ${result.decodeMs} ms, ${partials} partials)  "${result.text}"`);
  }
  waits.sort((a, b) => a - b);
  console.log(`\nexact ${exact}/${files.length} · speech end → text: median ${waits[waits.length >> 1]} ms, max ${waits.at(-1)} ms`);
  service.kill();
  app.quit();
});
