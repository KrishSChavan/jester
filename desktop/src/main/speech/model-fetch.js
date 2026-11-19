/**
 * Fetching what he hears and speaks with. The models come from sherpa-onnx's own release page: they're too big to
 * keep in git or ship inside the app, so Jester downloads them himself the first time he's opened (main.js), and
 * `npm run models` does the same from a checkout (scripts/fetch-models.mjs). Both use this.
 *
 * One at a time, in the order asked for. A download that stops is carried on from where it stopped (a `.part` file
 * beside where the model goes) rather than started over: his voice is 350 MB. An archive is unpacked beside the
 * models and moved into place whole, so a half-unpacked model is never taken for one that's there. tar unpacks the
 * .tar.bz2 archives; macOS and Windows 10+ both ship one.
 *
 * Plain Node, no Electron: the script runs it too.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const RELEASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/';
/** Their spelling. */
const VOICE_RELEASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/';
const TTS_RELEASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/';

/**
 * `file`: fetched as it is. `archive`: a .tar.bz2 that unpacks to a folder of the same name. `size`: the download,
 * in bytes, for a percentage before the server has said (2026-11-19). `label`: what it is, as Settings says it.
 */
export const MODEL_FILES = Object.freeze({
  vad: { file: 'silero_vad.onnx', size: 643854, label: 'what tells speech from silence' },
  voice: { file: 'nemo_en_titanet_small.onnx', release: VOICE_RELEASE, size: 40257283, label: 'what tells your voice from anyone else’s' },
  'moonshine-tiny': { archive: 'sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27.tar.bz2', size: 29858559, label: 'a small recognizer' },
  kroko: { archive: 'sherpa-onnx-streaming-zipformer-en-kroko-2025-08-06.tar.bz2', size: 57267600, label: 'a streaming recognizer' },
  'parakeet-110m': { archive: 'sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8.tar.bz2', size: 108035095, label: 'what he hears with' },
  'parakeet-0.6b': { archive: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2', size: 482440461, label: 'the Accurate recognizer' },
  // Jester's own voice (Kokoro v1.0, Apache-2.0).
  kokoro: { archive: 'kokoro-multi-lang-v1_0.tar.bz2', release: TTS_RELEASE, size: 349886476, label: 'his own voice' }
});

/**
 * What a new Jester fetches for himself, in the order it's useful: he can hear once the first two are here (about
 * 110 MB), tell the user's voice after the third, and speaks with the computer's voice until the last.
 */
export const FIRST_SET = Object.freeze(['vad', 'parakeet-110m', 'voice', 'kokoro']);

const folderOf = (model) => model.archive.replace(/\.tar\.bz2$/, '');

/** The same models, fetched from somewhere else: a mirror, or a test's own server (main.js JESTER_MODELS_URL). */
export function modelsAt(base) {
  const from = String(base).replace(/\/?$/, '/');
  return Object.fromEntries(Object.entries(MODEL_FILES).map(([key, model]) => [key, { ...model, release: from, size: 0 }]));
}

/** Where a model is once fetched: its file, or the folder its archive unpacks to. */
export function modelPath(key, dir) {
  const model = MODEL_FILES[key];
  if (!model) throw new Error(`Unknown model "${key}". Known: ${Object.keys(MODEL_FILES).join(', ')}`);
  return path.join(dir, model.file || folderOf(model));
}

/** Whether a model's been fetched. */
export function modelFetched(key, dir) {
  try {
    return fs.existsSync(modelPath(key, dir));
  } catch {
    return false;
  }
}

/** Windows' own tar: one from Git or MSYS earlier on the PATH reads "C:\…" as a host called C. */
function tarProgram(platform = process.platform, env = process.env) {
  if (platform !== 'win32') return 'tar';
  const own = path.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'tar.exe');
  return fs.existsSync(own) ? own : 'tar';
}

