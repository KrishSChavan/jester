/**
 * Running a script folder's program: never through a shell, always in its own
 * folder, with the arguments script-manifest.js built. Two ways:
 *
 *   plainly   the program runs once per command, as it would in a terminal
 *   served    the manifest's "serve" arguments start it once, and it stays,
 *             taking commands as JSON lines, one at a time:
 *               ← {"serve": 1}                                   first, to say it's ready
 *               → {"id": 1, "args": ["off", "Bedside"]}
 *               ← {"id": 1, "code": 0, "out": "...", "err": "...", "state": {...}}
 *               ← {"event": "state", "state": {...}}             unasked: something changed
 *             It's how the lights skip finding and logging in to a bulb on
 *             every command (2–3 s → 0.3–1 s, measured 2026-11-18). A program
 *             that doesn't say it's ready, or dies early, is run plainly for a
 *             while instead; one that leaves when it's idle is started again
 *             on the next command.
 *
 * Its PATH has Homebrew's folders, which an app opened from the Dock doesn't, and
 * none of Electron's own variables.
 */

import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process';
import nodeFs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

/** A served program has this long to say it's ready. */
const READY_MS = 8000;
/** Served, and asked nothing for this long: stopped (the program should leave sooner itself). */
const IDLE_MS = 5 * 60 * 1000;
/** A served program that failed is left alone this long, and commands run plainly. */
const BROKEN_MS = 10 * 60 * 1000;
/** What's kept of a command's output: a script that prints a novel is cut short. */
const MOST_OUTPUT = 64 * 1024;
const EXTRA_PATHS = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/** The environment a script runs in. */
export function scriptEnv(base = process.env, platform = process.platform) {
  const env = Object.fromEntries(Object.entries(base).filter(([key]) => !/^ELECTRON_|^NODE_OPTIONS$|^CHROME_/.test(key)));
  if (platform !== 'win32') env.PATH = [...new Set([...(base.PATH || '').split(':').filter(Boolean), ...EXTRA_PATHS])].join(':');
  env.JESTER = '1';
  return env;
}

/**
 * How to start the program: itself when it's executable, else what runs its kind of file. A Python script uses the
 * folder's own .venv when it has one.
 * @returns {{file:string, pre:string[]}|{error:string}}
 */
export function commandFor(folder, run, { fs = nodeFs, platform = process.platform } = {}) {
  const file = path.join(folder, run);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return { error: `${run} isn’t in the folder.` };
  }
  if (!stat.isFile()) return { error: `${run} isn’t a file.` };
  const ext = path.extname(file).toLowerCase();
  const there = (rel) => {
    try {
      return fs.statSync(path.join(folder, rel)).isFile() ? path.join(folder, rel) : '';
    } catch {
      return '';
    }
  };
  if (platform === 'win32') {
    if (ext === '.ps1') return { file: 'powershell.exe', pre: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file] };
    if (ext === '.py') return { file: there('.venv/Scripts/python.exe') || there('venv/Scripts/python.exe') || 'python', pre: [file] };
    if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return { file: 'node', pre: [file] };
    if (ext === '.exe') return { file, pre: [] };
    return { error: `Jester can’t run ${path.basename(file)} on Windows: use a .ps1, .py, .js or .exe.` };
  }
  if (ext === '.py') return { file: there('.venv/bin/python') || there('venv/bin/python') || '/usr/bin/env', pre: there('.venv/bin/python') || there('venv/bin/python') ? [file] : ['python3', file] };
  if (ext === '.sh' || ext === '.bash') return { file: '/bin/bash', pre: [file] };
  if (ext === '.zsh') return { file: '/bin/zsh', pre: [file] };
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return { file: '/usr/bin/env', pre: ['node', file] };
  if (ext === '.applescript' || ext === '.scpt') return { file: '/usr/bin/osascript', pre: [file] };
  if (ext === '.rb') return { file: '/usr/bin/env', pre: ['ruby', file] };
  // eslint-disable-next-line no-bitwise
  if (!(stat.mode & 0o111)) return { error: `${run} isn’t executable: make it so with chmod +x, or name it .sh, .py or .js.` };
  return { file, pre: [] };
}

const cut = (text) => (text.length > MOST_OUTPUT ? `${text.slice(0, MOST_OUTPUT)}\n…` : text);

/**
 * One script's program, run plainly or served.
 * @param {object} deps
 * @param {string} deps.folder
 * @param {object} deps.manifest  script-manifest.js's
 * @param {(state:object) => void} [deps.onState]  a served program said what's on, unasked
 * @param {(...parts:any[]) => void} [deps.log]
 */
