/**
 * A spoken command, carried out. voice-commands.js says what was meant; this
 * does it — dispatch.js for the actions gestures share, jester-driver for
 * keys, text, clicks and apps, and the OS's own tools for the rest (`open`,
 * `osascript`, `shortcuts`). A sentence of several steps runs them in order,
 * waiting for an app to come to the front before anything is typed into it,
 * and stops at the first that fails. The outcome is one line for the pill.
 */

import { execFile } from 'node:child_process';
import { goalWords, hasWord } from './agent/screen.js';
import { appCatalog, findApp, installedApps } from './apps.js';
import { describePlan } from './os-actions.js';
import { asksFirst, matchApp, parseSequence } from './voice-commands.js';

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
/** A search's results take about this long to appear, before the assistant looks. */
const SEARCH_LOAD_MS = 1500;
/** Spotify's results are looked for this often, this many times (~6 s), and a press confirmed as long again. */
const PLAY_POLL_MS = 300;
const PLAY_LOOKS = 20;
const INPUT = new Set(['type', 'press', 'click', 'place']);
const NO_PASSWORDS = 'Jester never types into password fields.';
/** Accessibility roles that are text fields themselves, whatever secure input says. */
const AX_TEXT_ROLES = new Set(['AXTextField', 'AXTextArea', 'AXComboBox', 'AXSearchField']);
/** Windows programs whose file names don't say the app's (squashed spoken name → squashed program name). */
const WIN_PROGRAMS = {
  powerpoint: 'powerpnt',
  word: 'winword',
  microsoftword: 'winword',
  visualstudiocode: 'code',
  vscode: 'code',
  fileexplorer: 'explorer',
  edge: 'msedge',
  microsoftedge: 'msedge',
  teams: 'msteams',
  microsoftteams: 'msteams',
  settings: 'systemsettings',
  calculator: 'calculatorapp',
  paint: 'mspaint',
  commandprompt: 'cmd',
  terminal: 'windowsterminal'
};
/** How far a placed window may be from the size asked before it's said to be as close as it allows. */
const SIZE_SLACK = 24;

/** Where a placed window ends up, in words. */
const PLACED = { left: 'left half', right: 'right half', full: 'full size', center: 'centered' };
const SCREEN_NAMES = { laptop: 'laptop screen', monitor: 'monitor', other: 'other screen' };
const JESTER_SAID = { calibrate: 'Calibrating', settings: 'Opening Settings', sleep: 'Going to sleep' };

/**
 * Where a window goes in a display's usable area (Electron's workArea,
 * {x, y, width, height}): a half, all of it, or its own size in the middle.
 * @param {{w:number, h:number}|null} size  the window's, for the middle
 */
export function frameFor(where, area, size = null) {
  const { x, y, width: w, height: h } = area;
  const half = Math.floor(w / 2);
  if (where === 'left') return { x, y, w: half, h };
  if (where === 'right') return { x: x + half, y, w: w - half, h };
  if (where === 'center') {
    const cw = Math.round(Math.min(size?.w || w * 0.7, w));
    const ch = Math.round(Math.min(size?.h || h * 0.7, h));
    return { x: Math.round(x + (w - cw) / 2), y: Math.round(y + (h - ch) / 2), w: cw, h: ch };
  }
  return { x, y, w, h };
}

const centre = (frame) => ({ x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 });
const holds = (bounds, point) => point.x >= bounds.x && point.x < bounds.x + bounds.width && point.y >= bounds.y && point.y < bounds.y + bounds.height;

/** The display a window is on: the one its middle is in. */
export function displayAt(displays, frame) {
  return frame ? displays.find((display) => holds(display.bounds, centre(frame))) || null : null;
}

/** The display meant: the laptop's own, an external one (the current if it is one), the other one, or the current. */
export function pickDisplay(displays, which, current) {
  if (which === 'laptop') return displays.find((display) => display.internal) || null;
  if (which === 'monitor') return (current && !current.internal ? current : null) || displays.find((display) => !display.internal) || null;
  if (which === 'other') return displays.find((display) => display.id !== current?.id) || null;
  return current;
}