/** Unpacks a .tar.bz2 into a folder. */
export function untar(archive, into) {
  return new Promise((resolve, reject) => {
    execFile(tarProgram(), ['-xjf', archive, '-C', into], { windowsHide: true, maxBuffer: 1024 * 1024 }, (err, _out, stderr) => {
      if (!err) return resolve();
      reject(new Error(err.code === 'ENOENT' ? 'This computer has no tar to unpack it with.' : `Couldn’t unpack it: ${String(stderr || err.message).trim().split('\n').pop().slice(0, 200)}`));
    });
  });
}

/**
 * One file, to `target`, carried on from `target.part` when there's one.
 * @param {string} url
 * @param {string} target
 * @param {{fetchImpl?:typeof fetch, signal?:AbortSignal, size?:number, onBytes?:(got:number, total:number) => void}} [options]
 */
export async function download(url, target, { fetchImpl = fetch, signal, size = 0, onBytes = () => undefined } = {}) {
  const part = `${target}.part`;
  let have = fs.statSync(part, { throwIfNoEntry: false })?.size || 0;
  let response = await fetchImpl(url, { redirect: 'follow', signal, headers: have ? { Range: `bytes=${have}-` } : {} });
  // Nothing left to send, or a part that's no part of this file: start it over.
  if (have && response.status === 416) {
    await response.body?.cancel().catch(() => undefined);
    fs.rmSync(part, { force: true });
    have = 0;
    response = await fetchImpl(url, { redirect: 'follow', signal });
  }
  if (!response.ok) throw new Error(`The server answered ${response.status}.`);
  // A server that ignores the range sends the whole file again.
  if (have && response.status !== 206) have = 0;
  const coming = Number(response.headers.get('content-length')) || 0;
  const total = coming ? have + coming : size;
  const out = fs.openSync(part, have ? 'a' : 'w');
  let got = have;
  try {
    onBytes(got, total);
    for await (const chunk of response.body) {
      fs.writeSync(out, chunk);
      got += chunk.length;
      onBytes(got, total);
    }
  } finally {
    fs.closeSync(out);
  }
  if (coming && got !== total) throw new Error('The download stopped before the end.');
  fs.renameSync(part, target);
}

/** How long before a download that failed is tried again by itself: the network may only have been away. */
const RETRY_MS = [30 * 1000, 2 * 60 * 1000, 10 * 60 * 1000];
/** Progress is told this often at most. */
const TELL_MS = 400;

const reason = (err) => {
  const said = String(err?.cause?.code || err?.code || '');
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENETUNREACH|ETIMEDOUT|UND_ERR/.test(said) || /fetch failed|network/i.test(String(err?.message))) return 'No connection to download it over.';
  if (said === 'ENOSPC') return 'There isn’t room on the disk for it.';
  return String(err?.message || err || 'It didn’t download.').slice(0, 200);
};

/**
 * @param {object} deps
 * @param {string} deps.dir  where models are kept
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {(archive:string, into:string) => Promise<void>} [deps.unpack]
 * @param {(done:string|null) => void} [deps.onChange]  progress, or (with a model's key) one's arrived
 * @param {(...parts:any[]) => void} [deps.log]
 * @param {Record<string, {file?:string, archive?:string, release?:string, size?:number, label?:string}>} [deps.models]
 * @param {number[]} [deps.retryMs]  [] never tries again by itself
 */