export function createScriptRunner({ folder, manifest, onState = () => undefined, log = () => undefined, spawn = nodeSpawn, execFile = nodeExecFile, fs = nodeFs, env = scriptEnv(), platform = process.platform, now = Date.now }) {
  const name = manifest.name;
  let server = null;
  let brokenAt = -Infinity;
  let serial = 0;

  function start() {
    const command = commandFor(folder, manifest.run, { fs, platform });
    if (command.error) throw Object.assign(new Error(command.error), { code: 'not_runnable' });
    return command;
  }

  /** Once, plainly: what it printed and its exit code. */
  function runPlainly(args, timeoutMs) {
    const command = start();
    return new Promise((resolve) => {
      execFile(command.file, [...command.pre, ...args], { cwd: folder, env, timeout: timeoutMs, maxBuffer: 4 * MOST_OUTPUT, windowsHide: true, killSignal: 'SIGTERM' }, (err, stdout, stderr) => {
        const out = cut(String(stdout ?? ''));
        const errText = cut(String(stderr ?? ''));
        if (!err) return resolve({ code: 0, out, err: errText });
        if (err.killed || err.signal) return resolve({ code: 124, out, err: `${errText}\n${name} took longer than ${Math.round(timeoutMs / 1000)} seconds, so Jester stopped it.`.trim() });
        if (err.code === 'ENOENT' || err.code === 'EACCES') return resolve({ code: 126, out, err: `Jester couldn’t start ${manifest.run}: ${err.code === 'ENOENT' ? 'what runs it isn’t installed' : 'it isn’t allowed to run'}.` });
        resolve({ code: Number.isInteger(err.code) ? err.code : 1, out, err: errText || String(err.message || '') });
      });
    });
  }

  /**
   * A served program let go of: not the one commands go to any more, from this moment, and stopped. Whatever it
   * still owes an answer is answered when it's gone (finish). Without this, a command sent between the kill and
   * the exit went to a program on its way out, and was lost unanswered.
   */
  function retire(me) {
    me.dead = true;
    if (server === me) server = null;
    me.child.kill();
  }

  /** The served program, started if it isn't running: resolves once it's said it's ready. */
  function served() {
    if (server && !server.dead) return server.ready;
    const command = start();
    const child = spawn(command.file, [...command.pre, ...manifest.serve], { cwd: folder, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const waiting = new Map();
    let errTail = '';
    let idle = null;
    const me = { child, waiting, ready: null, used: now() };
    server = me;
    const finish = (why) => {
      clearTimeout(idle);
      if (server === me) server = null;
      for (const [, entry] of waiting) {
        clearTimeout(entry.timer);
        entry.resolve({ code: 1, out: '', err: `${name} stopped before it answered${why ? ` (${why})` : ''}.`, lost: true });
      }
      waiting.clear();
    };
    me.idle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        log(`scripts: ${name}: idle, stopped`);
        retire(me);
      }, IDLE_MS);
    };
    me.ready = new Promise((resolve, reject) => {
      const early = setTimeout(() => {
        brokenAt = now();
        retire(me);
        reject(new Error(`${name} didn’t say it was ready`));
      }, READY_MS);
      // Anything a program prints is taken as it comes: a line that isn't a JSON object (a stray print(42)) is
      // passed over, and nothing in here may throw, or it would be the main process's uncaught exception.
      readline.createInterface({ input: child.stdout }).on('line', (line) => {
        try {
          const message = JSON.parse(line);
          if (!message || typeof message !== 'object' || Array.isArray(message)) return;
          if ('serve' in message && !('id' in message)) {
            clearTimeout(early);
            me.wasReady = true;
            me.idle();
            return resolve(me);
          }
          if (message.event === 'state' && message.state && typeof message.state === 'object') return onState(message.state);
          const entry = waiting.get(message.id);
          if (!entry) return;
          waiting.delete(message.id);
          clearTimeout(entry.timer);
          entry.resolve({ code: Number.isInteger(message.code) ? message.code : 1, out: cut(String(message.out ?? '')), err: cut(String(message.err ?? '')), ...(message.state && typeof message.state === 'object' ? { state: message.state } : {}) });
        } catch (err) {
          log(`scripts: ${name}: a line it printed couldn’t be taken (${err.message})`);
        }
      });
      child.stderr.on('data', (chunk) => {
        errTail = (errTail + chunk).slice(-2000);
      });
      child.on('error', (err) => {
        clearTimeout(early);
        brokenAt = now();
        finish(err.code || err.message);
        reject(err);
      });
      child.on('exit', (code, signal) => {
        clearTimeout(early);
        log(`scripts: ${name}: served program left (${signal || code})${errTail ? `: ${errTail.trim().split('\n').at(-1).slice(0, 160)}` : ''}`);
        // Leaving before it was ever ready is a program that can't be served.
        if (!me.wasReady) brokenAt = now();
        finish(signal || (code ? `exit ${code}` : ''));
        reject(new Error(`${name} left before it was ready`));
      });
    });
    me.ready.catch(() => undefined);
    // The pipe to a program that's gone: its error is the exit's to report.
    child.stdin.on('error', () => undefined);
    return me.ready;
  }

  async function runServed(args, timeoutMs) {
    let me = await served();
    // Let go of while this waited for it (stuck on the command before, or idle): a new one takes it.
    if (me.dead) me = await served();
    me.used = now();
    me.idle();
    const id = ++serial;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        me.waiting.delete(id);
        resolve({ code: 124, out: '', err: `${name} took longer than ${Math.round(timeoutMs / 1000)} seconds to answer.` });
        // A program stuck on one command would answer the next with this one's reply: the next starts afresh.
        retire(me);
      }, timeoutMs);
      me.waiting.set(id, { resolve, timer });
      me.child.stdin.write(`${JSON.stringify({ id, args })}\n`);
    });
  }

  return {
    get serving() {
      return !!server && !server.dead;
    },
    /**
     * Runs one command line: served when the manifest says it can be, and that's working; else plainly.
     * @returns {Promise<{code:number, out:string, err:string, state?:object}>}
     */
    async run(args, { timeoutMs = manifest.timeout * 1000 } = {}) {
      if (manifest.serve && now() - brokenAt > BROKEN_MS) {
        try {
          const answer = await runServed(args, timeoutMs);
          // Gone mid-command: whether it was done isn't known, so it's said as it is rather than run again.
          return answer;
        } catch (err) {
          if (err?.code === 'not_runnable') return { code: 126, out: '', err: err.message };
          log(`scripts: ${name}: can’t be served (${err.message}), so it runs plainly`);
        }
      }
      try {
        return await runPlainly(args, timeoutMs);
      } catch (err) {
        return { code: 126, out: '', err: err.message };
      }
    },
    /** Stops a served program. */
    close() {
      if (server) retire(server);
    }
  };
}
