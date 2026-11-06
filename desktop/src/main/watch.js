/**
 * The Apple Watch, steering the cursor: this side of the Bluetooth helper
 * (native/jester-watch), which proves each frame came from the paired watch
 * and passes on what it said, as JSON lines over stdio.
 *
 * It only runs while "Steer with your watch" is on, because the first run
 * is what makes macOS ask about Bluetooth. A helper that dies is restarted a
 * few times, not forever: one that macOS kills would otherwise be killed again
 * and again.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXE = 'jester-watch-bridge';
/** Time to look at both screens; after this, pairing needs asking for again. */
export const PAIR_WINDOW_MS = 120000;
const RESTART_MS = 2000;
const MAX_RESTARTS = 3;

/** The built helper, or null: inside the app when packaged, else `npm run watch`'s. */
export function bridgePath({ resourcesPath = null, platform = process.platform } = {}) {
  if (platform !== 'darwin') return null;
  const file = resourcesPath ? path.join(resourcesPath, EXE) : path.resolve(here, '../../native/jester-watch/build', EXE);
  return fs.existsSync(file) ? file : null;
}

/**
 * @param {object} deps
 * @param {string|null} [deps.binary]
 * @param {string[]} [deps.args]
 * @param {() => Promise<string|undefined>} deps.loadKey
 * @param {(key:string) => Promise<void>} deps.saveKey
 * @param {() => Promise<void>} deps.forgetKey
 * @param {(report:{yaw:number,pitch:number,ms:number,steering:boolean,click:boolean,held:boolean,whole:boolean,typing:boolean}) => void} deps.onReport
 * @param {() => void} [deps.onChange]  `state` changed
 * @param {number} [deps.pairWindowMs]
 * @param {(...parts:any[]) => void} [deps.log]
 */
export function createWatch({ binary = bridgePath(), args = [], loadKey, saveKey, forgetKey, onReport, onChange = () => undefined, pairWindowMs = PAIR_WINDOW_MS, log = () => undefined }) {
  const state = {
    built: !!binary,
    /** A shared key is saved. */
    paired: false,
    /** 'on', 'off', 'denied', 'unsupported', 'failed', 'starting', or '' with the helper stopped. */
    bluetooth: '',
    /** Something is connected, and it may yet be nothing to do with you. */
    nearby: 0,
    /** A frame from the paired watch has been proved. */
    connected: false,
    steering: false,
    /** While pairing: 'waiting', then the code to compare. */
    pairing: null,
    problem: ''
  };
  let wanted = false;
  let child = null;
  let starting = false;
  let restarts = 0;
  let pairTimer = null;
  let restartTimer = null;

  function update(changes) {
    if (Object.entries(changes).every(([key, value]) => state[key] === value)) return;
    Object.assign(state, changes);
    onChange();
  }

  function send(message) {
    child?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function endPairing(changes = {}) {
    clearTimeout(pairTimer);
    update({ pairing: null, ...changes });
  }

  function released() {
    if (state.steering) onReport({ steering: false });
  }

  const handlers = {
    bluetooth: ({ state: bluetooth, detail }) => {
      if (detail) log('watch bluetooth:', detail);
      update({ bluetooth });
    },
    nearby: ({ count }) => {
      if (count) return update({ nearby: count });
      released();
      return update({ nearby: 0, connected: false, steering: false });
    },
    motion: (report) => {
      const steering = !!report.steering;
      // A helper sees motion before it sees anyone leave.
      if (!state.connected || state.steering !== steering) update({ connected: true, steering, problem: '' });
      onReport(report);
    },
    code: ({ code }) => update({ pairing: String(code) }),
    paired: async ({ key }) => {
      try {
        await saveKey(key);
        endPairing({ paired: true, problem: '' });
      } catch (err) {
        log('watch key:', err.message);
        endPairing({ problem: 'Couldn’t save the pairing. Try it again.' });
      }
    },
    pairFailed: () => endPairing({ problem: 'Pairing failed. Try it again.' }),
    stranger: () => update({ problem: state.paired ? 'A watch that isn’t paired tried to connect.' : '' })
  };

  async function begin() {
    if (child || starting || !wanted || !binary) return;
    starting = true;
    const key = await loadKey();
    starting = false;
    if (child || !wanted) return;
    const run = spawn(binary, args, { stdio: ['pipe', 'pipe', 'inherit'] });
    child = run;
    update({ bluetooth: 'starting' });
    run.stdin.on('error', () => undefined);
    run.on('error', (err) => log('watch helper:', err.message));
    readline.createInterface({ input: run.stdout }).on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (run === child) handlers[message.event]?.(message);
    });
    run.on('exit', (code, signal) => {
      if (run !== child) return;
      child = null;
      released();
      endPairing({ bluetooth: '', nearby: 0, connected: false, steering: false });
      log('watch helper exited', signal || code);
      if (restarts >= MAX_RESTARTS) return update({ problem: 'The watch’s Bluetooth helper keeps stopping.' });
      restarts += 1;
      restartTimer = setTimeout(begin, RESTART_MS);
    });
    send({ cmd: 'start', ...(key ? { key } : {}) });
  }

  function halt() {
    const run = child;
    child = null;
    released();
    endPairing({ bluetooth: '', nearby: 0, connected: false, steering: false });
    run?.stdin.end();
  }

  loadKey().then((key) => update({ paired: !!key }), () => undefined);

  return {
    state,
    /** Idempotent: main.js calls this on every refresh. */
    setEnabled(on) {
      if (on === wanted) return;
      wanted = on;
      restarts = 0;
      if (on) {
        update({ problem: '' });
        begin();
      } else {
        halt();
      }
    },
    pair() {
      if (!child) return;
      update({ pairing: 'waiting', problem: '' });
      send({ cmd: 'pair' });
      clearTimeout(pairTimer);
      pairTimer = setTimeout(() => {
        send({ cmd: 'cancel' });
        endPairing({ problem: 'Pairing timed out. Try it again.' });
      }, pairWindowMs);
    },
    /** You've seen the same code on both screens. */
    confirm() {
      if (/^\d{6}$/.test(state.pairing || '')) send({ cmd: 'confirm' });
    },
    cancel() {
      send({ cmd: 'cancel' });
      endPairing();
    },
    async forget() {
      send({ cmd: 'forget' });
      await forgetKey();
      released();
      update({ paired: false, connected: false, steering: false, problem: '' });
    },
    close() {
      wanted = false;
      clearTimeout(pairTimer);
      clearTimeout(restartTimer);
      child?.stdin.end();
      child = null;
    }
  };
}