const squashed = (text) => String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** Whether Spotify's screen is the search for `query`: its search box holds those words (an earlier search's page may still show). */
export function searchShown(screen, query) {
  const want = squashed(query);
  return !!want && (screen?.elements || []).some((element) => ['searchfield', 'textfield', 'combobox'].includes(element.role) && squashed(element.value) === want);
}

/**
 * Spotify's search results for `query`: the Play button of what was asked
 * for, by name, else the top result's. Its own play/pause control is just
 * "Play". Nothing until the page is this search's.
 */
export function topResultPlay(screen, query) {
  if (!searchShown(screen, query)) return null;
  const elements = screen?.elements || [];
  const plays = elements.filter((element) => element.role === 'button' && !element.disabled && /^play\s+\S/i.test(element.label || ''));
  const wanted = goalWords(query);
  const words = (element) => `${element.label} ${element.in || ''}`.toLowerCase();
  const named = wanted.length ? plays.find((element) => wanted.every((word) => hasWord(words(element), word))) : null;
  if (named) return named;
  const top = elements.find((element) => /^top result$/i.test(element.label || ''));
  return top ? plays.find((element) => element.id > top.id) || null : null;
}

/** Whether Spotify shows it playing: a Pause control, which (if something played before) names what was asked for. */
export function playingNow(screen, query, wasPlaying) {
  const pauses = (screen?.elements || []).filter((element) => element.role === 'button' && /^pause\b/i.test(element.label || ''));
  if (!pauses.length) return false;
  if (!wasPlaying) return true;
  const wanted = goalWords(query);
  return wanted.length > 0 && pauses.some((element) => wanted.every((word) => hasWord(`${element.label} ${element.in || ''}`.toLowerCase(), word)));
}

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
 * @param {(op:string) => void} deps.onJester  calibrate, settings, sleep
 * @param {(file:string, args:string[]) => Promise<string>} [deps.run]  runs open, osascript, shortcuts
 * @param {(platform:string) => object[]} [deps.installed]
 * @param {string} [deps.platform]
 * @param {(...parts:any[]) => void} [deps.log]
 * @param {(ms:number) => Promise<void>} [deps.wait]
 * @param {object} [deps.assistant]  takes what the matcher can't do (phase 6), when a model is set up:
 *   ready(), run(goal, {note, pick}) → {ok, text, trace?}|null, replay(entry, goal) → {ok, text}|{ok:false, step, detail},
 *   running, cancel()
 * @param {ReturnType<import('./learned.js').createLearned>} [deps.learned]  what's been taught and learned
 * @param {() => {id:number, bounds:object, workArea:object, internal:boolean, primary?:boolean}[]} [deps.displays]
 *   Electron's displays, in DIPs
 * @param {(frame:object) => object} [deps.toOsFrame]  a DIP frame in the driver's coordinates
 * @param {(frame:object) => object} [deps.toDipFrame]  the driver's frame in DIPs
 * @param {(task:Function) => Promise} [deps.quietly]  accessibility reads with Jester's overlays hidden
 */
