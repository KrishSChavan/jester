/**
 * The app's side of jester-driver (native/jester-driver): spawn it, send it
 * JSON lines, match the replies to the requests by id.
 *
 * Coordinates: the driver takes the OS's own — points on macOS, which is
 * what Electron's `screen` reports there, and physical pixels on Windows,
 * which `toOsPoint` converts to from Electron's DIPs.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXE = process.platform === 'win32' ? 'jester-driver.exe' : 'jester-driver';
const CRATE = path.resolve(here, '../../native/jester-driver');

/** When the driver's sources last changed: a build older than that is out of date. */
function sourcesChanged(crate) {
  const files = ['Cargo.toml', 'Cargo.lock', ...fs.readdirSync(path.join(crate, 'src')).map((name) => path.join('src', name))];
  return Math.max(...files.map((file) => fs.statSync(path.join(crate, file), { throwIfNoEntry: false })?.mtimeMs ?? 0));
}

/**
 * The built driver: inside the app when packaged, else the release build
 * while it's up to date, else the newest cargo build. A debug build is
 * unoptimized, and `cargo build` or `cargo test` leave one newer than the
 * release build, which the app then ran.
 */
export function driverPath({ resourcesPath = null, crate = CRATE } = {}) {
  if (resourcesPath) return path.join(resourcesPath, EXE);
  const [release, debug] = ['release', 'debug'].map((profile) => path.join(crate, 'target', profile, EXE)).map((file) => (fs.existsSync(file) ? file : null));
  if (!release && !debug) throw new Error('jester-driver is not built; run: npm run driver');
  if (!release || !debug) return release || debug;
  const built = (file) => fs.statSync(file).mtimeMs;
  return built(release) >= sourcesChanged(crate) || built(release) >= built(debug) ? release : debug;
}

/** Electron DIPs to the driver's coordinates. `screen` is Electron's. */
export function toOsPoint(screen, point, platform = process.platform) {
  return platform === 'win32' ? screen.dipToScreenPoint(point) : { x: point.x, y: point.y };
}

/** A frame the driver reported ({x, y, w, h}) in Electron's DIPs. */
export function toDipFrame(screen, frame, platform = process.platform) {
  if (!frame) return null;
  if (platform !== 'win32') return { x: frame.x, y: frame.y, w: frame.w, h: frame.h };
  const rect = screen.screenToDipRect(null, { x: frame.x, y: frame.y, width: frame.w, height: frame.h });
  return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
}

/** A frame in Electron's DIPs ({x, y, w, h}) in the driver's coordinates. */
export function toOsFrame(screen, frame, platform = process.platform) {
  if (platform !== 'win32') return { x: frame.x, y: frame.y, w: frame.w, h: frame.h };
  const rect = screen.dipToScreenRect(null, { x: frame.x, y: frame.y, width: frame.w, height: frame.h });
  return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
}

/**
 * Commands that may take longer than most. A snapshot waits up to 3 s for a
 * Chromium app to build its tree (mac.rs WAKE_TIME), so it can't share the
 * 3 s default; placing a window may wait out a full-screen animation;
 * scrolling to an end goes a page at a time.
 */
const SLOW_MS = { snapshot: 8000, act: 8000, menu: 6000, window: 4000, placeWindow: 8000 };

/**
 * @param {object} [options]
 * @param {string} [options.binary]
 * @param {boolean} [options.dryRun]  describe input instead of posting it
 * @param {number} [options.timeoutMs]  per request; accessibility queries can be slow
 * @param {(code:number|null, signal:string|null) => void} [options.onExit]
 */
export function startDriver({ binary = driverPath(), dryRun = false, timeoutMs = 3000, onExit } = {}) {
  const child = spawn(binary, dryRun ? ['--dry-run'] : [], { stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  let nextId = 1;
  let exited = false;

  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let reply;
    try {
      reply = JSON.parse(line);
    } catch {
      return;
    }
    const waiter = pending.get(reply.id);
    if (!waiter) return;
    pending.delete(reply.id);
    clearTimeout(waiter.timer);
    if (reply.ok) waiter.resolve(reply);
    else waiter.reject(new Error(reply.error || 'jester-driver failed'));
  });

  child.on('exit', (code, signal) => {
    exited = true;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`jester-driver exited (${signal || code})`));
    }
    pending.clear();
    onExit?.(code, signal);
  });

  /** One request; resolves with the reply (`{ok: true, ...}`), rejects with its error. */
  function call(cmd, params = {}) {
    if (exited) return Promise.reject(new Error('jester-driver is not running'));
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Object.assign(new Error(`jester-driver: "${cmd}" timed out`), { code: 'timeout' }));
      }, Math.max(timeoutMs, SLOW_MS[cmd] || 0));
      pending.set(id, { resolve, reject, timer });
      // The request's own id last: a parameter can't take its place.
      child.stdin.write(`${JSON.stringify({ ...params, id, cmd })}\n`);
    });
  }

  return {
    call,
    close() {
      if (!exited) child.stdin.end();
    },
    get running() {
      return !exited;
    }
  };
}
