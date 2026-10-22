/**
 * A spoken command, carried out. voice-commands.js says what was meant; this
 * does it — dispatch.js for the actions gestures share, jester-driver for
 * keys, text, clicks and apps, and the OS's own tools for the rest (`open`,
 * `osascript`, `shortcuts`). A sentence of several steps runs them in order,
 * waiting for an app to come to the front before anything is typed into it,
 * and stops at the first that fails. The outcome is one line for the pill.
 */

import { execFile } from 'node:child_process';
import { appCatalog, findApp, installedApps } from './apps.js';
import { describePlan } from './os-actions.js';
import { matchApp, parseSequence } from './voice-commands.js';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Windows' volume keys move it 2% a press. */
const WIN_VOLUME_STEP = 2;
/** The running apps, read when listening starts, are still good this long. */
const CATALOG_MS = 10000;
/** How often, and how many times, to look for an app coming to the front (~5 s). */
const FRONT_POLL_MS = 150;
const FRONT_TRIES = 33;
/** Once in front, an app just started needs a moment before it takes keys. */
const SETTLE_MS = 400;
const INPUT = new Set(['type', 'press', 'click']);

/** Where each new thing is made: that app, then its New shortcut. Email is a mailto: link everywhere. */
const NEW_IN = {
  darwin: { note: 'Notes', message: 'Messages', reminder: 'Reminders', event: 'Calendar' },
  win32: { note: 'Notepad' }
};
const NEW_LABELS = { note: 'New note', email: 'New email', message: 'New message', reminder: 'New reminder', event: 'New event', document: 'New document' };

const SEARCHES = {
  web: { name: 'Google', url: (query) => `https://www.google.com/search?q=${encodeURIComponent(query)}` },
  youtube: { name: 'YouTube', url: (query) => `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}` },
  spotify: { name: 'Spotify', url: (query) => `spotify:search:${encodeURIComponent(query)}` }
};

/** Runs a program; resolves with what it printed, rejects with its complaint. */
export function runFile(file, args, { timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout }, (error, stdout, stderr) => (error ? reject(new Error(String(stderr || error.message).trim())) : resolve(String(stdout))));
  });
}

/**
 * What to type for dictated text. A few words are usually for a search box,
 * where the recognizer's closing full stop doesn't belong.
 */
export function dictation(text) {
  const trimmed = String(text).trim();
  return trimmed.split(/\s+/).length <= 4 && /^[^.!?]*\.$/.test(trimmed) ? trimmed.slice(0, -1) : trimmed;
}

/**
 * @param {object} deps
 * @param {{call: Function}} deps.driver
 * @param {(action:string, options:object) => Promise<{ok:boolean, label:string, detail:string}>} deps.dispatch
 * @param {() => boolean} deps.canPost  false until macOS allows Accessibility
 * @param {(op:string) => void} deps.onJester  calibrate, settings
 * @param {(file:string, args:string[]) => Promise<string>} [deps.run]  runs open, osascript, shortcuts
 * @param {(platform:string) => object[]} [deps.installed]
 * @param {string} [deps.platform]
 * @param {(...parts:any[]) => void} [deps.log]
 * @param {(ms:number) => Promise<void>} [deps.wait]
 */
