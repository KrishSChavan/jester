/**
 * This Mac's position, from Location Services, asked in Jester's own process (native/jester-location).
 *
 * Electron's navigator.geolocation waits for macOS to allow it but never asks: Chrome asks from a part of Chromium
 * that Electron leaves out. So the hidden page that asked (main.js locateByPage) waited until it gave up, and macOS
 * never put its question to the user. Here Jester asks for himself: the first time, macOS asks whether "Jester" may
 * use the Mac's location; once allowed, a position comes from Core Location directly.
 *
 * The answer has the page's shape, so whereabouts.js takes either: {ok, lat, lon, accuracy}, or {ok:false, code},
 * code 1 not allowed (or Location Services off), 2 no position to be had, 3 not in time; with `asking` when it's
 * macOS's question that wasn't answered in time.
 *
 * The question is put with Jester in front (`front`). He lives in the menu bar, and asked from there, at launch or
 * when he was spoken to, macOS never showed it: the user, 2026-11-19, had to switch Location off and on in his
 * Settings, with his window in front, before it came. And it's put again every few seconds until it's answered, in
 * case the first was asked before he'd got to the front.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ADDON = path.resolve(here, '../../native/jester-location/build/jester-location.node');
const require = createRequire(import.meta.url);

/** Core Location's "denied" (kCLErrorDenied); its other errors mean no position just now. */
const CL_DENIED = 1;
const POLL_MS = 200;
/** Unanswered, macOS's question is put again this often: a second asking while it's up does nothing. */
const REASK_MS = 3000;

/**
 * The native module, or null: not a Mac, or not built (npm run location; npm run app and the launcher build it).
 * @param {{file?:string, platform?:string, log?:(...parts:any[]) => void}} [options]
 */
export function loadMacLocation({ file = ADDON, platform = process.platform, log = () => undefined } = {}) {
  if (platform !== 'darwin') return null;
  try {
    return require(file);
  } catch (err) {
    log('location: no Location Services module, so the page asks instead:', err.message);
    return null;
  }
}

/**
 * A `locate` for whereabouts.js, reading the native module.
 * @param {object} deps
 * @param {{status:() => string, ask:() => string, locate:() => number, latest:() => any}} deps.native
 * @param {() => (void|Promise<void>)} [deps.front]  brings Jester to the front, before macOS is asked
 * @param {() => number} [deps.now]
 * @param {(ms:number) => Promise<void>} [deps.wait]
 */
export function createMacLocate({ native, front = null, now = Date.now, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  return async function locate({ timeoutMs }) {
    const until = now() + timeoutMs;
    let status = native.status();
    if (status === 'not-determined') {
      // macOS's question, for "Jester", put with him in front and waited on as long as the caller will.
      await Promise.resolve(front?.()).catch(() => undefined);
      native.ask();
      let asked = now();
      while (status === 'not-determined' && now() < until) {
        await wait(POLL_MS);
        status = native.status();
        if (status === 'not-determined' && now() - asked >= REASK_MS) {
          native.ask();
          asked = now();
        }
      }
      if (status === 'not-determined') return { ok: false, code: 3, asking: true, message: 'macOS’s question wasn’t answered' };
    }
    if (status !== 'allowed') return { ok: false, code: 1, message: status === 'off' ? 'Location Services are off' : `Location Services: ${status}` };
    const asked = native.locate();
    while (now() < until) {
      await wait(POLL_MS);
      const got = native.latest();
      if (!got || got.request !== asked) continue;
      if (got.error === undefined) return { ok: true, lat: got.lat, lon: got.lon, accuracy: got.accuracy };
      return { ok: false, code: got.code === CL_DENIED ? 1 : 2, message: got.error };
    }
    return { ok: false, code: 3, message: 'no position in time' };
  };
}
