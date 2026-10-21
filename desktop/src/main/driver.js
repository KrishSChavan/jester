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

/** The built driver: inside the app when packaged, else the newest cargo build. */
export function driverPath({ resourcesPath = null } = {}) {
  if (resourcesPath) return path.join(resourcesPath, EXE);
  const builds = ['release', 'debug']
    .map((profile) => path.resolve(here, '../../native/jester-driver/target', profile, EXE))
    .filter((file) => fs.existsSync(file))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!builds.length) throw new Error('jester-driver is not built; run: npm run driver');
  return builds[0];
}

/** Electron DIPs to the driver's coordinates. `screen` is Electron's. */
export function toOsPoint(screen, point, platform = process.platform) {
  return platform === 'win32' ? screen.dipToScreenPoint(point) : { x: point.x, y: point.y };
}

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
        reject(new Error(`jester-driver: "${cmd}" timed out`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, cmd, ...params })}\n`);
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
