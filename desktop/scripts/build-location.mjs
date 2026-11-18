/**
 * Builds native/jester-location (macOS): the Node-API module that asks Location Services from inside Jester
 * (src/main/mac-location.js), since Electron's own location never asks macOS. Built with the Xcode command line
 * tools' clang, for Apple silicon and Intel both, and remade only when its source changes. jester-app.mjs builds it
 * too, so `npm run app`, `npm run dev:mac`, `npm start` and `npm run launcher` all leave it ready.
 *
 *   npm run location
 */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(import.meta.url);
const folder = path.resolve(path.dirname(here), '../native/jester-location');
export const SOURCE = path.join(folder, 'location.m');
export const ADDON = path.join(folder, 'build/jester-location.node');

/** clang's arguments for building `source` into `out`. */
export function clangArgs(source, out) {
  return [
    'clang', '-bundle', '-fobjc-arc', '-O2', '-Wall', '-mmacosx-version-min=12.0',
    '-arch', 'arm64', '-arch', 'x86_64',
    // Node-API's functions come from the process it's loaded into (Electron, or Node).
    '-Wl,-undefined,dynamic_lookup',
    '-framework', 'Foundation', '-framework', 'CoreLocation',
    '-o', out, source
  ];
}

/**
 * The module's path, built first if it's missing or its source has changed since.
 * @param {{source?:string, out?:string, log?:(line:string)=>void}} [options]
 */
export function buildLocation({ source = SOURCE, out = ADDON, log = (line) => console.log(line) } = {}) {
  if (process.platform !== 'darwin') throw new Error('jester-location is for macOS.');
  const made = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  const stamp = `${out}.source`;
  const have = fs.existsSync(out) && fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8').trim() : '';
  if (have === made) return out;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const building = `${out}.building`;
  const result = spawnSync('xcrun', clangArgs(source, building), { encoding: 'utf8' });
  if (result.status !== 0) {
    fs.rmSync(building, { force: true });
    const why = (result.stderr || result.error?.message || '').trim();
    throw new Error(`Couldn’t build jester-location (it needs the Xcode command line tools: xcode-select --install). ${why}`);
  }
  // Swapped in whole: a Jester that's running keeps the one it loaded.
  fs.renameSync(building, out);
  fs.writeFileSync(stamp, `${made}\n`);
  log(`Built ${out}.`);
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === here) {
  try {
    let said = false;
    const out = buildLocation({ log: (line) => ((said = true), console.log(line)) });
    if (!said) console.log(`${out} is up to date.`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
