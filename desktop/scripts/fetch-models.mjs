/**
 * Download speech models into desktop/models/.
 *
 *   node scripts/fetch-models.mjs [name ...]   (no names: the default set)
 *
 * They come from sherpa-onnx's own release page and are too big for git. tar
 * unpacks the .tar.bz2 archives; macOS and Windows 10+ both ship one.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const RELEASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/';

export const MODELS = {
  vad: { file: 'silero_vad.onnx' },
  'moonshine-tiny': { archive: 'sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27.tar.bz2' },
  kroko: { archive: 'sherpa-onnx-streaming-zipformer-en-kroko-2025-08-06.tar.bz2' },
  'parakeet-110m': { archive: 'sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8.tar.bz2' },
  'parakeet-0.6b': { archive: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2' }
};
const DEFAULT_SET = ['vad', 'moonshine-tiny'];

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../models');

async function download(name, target) {
  const response = await fetch(RELEASE + name, { redirect: 'follow' });
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  const temp = `${target}.part`;
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temp));
  fs.renameSync(temp, target);
}

async function fetchModel(key) {
  const model = MODELS[key];
  if (!model) throw new Error(`Unknown model "${key}". Known: ${Object.keys(MODELS).join(', ')}`);
  fs.mkdirSync(dir, { recursive: true });
  if (model.file) {
    const target = path.join(dir, model.file);
    if (!fs.existsSync(target)) await download(model.file, target);
    return target;
  }
  const folder = path.join(dir, model.archive.replace(/\.tar\.bz2$/, ''));
  if (fs.existsSync(folder)) return folder;
  const archive = path.join(dir, model.archive);
  await download(model.archive, archive);
  execFileSync('tar', ['-xjf', archive, '-C', dir]);
  fs.rmSync(archive);
  return folder;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const keys = process.argv.slice(2);
  for (const key of keys.length ? keys : DEFAULT_SET) {
    console.log(`${key}: ${await fetchModel(key)}`);
  }
}
