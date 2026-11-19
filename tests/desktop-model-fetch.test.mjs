/**
 * Fetching what he hears and speaks with (desktop/src/main/speech/model-fetch.js): downloads that carry on from
 * where they stopped, archives unpacked whole or not at all, and what his window is told as it goes.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createModelFetcher, download, fetchWords, FIRST_SET, megabytes, MODEL_FILES, modelFetched, modelPath, modelsAt } from '../desktop/src/main/speech/model-fetch.js';

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jester-models-'));

/** A fetch that serves these bodies by URL, honouring Range, and can stop a body short once. */
function server(files, { cutAt = null, status = null } = {}) {
  const asked = [];
  let cut = cutAt;
  const fetchImpl = async (url, { headers = {}, signal } = {}) => {
    asked.push({ url, range: headers.Range || '' });
    if (status?.[url]) return new Response('no', { status: status[url] });
    const whole = files[url];
    if (!whole) return new Response('not found', { status: 404 });
    const from = headers.Range ? Number(/bytes=(\d+)-/.exec(headers.Range)[1]) : 0;
    if (from >= whole.length) return new Response('', { status: 416 });
    const rest = whole.subarray(from);
    const stopAfter = cut !== null ? cut : null;
    cut = null;
    let sent = false;
    const body = new ReadableStream({
      // A connection that drops: what came before it is delivered, then the read fails.
      pull(controller) {
        if (stopAfter === null) return;
        if (!sent) {
          sent = true;
          return controller.enqueue(rest.subarray(0, stopAfter));
        }
        controller.error(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }));
      },
      start(controller) {
        if (stopAfter !== null) return;
        // In a few pieces, as a network would send it.
        const piece = Math.max(1, Math.ceil(rest.length / 3));
        for (let at = 0; at < rest.length; at += piece) controller.enqueue(rest.subarray(at, at + piece));
        controller.close();
      }
    });
    signal?.throwIfAborted?.();
    return new Response(body, { status: from ? 206 : 200, headers: { 'content-length': String(rest.length) } });
  };
  return { fetchImpl, asked };
}

/** A .tar.bz2 holding one folder with these files, as sherpa-onnx's release page has them. */
function archive(folder, entries) {
  const dir = scratch();
  fs.mkdirSync(path.join(dir, folder));
  for (const [name, text] of Object.entries(entries)) fs.writeFileSync(path.join(dir, folder, name), text);
  const file = path.join(dir, `${folder}.tar.bz2`);
  execFileSync('tar', ['-cjf', file, '-C', dir, folder]);
  return fs.readFileSync(file);
}

const BASE = 'https://models.test/';
const MODELS = {
  vad: { file: 'vad.onnx', release: BASE, label: 'what tells speech from silence' },
  ears: { archive: 'ears.tar.bz2', release: BASE, label: 'what he hears with' },
  voice: { archive: 'voice.tar.bz2', release: BASE, label: 'his own voice' }
};

test('the first set is what a recognizer needs, in the order it becomes useful', () => {
  assert.deepEqual([...FIRST_SET], ['vad', 'parakeet-110m', 'voice', 'kokoro']);
  for (const key of FIRST_SET) assert.ok(MODEL_FILES[key].size > 0, key);
  // The recognizer's folder is the one speech/models.js looks for.
  assert.equal(path.basename(modelPath('parakeet-110m', '/m')), 'sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8');
  assert.equal(path.basename(modelPath('kokoro', '/m')), 'kokoro-multi-lang-v1_0');
  assert.throws(() => modelPath('nope', '/m'), /Unknown model/);
  assert.equal(modelFetched('nope', '/m'), false);
});

test('a mirror serves the same files from another address', () => {
  const mirrored = modelsAt('http://127.0.0.1:9000/models');
  assert.equal(mirrored.kokoro.release, 'http://127.0.0.1:9000/models/');
  assert.equal(mirrored.kokoro.archive, MODEL_FILES.kokoro.archive);
  assert.equal(mirrored.vad.file, 'silero_vad.onnx');
});

test('a file is downloaded to its place, through a .part that goes when it is whole', async () => {
  const dir = scratch();
  const bytes = Buffer.from('a voice activity detector, more or less');
  const { fetchImpl } = server({ [`${BASE}vad.onnx`]: bytes });
  const seen = [];
  await download(`${BASE}vad.onnx`, path.join(dir, 'vad.onnx'), { fetchImpl, onBytes: (got, total) => seen.push([got, total]) });
  assert.deepEqual(fs.readFileSync(path.join(dir, 'vad.onnx')), bytes);
  assert.equal(fs.existsSync(path.join(dir, 'vad.onnx.part')), false);
  assert.deepEqual(seen.at(-1), [bytes.length, bytes.length]);
});

