/**
 * Jester's voice, in a process of its own: Kokoro through sherpa-onnx.
 *
 * A utilityProcess, so making a line never stalls the main process or the one
 * that listens. Text comes in a line at a time and a WAV goes back; nothing
 * leaves the machine.
 *
 * Messages in:  start {accent, threads?} · say {id, text, sid, speed?, tight?} · drop {id}
 * Messages out: ready {loadMs, accent, threads} · sound {id, bytes, mime, seconds, tookMs} · error {id?, detail}
 *
 * Kokoro leaves about 50 ms of quiet before a line and 100 ms after. The quiet
 * before is cut to LEAD_S, so he's heard that much sooner; `tight` cuts the quiet
 * after as well, for a piece that stops mid-sentence and runs on into the next.
 *
 * One line is made at a time, in the order asked. `drop` takes a line out of
 * the queue, or stops the one being made at its next sentence.
 */

import { createRequire } from 'node:module';
import { kokoroConfig, trimmed, wav } from './voices.js';

const require = createRequire(import.meta.url);
const sherpa = require('sherpa-onnx-node');

const port = process.parentPort;
let tts = null;
/** Lines waiting: {id, text, sid, speed}. */
const queue = [];
/** The line being made, and whether it's still wanted. */
let making = null;

async function pump() {
  if (making || !queue.length) return;
  const line = queue.shift();
  making = { id: line.id, wanted: true };
  const mine = making;
  const started = Date.now();
  try {
    if (!tts) throw new Error('not-started');
    const audio = await tts.generateAsync({ text: line.text, sid: line.sid, speed: line.speed || 1, enableExternalBuffer: false, onProgress: () => (mine.wanted ? 1 : 0) });
    if (mine.wanted) {
      if (!audio?.samples?.length) throw new Error('no-sound');
      const samples = trimmed(audio.samples, audio.sampleRate, line.tight);
      port.postMessage({ type: 'sound', id: line.id, bytes: wav(samples, audio.sampleRate), mime: 'audio/wav', seconds: samples.length / audio.sampleRate, tookMs: Date.now() - started });
    }
  } catch (err) {
    if (mine.wanted) port.postMessage({ type: 'error', id: line.id, detail: String(err?.message || err) });
  }
  making = null;
  pump();
}

port?.on('message', ({ data }) => {
  if (data?.type === 'start') {
    const started = Date.now();
    try {
      const config = kokoroConfig(data.accent, { dir: data.dir, threads: data.threads });
      tts = new sherpa.OfflineTts(config);
      port.postMessage({ type: 'ready', loadMs: Date.now() - started, accent: data.accent, threads: config.model.numThreads });
    } catch (err) {
      port.postMessage({ type: 'error', detail: `load: ${String(err?.message || err)}` });
    }
  } else if (data?.type === 'say' && typeof data.text === 'string') {
    queue.push({ id: data.id, text: data.text, sid: data.sid, speed: data.speed, tight: data.tight === true });
    pump();
  } else if (data?.type === 'drop') {
    const at = queue.findIndex((line) => line.id === data.id);
    if (at >= 0) queue.splice(at, 1);
    else if (making?.id === data.id) making.wanted = false;
  }
});