export function createVoiceRunner({
  driver,
  dispatch,
  canPost,
  onJester,
  run = runFile,
  installed = installedApps,
  platform = process.platform,
  log = () => undefined,
  wait = pause,
  assistant = null,
  learned = null,
  displays = () => [],
  toOsFrame = (frame) => frame,
  toDipFrame = (frame) => frame,
  quietly = (task) => task()
}) {
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

  /**
   * Whether an app going by one of `names` reaches the front. On Windows an
   * app goes by its program file's name, which may not say the app's
   * (PowerPoint is POWERPNT): a few are known, and a window whose title has
   * the name in whole words ("Document1 - Word") counts too — never a name
   * merely inside another ("word" in 1Password).
   */
  async function cameToFront(names) {
    const wanted = names.map((name) => squashed(name)).filter(Boolean);
    const programs = new Set([...wanted, ...wanted.map((word) => WIN_PROGRAMS[word]).filter(Boolean)]);
    const spoken = names.map((name) => String(name).toLowerCase().trim()).filter(Boolean);
    const fits = (front) =>
      programs.has(squashed(front?.app?.name)) ||
      (!mac && spoken.some((name) => name.length >= 3 && name.split(/\s+/).every((word) => hasWord(String(front?.window?.title || '').toLowerCase(), word))));
    for (let tries = FRONT_TRIES; tries > 0; tries--) {
      const front = await driver.call('frontmost').catch(() => null);
      if (fits(front)) return true;
      await wait(FRONT_POLL_MS);
    }
    return false;
  }

  /**
   * Whether the keyboard focus may take dictated words: refused, why. A
   * password field never; and what can't be read is no yes (a timeout is
   * asked again once). macOS's secure input on, with the focus on something
   * that isn't plainly a text field, counts as a password field: a web page's
   * that isn't read yet looks like that.
   */
  async function focusMayTake() {
    for (let tries = 0; tries < 2; tries++) {
      try {
        const focused = await quietly(() => driver.call('focused'));
        const secure = focused?.element?.secure === true || (focused?.secureInput === true && !AX_TEXT_ROLES.has(focused?.element?.role));
        return secure ? bad(NO_PASSWORDS) : null;
      } catch (err) {
        if (/nothing has the keyboard focus/.test(err?.message)) return null;
        if (err?.code !== 'timeout') break;
      }
    }
    return bad('Jester couldn’t tell what has the keyboard focus, so nothing was typed.');
  }

  /**
   * Spotify, showing its search for `query`: the result's Play pressed through
   * accessibility, and its playing confirmed. Null when the result can't be
   * found or pressed (nothing was pressed: the assistant may try). Pressed but
   * not seen playing is said plainly, never pressed again — a second press
   * would pause it.
   */
  async function playOnSpotify(query) {
    if (!(await cameToFront(['Spotify']))) return null;
    const pid = (await driver.call('frontmost').catch(() => null))?.app?.pid;
    if (!pid) return null;
    const read = () => quietly(() => driver.call('snapshot', { pid, limit: 300 })).catch(() => null);
    let screen = null;
    let button = null;
    for (let look = 0; look < PLAY_LOOKS && !button; look++) {
      if (look) await wait(PLAY_POLL_MS);
      screen = await read();
      button = screen && topResultPlay(screen, query);
    }
    if (!button) return null;
    const wasPlaying = playingNow(screen, '', false);
    try {
      await quietly(() => driver.call('act', { snapshot: screen.snapshot, element: button.id, action: 'press' }));
    } catch (err) {
      log('spotify play:', err.message);
      return null;
    }
    const name = button.label.replace(/^play\s+/i, '');
    for (let look = 0; look < PLAY_LOOKS / 2; look++) {
      await wait(PLAY_POLL_MS);
      if (playingNow(await read(), query, wasPlaying)) return ok(`Playing ${name} on Spotify`);
    }
    return ok(`Pressed Play on “${name}” in Spotify, but couldn’t see it start`);
  }

  /**
   * Which app a placement is for. One named is brought forward (opened if it
   * isn't running): moving a window is work the user sees, and what's said
   * next ("…and type hello") is for it.
   */
  async function placeTarget({ app = null, pid = null, name = null, heard = null }, apps) {
    if (pid) return { pid, name };
    let names = null;
    if (app) {
      const matched = findApp(apps, app) || findApp(apps, matchApp(app, apps.flatMap((entry) => entry.names)));
      const opened = await perform({ kind: 'open', app: matched?.names[0] || app, heard: heard || String(app).toLowerCase() }, apps);
      if (!opened.ok || !(await cameToFront(opened.front))) return { problem: `${matched?.names[0] || app} didn’t ${matched?.running ? 'come forward' : 'open'}, so nothing was moved.` };
      if (!matched?.running) await wait(SETTLE_MS);
      names = opened.front;
    }
    const front = (await driver.call('frontmost').catch(() => null))?.app;
    return front?.pid ? { pid: front.pid, name: front.name, names } : { problem: 'There’s no window to move.' };
  }

  /**
   * A window moved: onto the screen meant, into the place meant, and checked
   * — where it landed, never where it was asked to go (a window in its own
   * full-screen space, or one that refuses, stays put).
   */
  async function placeWindow(request, apps) {
    const target = await placeTarget(request, apps);
    if (target.problem) return bad(target.problem);
    const label = target.name || 'The window';
    let shown;
    try {
      shown = await quietly(() => driver.call('window', { pid: target.pid }));
    } catch (err) {
      return bad(`Couldn’t find ${label}’s window: ${err.message}`);
    }
    const all = displays();
    if (!all.length) return bad('There’s no screen to put it on.');
    const frame = toDipFrame(shown.frame);
    const current = displayAt(all, frame) || all.find((display) => display.primary) || all[0];
    const display = pickDisplay(all, request.screen || 'current', current);
    if (!display) return bad(request.screen === 'laptop' ? 'There’s no laptop screen here.' : 'There’s no other screen connected.');
    const where = request.where || 'center';
    // A minimized window's size may be its icon's: the middle gets a sensible size instead.
    const want = frameFor(where, display.workArea, shown.minimized ? null : frame);
    let placed;
    try {
      placed = await quietly(() => driver.call('placeWindow', { pid: target.pid, ...toOsFrame(want), maximize: where === 'full', fullscreen: where === 'fullscreen' }));
    } catch (err) {
      return bad(`Couldn’t move ${label}: ${err.message}`);
    }
    const named = SCREEN_NAMES[request.screen];
    const said = `${label}: ${where === 'fullscreen' ? (mac ? 'full screen' : 'maximized') : PLACED[where]}${named ? ` on the ${named}` : ''}`;
    // The next step waits for this app in front.
    const done = (text) => ok(text, target.names || undefined);
    if (placed.events) return done(`${said} (dry run)`);
    const landed = toDipFrame(placed.frame);
    if (!landed || !holds(display.bounds, centre(landed))) return bad(`${label} didn’t move there: it may be full screen in a space of its own.`);
    if (where === 'fullscreen' && !(mac ? placed.fullscreen : placed.maximized)) return bad(`${label} moved, but couldn’t go full screen.`);
    // A window with a fixed or least size keeps it: said so, not called a half.
    const sized = where === 'fullscreen' || (where === 'full' && !mac && placed.maximized) || (Math.abs(landed.w - want.w) <= SIZE_SLACK && Math.abs(landed.h - want.h) <= SIZE_SLACK);
    return done(sized ? said : `${said}, as near as its size allows`);
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
        // Whatever has the focus gets the words: never a password field.
        const refused = await focusMayTake();
        if (refused) return refused;
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
        // Spotify's top result, pressed and checked, with no model.
        const played = service === 'spotify' ? await playOnSpotify(command.query) : null;
        if (played) return played;
        // Else picking one is left to the assistant, or to the user.
        return { ...ok(`Searching ${SEARCHES[service].name} for “${command.query}”: pick one to play`), pick: true };
      }
      case 'place':
        return placeWindow(command, apps);
      case 'forget': {
        const gone = learned ? await learned.forget(command.phrase) : null;
        return gone ? ok(`Forgot “${command.phrase}”`) : bad(`Jester hadn’t learned “${command.phrase}”.`);
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
        return ok(JESTER_SAID[command.op]);
      default:
        return bad(`“${command.text}” isn’t a command Jester knows yet.`);
    }
  }

  async function readCatalog() {
    const running = await driver.call('apps').then((reply) => reply.apps || []).catch(() => []);
    return appCatalog(installed(platform), running);
  }

  /** Each step in turn; the next waits for an app the last one brought forward. `pick`: a search left to choose from. */
  async function performSteps(steps, apps) {
    const done = [];
    let pick = false;
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
      pick ||= !!outcome.pick;
      if (outcome.front && i < steps.length - 1) {
        if (!(await cameToFront(outcome.front))) return bad([...done, `${outcome.front[0]} didn’t come to the front, so Jester stopped`].join(' · '));
        await wait(SETTLE_MS);
      }
    }
    return { ...ok(done.join(' · ')), ...(pick ? { pick } : {}) };
  }

  const assistantReady = async () => !!assistant && (await assistant.ready().catch(() => false));

  /**
   * The assistant, on what the matcher couldn't do; a task it got done is
   * learned, to be done without it next time. `pick`: a search is waiting for
   * its result to be pressed, which is all that's left to do.
   */
  async function assisted(text, note = '', done = [], { pick = false } = {}) {
    const result = await assistant.run(text, { ...(note ? { note } : {}), ...(pick ? { pick } : {}) });
    if (!result) return null;
    const { trace, ...outcome } = result;
    if (outcome.ok && trace && learned) {
      // A learned way that stopped part way: its first steps were done that way, and the assistant went on from there.
      const kept = await learned.remember(text, [...done, ...trace]).catch((err) => ({ saved: false, why: err.message }));
      log('learned:', JSON.stringify(text), kept.saved ? (kept.known ? 'updated' : 'new') : `not kept (${kept.why})`);
      if (kept.saved && !kept.known) outcome.text = `${outcome.text} · Next time, no AI needed.`;
    }
    return outcome;
  }

  /** @returns {Promise<{steps:object[], outcome:{ok:boolean, text:string}|null}>} null: nothing to say */
  async function runSentence(text, depth = 0, context = {}) {
    // A new command ends a task still running (the assistant hears "stop" and its answers first).
    if (depth === 0 && assistant?.running) await assistant.cancel();
    // A phrase the user taught stands for its sentence.
    const taught = depth === 0 && learned ? await learned.phrase(text).catch(() => null) : null;
    if (taught) {
      log('voice: taught', JSON.stringify(text), '→', JSON.stringify(taught.say));
      return runSentence(taught.say, depth + 1);
    }
    const apps = catalog && Date.now() - catalog.at < CATALOG_MS ? await catalog.apps : await readCatalog();
    catalog = null;
    const steps = parseSequence(text, { ...context, apps: apps.flatMap((app) => app.names), platform });
    log('voice:', JSON.stringify(text), '→', JSON.stringify(steps));
    if (steps.some((step) => step.kind === 'cancel')) return { steps, outcome: null };
    if (steps[0]?.kind === 'teach') {
      const [{ phrase, then }] = steps;
      if (!learned || depth > 0) return { steps, outcome: bad('Jester can’t learn a command here.') };
      const done = await runSentence(then, depth + 1);
      if (!done.outcome?.ok) return { steps, outcome: done.outcome && bad(`${done.outcome.text.replace(/[.!?]+$/, '')}. So “${phrase}” wasn’t saved.`) };
      const saved = await learned.teach(phrase, then).then(
        () => true,
        (err) => (log('couldn’t save', JSON.stringify(phrase), err.message), false)
      );
      return { steps, outcome: ok(`${done.outcome.text} · ${saved ? `Say “${phrase}” any time to do that.` : `“${phrase}” couldn’t be saved.`}`) };
    }
    // What the matcher can't do goes, whole, to a way learned before, then to the assistant.
    // Without one, half a sentence is not done: "open Spotify and do a little dance" does nothing.
    const unknown = steps.find((step) => step.kind === 'unknown');
    if (unknown) {
      const known = learned && assistant?.replay ? await learned.find(text).catch(() => null) : null;
      let note = '';
      let done = [];
      if (known) {
        const replayed = await assistant.replay(known, text);
        if (replayed.ok) {
          learned.used(known.key).catch(() => undefined);
          return { steps, outcome: ok(replayed.text) };
        }
        if (replayed.cancelled) return { steps, outcome: null };
        log('learned way failed at step', replayed.step + 1);
        note = `The way this was done before stopped at step ${replayed.step + 1}: ${replayed.detail}.`;
        done = known.steps.slice(0, replayed.step);
      }
      if (await assistantReady()) return { steps, outcome: await assisted(text, note, done) };
      // The assistant could, given a model: say where to add one.
      const partly = done.length ? `The saved way did ${done.length} step${done.length > 1 ? 's' : ''}, then stopped` : 'Nothing was done';
      if (assistant) return { steps, outcome: bad(`“${unknown.text.replace(/[.!?]+$/, '')}” needs the assistant: add an AI model in Jester’s Settings › Assistant. ${partly}.`) };
      const said = steps.length > 1 ? `Jester doesn’t know how to “${unknown.text}” yet, so it did nothing.` : `“${unknown.text}” isn’t a command Jester knows yet.`;
      return { steps, outcome: bad(said) };
    }
    if (steps.some(needsInput) && !canPost()) return { steps, outcome: bad('Allow Accessibility in Jester’s Settings first.') };
    // "Open Spotify and play …": Spotify, though it wasn't running when the apps were read.
    for (const [i, step] of steps.entries()) {
      if (step.kind === 'play' && !step.service && steps.slice(0, i).some((earlier) => earlier.kind === 'open' && /spotify/i.test(earlier.app || ''))) step.service = 'spotify';
    }
    const { pick, ...outcome } = await performSteps(steps, apps);
    // A search found the music, but its result wasn't pressed: picking one is the assistant's.
    if (outcome.ok && pick) {
      if (await assistantReady()) {
        await wait(SEARCH_LOAD_MS);
        return { steps, outcome: await assisted(text, '', [], { pick: true }) };
      }
      if (assistant) return { steps, outcome: ok(`${outcome.text}. To have Jester press Play, add an AI model in Settings › Assistant.`) };
    }
    return { steps, outcome };
  }

  /** The apps, as read a moment ago if they were, and left for the command that follows. */
  function freshApps() {
    if (!catalog || Date.now() - catalog.at >= CATALOG_MS) catalog = { at: Date.now(), apps: readCatalog() };
    return catalog.apps;
  }

  return {
    /** Read the apps while the user talks, so the command needn't wait for them. */
    prepare() {
      catalog = { at: Date.now(), apps: readCatalog() };
    },
    /**
     * @param {string} text
     * @param {{talking?:boolean}} [context]  talking: said in conversation (parseCommand)
     * @returns {Promise<{steps:object[], outcome:{ok:boolean, text:string}|null}>} null: nothing to say
     */
    run: (text, context = {}) => runSentence(text, 0, context),
    /** Whether a sentence is one Jester can do with no model. Does nothing, and stops nothing running. */
    async knows(text) {
      if (learned && (await learned.phrase(text).catch(() => null))) return true;
      const apps = (await freshApps()).flatMap((app) => app.names);
      if (!parseSequence(text, { apps, platform, talking: true }).some((step) => step.kind === 'unknown')) return true;
      return !!(learned && (await learned.find(text).catch(() => null)));
    },
    /**
     * Whether a sentence should ask before it's done, having been overheard. What
     * goes to the assistant doesn't: it asks for itself, at the step that needs it.
     */
    async risky(text) {
      const taught = learned ? await learned.phrase(text).catch(() => null) : null;
      const names = (await freshApps()).flatMap((app) => app.names);
      const steps = parseSequence(taught?.say ?? text, { apps: names, platform, talking: !taught });
      if (steps.some((step) => step.kind === 'unknown')) return false;
      return steps.some((step) => asksFirst(step, { platform, listed: (app) => !!matchApp(app, names) }));
    },
    /** Moves a window, as the assistant's place asks: {app?, pid?, name?, where, screen}. */
    async place(request) {
      return placeWindow(request, await readCatalog());
    },
    /** Opens an app (or brings it forward) and waits for it in front: the assistant's open_app. */
    async openApp(name) {
      const apps = await readCatalog();
      const match = matchApp(name, apps.flatMap((app) => app.names));
      if (!match && mac) return bad(`No app called “${name}” is installed.`);
      try {
        const opened = await perform({ kind: 'open', app: match || name, heard: String(name).toLowerCase() }, apps);
        if (!(await cameToFront(opened.front))) return bad(`${opened.front[0]} didn’t come to the front.`);
        await wait(SETTLE_MS);
        return ok(opened.text);
      } catch (err) {
        return bad(`Couldn’t open ${name}: ${err.message}`);
      }
    }
  };
}