test('a download that stopped carries on from where it stopped', async () => {
  const dir = scratch();
  const bytes = Buffer.from('0123456789'.repeat(50));
  const target = path.join(dir, 'vad.onnx');
  const { fetchImpl, asked } = server({ [`${BASE}vad.onnx`]: bytes }, { cutAt: 120 });
  await assert.rejects(download(`${BASE}vad.onnx`, target, { fetchImpl }));
  assert.equal(fs.statSync(`${target}.part`).size, 120);
  assert.equal(fs.existsSync(target), false);
  await download(`${BASE}vad.onnx`, target, { fetchImpl });
  assert.equal(asked[1].range, 'bytes=120-');
  assert.deepEqual(fs.readFileSync(target), bytes);
});

test('a part that is no part of the file is thrown away and the file fetched whole', async () => {
  const dir = scratch();
  const bytes = Buffer.from('short');
  const target = path.join(dir, 'vad.onnx');
  fs.writeFileSync(`${target}.part`, 'far more than the whole file holds');
  const { fetchImpl, asked } = server({ [`${BASE}vad.onnx`]: bytes });
  await download(`${BASE}vad.onnx`, target, { fetchImpl });
  assert.equal(asked.length, 2);
  assert.equal(asked[1].range, '');
  assert.deepEqual(fs.readFileSync(target), bytes);
});

test('a server that says no is an error, and nothing is left looking like a model', async () => {
  const dir = scratch();
  const { fetchImpl } = server({}, {});
  await assert.rejects(download(`${BASE}vad.onnx`, path.join(dir, 'vad.onnx'), { fetchImpl }), /404/);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => !name.endsWith('.part')), []);
});

test('models are fetched one after another, archives unpacked into their folders', async () => {
  const dir = scratch();
  const { fetchImpl, asked } = server({
    [`${BASE}vad.onnx`]: Buffer.from('vad'),
    [`${BASE}ears.tar.bz2`]: archive('ears', { 'tokens.txt': 'a b c', 'encoder.onnx': 'weights' }),
    [`${BASE}voice.tar.bz2`]: archive('voice', { 'model.onnx': 'more weights' })
  });
  const told = [];
  let fetcher;
  fetcher = createModelFetcher({ dir, fetchImpl, models: MODELS, retryMs: [], now: () => 0, onChange: (arrived) => told.push(arrived || fetcher.state().fetching?.id || 'idle') });
  assert.equal(fetcher.has('ears'), false);
  await fetcher.want(['vad', 'ears', 'voice']).done;
  assert.deepEqual(asked.map((request) => request.url), [`${BASE}vad.onnx`, `${BASE}ears.tar.bz2`, `${BASE}voice.tar.bz2`]);
  assert.equal(fs.readFileSync(path.join(dir, 'ears', 'tokens.txt'), 'utf8'), 'a b c');
  assert.equal(fs.readFileSync(path.join(dir, 'voice', 'model.onnx'), 'utf8'), 'more weights');
  // Nothing of the fetching is left behind: no archive, no part, no staging folder.
  assert.deepEqual(fs.readdirSync(dir).sort(), ['ears', 'vad.onnx', 'voice']);
  assert.ok(fetcher.has('ears') && fetcher.has('voice') && fetcher.has('vad'));
  // Each arrival was told by name, so the app can start using it.
  assert.deepEqual(told.filter((entry) => ['vad', 'ears', 'voice'].includes(entry) && told.indexOf(entry) !== -1).filter((entry, i, all) => all.indexOf(entry) === i), ['vad', 'ears', 'voice']);
  assert.deepEqual(fetcher.state(), { fetching: null, waiting: [], error: '' });
  // Asked for again, there's nothing to fetch.
  await fetcher.want(['vad', 'ears']).done;
  assert.equal(asked.length, 3);
});

test('while one downloads, his window is told which, how far, and what waits', async () => {
  const dir = scratch();
  const { fetchImpl } = server({ [`${BASE}vad.onnx`]: Buffer.from('v'.repeat(400)), [`${BASE}ears.tar.bz2`]: archive('ears', { 'tokens.txt': 'x' }) });
  const states = [];
  let fetcher;
  fetcher = createModelFetcher({ dir, fetchImpl, models: MODELS, retryMs: [], now: () => states.length * 1000, onChange: () => states.push(fetcher.state()) });
  await fetcher.want(['vad', 'ears']).done;
  const during = states.find((state) => state.fetching?.id === 'vad' && state.fetching.got > 0);
  assert.equal(during.fetching.label, 'what tells speech from silence');
  assert.equal(during.fetching.total, 400);
  assert.deepEqual(during.waiting, ['ears']);
  assert.ok(states.some((state) => state.fetching?.id === 'ears' && state.fetching.unpacking));
  assert.equal(fetchWords(during).startsWith('Downloading what tells speech from silence: '), true);
  assert.match(fetchWords(during), /then 1 more\.$/);
});

