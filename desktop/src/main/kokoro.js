/**
 * Jester's own voice (voice/service.js) from the main process's side: Kokoro, on
 * this computer.
 *
 * The model holds about a gigabyte while it's loaded, so it's loaded when
 * someone starts talking to him (warm) or he has something to say, and let go
 * after IDLE_MS without a line. Loading takes under half a second, about what it
 * takes to say his name.
 *
 * Not on a server, which has the memory to spare and takes four times as long to
 * load it (2.4 s on his, 2026-11-21: the first line after three quiet minutes
 * waited for that every time). There it's kept (`idleMs: null`).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { kokoroInstalled, voiceNamed } from './voice/voices.js';

const SERVICE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'voice/service.js');
const IDLE_MS = 3 * 60 * 1000;
/** A line is a sentence or so, and takes well under a second: one that takes this long never will. */
const LINE_MS = 15000;
/** After this many loads in a row came to nothing, it's left alone for REST_MS: the computer's voice does meanwhile. */
const FAILURES = 2;
const REST_MS = 10 * 60 * 1000;

/**
 * @param {object} deps
 * @param {(file:string) => {postMessage:Function, on:Function, kill:Function, stderr?:any}} deps.fork  starts the service
 * @param {() => string} [deps.voice]  the voice Settings names (voices.js)
 * @param {() => boolean} [deps.installed]
 * @param {number|null} [deps.idleMs]  how long it's kept without a line; null, for good
 * @param {number} [deps.threads]  how many make a line; the service decides, without (voices.js kokoroThreads)
 */
export function startKokoro({ fork, voice = () => undefined, installed = kokoroInstalled, idleMs = IDLE_MS, lineMs = LINE_MS, threads = 0, log = () => undefined, now = Date.now }) {
  let service = null;
  let accent = null;
  let idleTimer = null;
  let lines = 0;
  let failures = 0;
  let restingUntil = 0;
  /** Lines asked for and not yet made: id → {resolve, reject, limit}. */
  const waiting = new Map();

  const settle = (id, how, value) => {
    const line = waiting.get(id);
    if (!line) return;
    waiting.delete(id);
    clearTimeout(line.limit);
    line[how](value);
  };

  function unload(why = '') {
    clearTimeout(idleTimer);
    const child = service;
    service = null;
    accent = null;
    for (const id of [...waiting.keys()]) settle(id, 'reject', new Error(why || 'The voice was let go'));
    child?.kill();
  }

  function rest() {
    clearTimeout(idleTimer);
    if (idleMs === null || idleMs === Infinity) return;
    idleTimer = setTimeout(() => {
      if (waiting.size) return rest();
      log(`voice: let go after ${Math.round(idleMs / 60000)} idle minutes`);
      unload();
    }, idleMs);
    idleTimer.unref?.();
  }

  /** `named`: a line's own voice (a server's, made here: cloud-link.js), rather than the one Settings names. */
  function load(named = voice()) {
    const wanted = voiceNamed(named).accent;
    // Another accent is another pronunciation list: it's loaded afresh, once nothing's being made.
    if (service && accent !== wanted && !waiting.size) unload();
    if (service) return service;
    if (!installed() || now() < restingUntil) return null;
    const child = fork(SERVICE);
    service = child;
    accent = wanted;
    child.stderr?.on('data', (chunk) => log('voice:', String(chunk).trim().slice(0, 300)));
    child.on('message', (message) => {
      if (service !== child) return;
      if (message?.type === 'ready') {
        failures = 0;
        return log(`voice loaded: Kokoro (${message.accent}), ${message.loadMs} ms${message.threads ? `, ${message.threads} threads` : ''}`);
      }
      if (message?.type === 'sound') return settle(message.id, 'resolve', { bytes: message.bytes, type: message.mime, seconds: message.seconds, tookMs: message.tookMs });
      if (message?.type === 'error') {
        log('voice error:', message.detail);
        if (message.id !== undefined) return settle(message.id, 'reject', new Error(message.detail));
        // It never loaded: nothing it's asked will come.
        failed(child);
      }
    });
    child.on('exit', (code) => {
      if (service !== child) return;
      log('voice service exited', code);
      failed(child);
    });
    child.postMessage({ type: 'start', accent: wanted, ...(threads > 0 ? { threads } : {}) });
    rest();
    return child;
  }

  function failed(child) {
    if (service !== child) return;
    failures += 1;
    if (failures >= FAILURES) {
      restingUntil = now() + REST_MS;
      failures = 0;
      log(`voice: Kokoro isn’t starting; the computer’s voice for ${Math.round(REST_MS / 60000)} minutes`);
    }
    unload('The voice stopped');
  }

  return {
    /** 'ready' (Kokoro speaks) | 'missing' (the model isn't downloaded) | 'resting' (it wouldn't start) */
    get state() {
      if (!installed()) return 'missing';
      return now() < restingUntil ? 'resting' : 'ready';
    },
    get loaded() {
      return !!service;
    },
    /** Loads it ahead of the first line: someone's started talking to him. `voice`: for that one of his voices. */
    warm(named) {
      if (load(named)) rest();
    },
    /**
     * A line's sound. `tight`: it runs on into the next with no pause written, so none is left at its end. `speed`:
     * how fast against his usual 1, kept between 0.88 and 1.15. `voice`: which of his voices (voices.js), when it isn't
     * the one Settings names here.
     * @returns {Promise<{bytes:Uint8Array, type:string, seconds:number, tookMs:number}|null>} null when Kokoro isn't there
     */
    sound(text, { signal, tight = false, speed = 1, voice: named = voice() } = {}) {
      const child = load(named);
      if (!child || signal?.aborted) return Promise.resolve(null);
      lines += 1;
      const id = lines;
      const chosen = voiceNamed(named);
      return new Promise((resolve, reject) => {
        const drop = () => {
          if (service === child) child.postMessage({ type: 'drop', id });
          settle(id, 'resolve', null);
        };
        signal?.addEventListener('abort', drop, { once: true });
        const done = (finish) => (value) => {
          signal?.removeEventListener('abort', drop);
          finish(value);
        };
        const limit = setTimeout(() => {
          if (service === child) child.postMessage({ type: 'drop', id });
          settle(id, 'reject', new Error('The voice took too long'));
        }, lineMs);
        waiting.set(id, { resolve: done(resolve), reject: done(reject), limit });
        // Never far from his usual: a voice sped up or slowed much isn't his.
        const pace = Math.min(1.15, Math.max(0.88, Number(speed) || 1));
        child.postMessage({ type: 'say', id, text, sid: chosen.sid, ...(tight ? { tight: true } : {}), ...(pace === 1 ? {} : { speed: pace }) });
        rest();
      });
    },
    /** Quitting, or the assistant switched off. */
    stop() {
      unload();
    }
  };
}