export function createModelFetcher({ dir, fetchImpl = fetch, unpack = untar, onChange = () => undefined, log = () => undefined, models = MODEL_FILES, retryMs = RETRY_MS, now = Date.now }) {
  /** Keys still to fetch, the one being fetched first. */
  const queue = [];
  /** The one being fetched: { key, got, total, unpacking }. */
  let current = null;
  let error = '';
  let failures = 0;
  let running = false;
  let controller = null;
  let retry = null;
  let toldAt = 0;

  const here = (key) => {
    const model = models[key];
    return !!model && fs.existsSync(path.join(dir, model.file || folderOf(model)));
  };

  /** Tells his window: every so often as bytes come, and at once (`sure`) when something changes or arrives. */
  function tell(arrived = null, sure = false) {
    if (!arrived && !sure && now() - toldAt < TELL_MS) return;
    toldAt = now();
    onChange(arrived);
  }

  async function fetchOne(key, signal) {
    const model = models[key];
    fs.mkdirSync(dir, { recursive: true });
    const name = model.file || model.archive;
    const target = path.join(dir, name);
    await download((model.release || RELEASE) + name, target, {
      fetchImpl,
      signal,
      size: model.size,
      onBytes: (got, total) => {
        current = { key, got, total, unpacking: false };
        tell();
      }
    });
    if (model.file) return;
    current = { ...current, unpacking: true };
    tell(null, true);
    // Unpacked out of the way, then moved in whole: a folder that's there is a model that's all there.
    const staging = path.join(dir, `.unpacking-${key}`);
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    try {
      await unpack(target, staging);
      const folder = folderOf(model);
      if (!fs.existsSync(path.join(staging, folder))) throw new Error('It unpacked to something else than expected.');
      fs.rmSync(path.join(dir, folder), { recursive: true, force: true });
      fs.renameSync(path.join(staging, folder), path.join(dir, folder));
    } catch (err) {
      // An archive that won't unpack is no use kept: the next try downloads it again.
      fs.rmSync(target, { force: true });
      throw err;
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
    fs.rmSync(target, { force: true });
  }

  async function run() {
    if (running) return;
    running = true;
    clearTimeout(retry);
    retry = null;
    try {
      while (queue.length) {
        const key = queue[0];
        if (here(key)) {
          queue.shift();
          continue;
        }
        controller = new AbortController();
        current = { key, got: 0, total: models[key].size || 0, unpacking: false };
        error = '';
        tell(null, true);
        try {
          await fetchOne(key, controller.signal);
        } catch (err) {
          current = null;
          if (controller.signal.aborted) {
            log('models: stopped fetching', key);
            return;
          }
          error = reason(err);
          log('models: couldn’t fetch', key, '·', err?.message || err);
          const wait = retryMs[Math.min(failures, retryMs.length - 1)];
          failures += 1;
          if (wait !== undefined) {
            retry = setTimeout(run, wait);
            retry.unref?.();
          }
          return;
        }
        failures = 0;
        current = null;
        queue.shift();
        log('models: fetched', key);
        tell(key);
      }
    } finally {
      running = false;
      controller = null;
      tell(null, true);
    }
  }

  return {
    /** Fetches these, after any already asked for: those that aren't here. */
    want(keys) {
      for (const key of keys) {
        if (!models[key]) throw new Error(`Unknown model "${key}". Known: ${Object.keys(models).join(', ')}`);
        if (!here(key) && !queue.includes(key)) queue.push(key);
      }
      failures = 0;
      error = '';
      const going = run();
      return { state: this.state(), done: going };
    },
    /** Stops, keeping what's come so far for another time. */
    stop() {
      queue.length = 0;
      clearTimeout(retry);
      retry = null;
      controller?.abort();
      error = '';
    },
    has: here,
    get busy() {
      return running;
    },
    /** For his window: what's being fetched and how far it's got, what's waiting, and why it stopped if it did. */
    state() {
      const model = current ? models[current.key] : null;
      return {
        fetching: current
          ? {
              id: current.key,
              label: model?.label || current.key,
              got: current.got,
              total: current.total,
              percent: current.total ? Math.min(100, Math.floor((current.got / current.total) * 100)) : 0,
              unpacking: !!current.unpacking
            }
          : null,
        waiting: queue.filter((key) => key !== current?.key),
        error
      };
    }
  };
}

/** "46 of 108 MB". */
export function megabytes(got, total) {
  const mb = (bytes) => Math.round(bytes / 1048576);
  return total ? `${mb(got)} of ${mb(total)} MB` : `${mb(got)} MB`;
}

/** How a fetch stands, in a sentence, or '' when nothing's being fetched or has failed. */
export function fetchWords(state) {
  if (!state) return '';
  if (state.fetching) {
    const { label, got, total, percent, unpacking } = state.fetching;
    const more = state.waiting.length ? `, then ${state.waiting.length} more` : '';
    return unpacking ? `Unpacking ${label}${more}…` : `Downloading ${label}: ${percent}% (${megabytes(got, total)})${more}.`;
  }
  if (state.error) return `The download stopped. ${state.error}`;
  return '';
}