test('a download that fails says why, keeps its place, and goes again when asked', async () => {
  const dir = scratch();
  const files = { [`${BASE}vad.onnx`]: Buffer.from('vad'), [`${BASE}ears.tar.bz2`]: archive('ears', { 'tokens.txt': 'x' }) };
  const broken = server(files, { status: { [`${BASE}ears.tar.bz2`]: 503 } });
  const good = server(files);
  let use = broken.fetchImpl;
  const fetcher = createModelFetcher({ dir, fetchImpl: (...args) => use(...args), models: MODELS, retryMs: [] });
  await fetcher.want(['vad', 'ears']).done;
  assert.equal(fetcher.has('vad'), true);
  assert.equal(fetcher.has('ears'), false);
  assert.match(fetcher.state().error, /503/);
  assert.equal(fetchWords(fetcher.state()), 'The download stopped. The server answered 503.');
  use = good.fetchImpl;
  await fetcher.want(['ears']).done;
  assert.equal(fetcher.has('ears'), true);
  assert.equal(fetcher.state().error, '');
});

test('no connection is said as that, not as a stack of error codes', async () => {
  const dir = scratch();
  const fetchImpl = async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  };
  const fetcher = createModelFetcher({ dir, fetchImpl, models: MODELS, retryMs: [] });
  await fetcher.want(['vad']).done;
  assert.equal(fetcher.state().error, 'No connection to download it over.');
});

test('an archive that will not unpack is not taken for a model, and is fetched afresh next time', async () => {
  const dir = scratch();
  const { fetchImpl, asked } = server({ [`${BASE}ears.tar.bz2`]: Buffer.from('this is not a bzip2 archive at all') });
  const fetcher = createModelFetcher({ dir, fetchImpl, models: MODELS, retryMs: [] });
  await fetcher.want(['ears']).done;
  assert.equal(fetcher.has('ears'), false);
  assert.match(fetcher.state().error, /unpack/i);
  assert.deepEqual(fs.readdirSync(dir), []);
  await fetcher.want(['ears']).done;
  assert.equal(asked.length, 2);
  assert.equal(asked[1].range, '');
});

test('an unpack that leaves the wrong folder is refused', async () => {
  const dir = scratch();
  const { fetchImpl } = server({ [`${BASE}ears.tar.bz2`]: archive('something-else', { 'tokens.txt': 'x' }) });
  const fetcher = createModelFetcher({ dir, fetchImpl, models: MODELS, retryMs: [] });
  await fetcher.want(['ears']).done;
  assert.equal(fetcher.has('ears'), false);
  assert.match(fetcher.state().error, /something else/);
});

test('stopping keeps what has come, for another time', async () => {
  const dir = scratch();
  const bytes = Buffer.from('z'.repeat(900));
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const fetchImpl = async (_url, { signal }) => {
    const body = new ReadableStream({
      async start(controller) {
        controller.enqueue(bytes.subarray(0, 300));
        signal.addEventListener('abort', () => controller.error(signal.reason));
        await held;
      }
    });
    return new Response(body, { status: 200, headers: { 'content-length': String(bytes.length) } });
  };
  const fetcher = createModelFetcher({ dir, fetchImpl, models: MODELS, retryMs: [] });
  const going = fetcher.want(['vad', 'ears']).done;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(fetcher.state().fetching.id, 'vad');
  fetcher.stop();
  await going;
  release();
  assert.deepEqual(fetcher.state(), { fetching: null, waiting: [], error: '' });
  assert.equal(fs.statSync(path.join(dir, 'vad.onnx.part')).size, 300);
  assert.equal(fetcher.busy, false);
});

test('an unknown model is refused before anything is fetched', () => {
  const fetcher = createModelFetcher({ dir: scratch(), fetchImpl: async () => assert.fail('nothing should be fetched'), models: MODELS, retryMs: [] });
  assert.throws(() => fetcher.want(['parakeet-9000']), /Unknown model/);
});

test('megabytes read as people say them', () => {
  assert.equal(megabytes(48 * 1048576, 103 * 1048576), '48 of 103 MB');
  assert.equal(megabytes(5 * 1048576, 0), '5 MB');
  assert.equal(fetchWords(null), '');
  assert.equal(fetchWords({ fetching: null, waiting: [], error: '' }), '');
  assert.equal(fetchWords({ fetching: { label: 'his own voice', got: 0, total: 0, percent: 0, unpacking: true }, waiting: [], error: '' }), 'Unpacking his own voice…');
});