export function createVoiceRunner({ driver, dispatch, canPost, onJester, run = runFile, installed = installedApps, platform = process.platform, log = () => undefined, wait = pause }) {
  const mac = platform === 'darwin';
  const primary = mac ? 'cmd' : 'ctrl';
  /** `front`: the names of an app this step brought forward, for the next step to wait on. */
  const ok = (text, front) => ({ ok: true, text, ...(front ? { front } : {}) });
  const bad = (text) => ({ ok: false, text });
  let catalog = null;

  const needsInput = (command) =>
    INPUT.has(command.kind) ||
    (command.kind === 'minimize' && !command.app) ||
    (command.kind === 'new' && command.item !== 'email') ||
    (!mac && ['volume', 'open'].includes(command.kind));
  const key = (name, ...modifiers) => driver.call('key', { key: name, modifiers });
  /** Opens a link with whatever handles it: the browser, Spotify, the mail app. */
  const openUrl = (url) => (mac ? run('open', [url]) : run('rundll32.exe', ['url.dll,FileProtocolHandler', url]));

  async function shortcutNames() {
    const listed = await run('shortcuts', ['list']).catch(() => '');
    return listed.split('\n').map((line) => line.trim()).filter(Boolean);
  }

  /** Whether an app going by one of `names` reaches the front. */
  async function cameToFront(names) {
    const wanted = names.map((name) => name.toLowerCase());
    for (let tries = FRONT_TRIES; tries > 0; tries--) {
      const front = await driver.call('frontmost').catch(() => null);
      if (wanted.includes(String(front?.app?.name || '').toLowerCase())) return true;
      await wait(FRONT_POLL_MS);
    }
    return false;
  }

  async function perform(command, apps) {
    switch (command.kind) {
      case 'action': {
        const outcome = await dispatch(command.action, { source: 'voice', quiet: true });
        return outcome.ok ? ok(outcome.label) : bad(`${outcome.label}: ${outcome.detail}`);
      }
      case 'volume':
        if (mac) await run('osascript', ['-e', `set volume output volume ${command.level} without output muted`]);
        else {
          // No key sets a level: all the way down, then up to it.
          for (let i = 0; i < 100 / WIN_VOLUME_STEP; i++) await driver.call('media', { key: 'volumeDown' });
          for (let i = 0; i < Math.round(command.level / WIN_VOLUME_STEP); i++) await driver.call('media', { key: 'volumeUp' });
        }
        return ok(`Volume ${command.level}%`);
      case 'open': {
        const app = findApp(apps, command.app);
        const name = app?.names[0] || command.app;
        if (mac) {
          await run('open', ['-a', app?.path || command.app]);
          return ok(app?.running ? `Switched to ${name}` : `Opening ${name}`, app?.names || [command.app]);
        }
        if (app?.running) {
          await driver.call('activateApp', { pid: app.pid });
          return ok(`Switched to ${name}`, app.names);
        }
        // The Start menu finds an app by name as it is typed.
        await key('escape', 'ctrl');
        await wait(500);
        await driver.call('text', { text: command.heard });
        await wait(800);
        await key('enter');
        return ok(`Opening ${command.heard}`, [command.heard]);
      }
      case 'new': {
        const label = NEW_LABELS[command.item];
        if (command.item === 'email') {
          await openUrl('mailto:');
          return ok(label);
        }
        if (command.item === 'document') {
          await key('n', primary);
          return ok(`${label} (${describePlan({ kind: 'key', key: 'n', modifiers: [primary] }, platform)})`);
        }
        const home = NEW_IN[platform]?.[command.item];
        if (!home) return bad(`Jester can’t make a ${command.item} here yet.`);
        const opened = await perform({ kind: 'open', app: home, heard: home.toLowerCase() }, apps);
        if (!(await cameToFront(opened.front))) return bad(`${home} didn’t come to the front, so Jester stopped.`);
        await wait(SETTLE_MS);
        await key('n', primary);
        await wait(SETTLE_MS);
        return ok(label);
      }
      case 'quit': {
        const app = findApp(apps, command.app);
        if (!app?.running) return bad(`${app?.names[0] || command.app} isn’t open.`);
        await driver.call('quitApp', { pid: app.pid });
        return ok(`Quitting ${app.names[0]}`);
      }
      case 'minimize': {
        if (command.app) {
          const app = findApp(apps, command.app);
          if (!app?.running) return bad(`${app?.names[0] || command.heard} isn’t open.`);
          await driver.call('hideApp', { pid: app.pid });
          return ok(`${mac ? 'Hid' : 'Minimized'} ${app.names[0]}`);
        }
        const plan = mac ? { kind: 'key', key: 'm', modifiers: ['cmd'] } : { kind: 'key', key: 'down', modifiers: ['win'] };
        await key(plan.key, ...plan.modifiers);
        return ok(`Minimize (${describePlan(plan, platform)})`);
      }
      case 'type': {
        const text = dictation(command.text);
        await driver.call('text', { text });
        return ok(`Typed “${text}”`);
      }
      case 'press': {
        await key(command.key, ...command.modifiers);
        const keys = describePlan({ kind: 'key', key: command.key, modifiers: command.modifiers }, platform);
        return ok(command.label ? `${command.label} (${keys})` : `Pressed ${keys}`);
      }
      case 'click':
        await driver.call('click', { button: command.button, count: command.count });
        return ok(command.count === 2 ? 'Double-click' : command.button === 'right' ? 'Right-click' : 'Click');
      case 'play': {
        // Spotify where it's there to search, else YouTube in the browser.
        const spotify = findApp(apps, 'Spotify');
        const service = command.service || (spotify && (mac || spotify.running) ? 'spotify' : 'youtube');
        await openUrl(SEARCHES[service].url(command.query));
        // Starting one song means pressing Play in the app, which takes the
        // assistant (phase 6); until then the pill says what's left to do.
        return ok(`Searching ${SEARCHES[service].name} for “${command.query}”: pick one to play`);
      }
      case 'search':
        await openUrl(SEARCHES[command.site].url(command.query));
        return ok(`Searching ${SEARCHES[command.site].name} for “${command.query}”`);
      case 'shortcut': {
        // The same forgiving match as app names: shortcuts are named by people.
        const name = matchApp(command.name, await shortcutNames());
        if (!name) return bad(`No shortcut called “${command.name}”.`);
        // A shortcut can run for minutes; it is started, not waited for.
        run('shortcuts', ['run', name]).catch((err) => log('shortcut failed:', name, err.message));
        return ok(`Running “${name}”`);
      }
      case 'jester':
        onJester(command.op);
        return ok(command.op === 'calibrate' ? 'Calibrating' : 'Opening Settings');
      default:
        return bad(`“${command.text}” isn’t a command Jester knows yet.`);
    }
  }

  async function readCatalog() {
    const running = await driver.call('apps').then((reply) => reply.apps || []).catch(() => []);
    return appCatalog(installed(platform), running);
  }

  /** Each step in turn; the next waits for an app the last one brought forward. */
  async function performSteps(steps, apps) {
    const done = [];
    for (const [i, step] of steps.entries()) {
      let outcome;
      try {
        outcome = await perform(step, apps);
      } catch (err) {
        log('voice command failed:', err.message);
        outcome = bad(`Didn’t go through: ${err.message}`);
      }
      if (!outcome.ok) return bad([...done, outcome.text].join(' · '));
      done.push(outcome.text);
      if (outcome.front && i < steps.length - 1) {
        if (!(await cameToFront(outcome.front))) return bad([...done, `${outcome.front[0]} didn’t come to the front, so Jester stopped`].join(' · '));
        await wait(SETTLE_MS);
      }
    }
    return ok(done.join(' · '));
  }

  return {
    /** Read the apps while the user talks, so the command needn't wait for them. */
    prepare() {
      catalog = { at: Date.now(), apps: readCatalog() };
    },
    /** @returns {Promise<{steps:object[], outcome:{ok:boolean, text:string}|null}>} null: nothing to say */
    async run(text) {
      const apps = catalog && Date.now() - catalog.at < CATALOG_MS ? await catalog.apps : await readCatalog();
      catalog = null;
      const steps = parseSequence(text, { apps: apps.flatMap((app) => app.names), platform });
      log('voice:', JSON.stringify(text), '→', JSON.stringify(steps));
      if (steps.some((step) => step.kind === 'cancel')) return { steps, outcome: null };
      // Half a sentence is not done: "open Spotify and do a little dance" does nothing.
      const unknown = steps.find((step) => step.kind === 'unknown');
      if (unknown) {
        const said = steps.length > 1 ? `Jester doesn’t know how to “${unknown.text}” yet, so it did nothing.` : `“${unknown.text}” isn’t a command Jester knows yet.`;
        return { steps, outcome: bad(said) };
      }
      if (steps.some(needsInput) && !canPost()) return { steps, outcome: bad('Allow Accessibility in Jester’s Settings first.') };
      return { steps, outcome: await performSteps(steps, apps) };
    }
  };
}
