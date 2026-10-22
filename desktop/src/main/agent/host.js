/**
 * The desktop assistant's eyes and hands: jester-driver's snapshot of the
 * front window, and the accessibility actions, keys and clicks that act on it.
 * The loop (loop.js) has already checked each action and, where it must, had
 * the user approve it; this only does it — to the app it read, or not at all.
 *
 * Keystrokes go to whichever app is in front when they're sent, and that can
 * change while a step waits for the user's OK (a click elsewhere, a window
 * coming forward). So before any key or any click at a point, the app the
 * screen was read from is brought back to the front and checked; typing also
 * checks that the keyboard focus is in that app. Failing either, nothing is
 * typed or clicked.
 */

import { parseShortcut } from '../os-actions.js';
import { MEDIA_KEYS } from './actions.js';
import { elementById, findElements } from './screen.js';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** After a step, the app gets this long to redraw before the screen is read again. */
const SETTLE_MS = 350;
/** After opening a link, the browser needs a little longer. */
const PAGE_MS = 1200;
const SCROLL_PIXELS = 400;
/** Before reading the screen again when a read fails. */
const OBSERVE_RETRY_MS = 400;
/** How long an app brought forward may take to be in front: 20 looks, 100 ms apart. */
const FRONT_TRIES = 20;
const NO_PASSWORDS = 'Jester never types into password fields.';
/** Keys that can't put anything into a field. */
const HARMLESS_KEYS = new Set(['tab', 'escape', 'up', 'down', 'left', 'right', 'pageup', 'pagedown', 'home', 'end']);

const middle = (frame) => frame && frame.w > 0 && frame.h > 0 ? { x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 } : null;

/**
 * @param {object} deps
 * @param {{call: Function}} deps.driver
 * @param {(name:string) => Promise<{ok:boolean, text:string}>} deps.openApp  opens it and waits for it in front
 * @param {(app:{pid:number, name?:string, bundleId?:string}) => Promise<unknown>} deps.activate  brings a running app forward
 * @param {(url:string) => Promise<unknown>} deps.openUrl
 * @param {(action:string, options:object) => Promise<{ok:boolean, detail:string}>} deps.dispatch
 * @param {(ms:number) => Promise<void>} [deps.wait]
 * @param {(task:Function) => Promise} [deps.quietly]  runs accessibility work with Jester's
 *   overlays hidden: macOS answers nothing useful while one is on screen (README)
 * @param {number} [deps.exclude]  Jester's own process: its windows are never the screen meant
 * @param {number} [deps.pid]  read this app's window instead of the front one (tests)
 */
export function createDesktopHost({ driver, openApp, activate, openUrl, dispatch, wait = pause, quietly = (task) => task(), exclude, pid }) {
  const act = (snapshot, element, action) => quietly(() => driver.call('act', { snapshot: snapshot.snapshot, element: element.id, action }));
  const frontPid = async () => (await driver.call('frontmost').catch(() => null))?.app?.pid;

  /** Whether the app the screen was read from is in front, bringing it back if it isn't. */
  async function inFront(snapshot) {
    const want = snapshot.app?.pid;
    if (!want) return false;
    if ((await frontPid()) === want) return true;
    await activate(snapshot.app);
    for (let tries = FRONT_TRIES; tries > 0; tries--) {
      await wait(100);
      if ((await frontPid()) === want) return true;
    }
    return false;
  }
  const notInFront = (snapshot) => ({ ok: false, detail: `${snapshot.app?.name || 'The app'} isn’t in front any more, so nothing was typed or clicked.` });

  /** The accessibility action first: it reaches the element wherever its app is. Else a click where it's drawn. */
  async function press(snapshot, element) {
    try {
      await act(snapshot, element, 'press');
      return { ok: true, detail: '' };
    } catch (err) {
      const at = middle(element.frame);
      if (!at) throw err;
      if (!(await inFront(snapshot))) return notInFront(snapshot);
      await driver.call('click', at);
      return { ok: true, detail: 'clicked where it is drawn' };
    }
  }

  async function focus(snapshot, element) {
    try {
      await act(snapshot, element, 'focus');
    } catch (err) {
      const at = middle(element.frame);
      if (!at) throw err;
      await driver.call('click', at);
    }
    await wait(120);
  }

  /** What has the keyboard focus: whether it's a password field, and whose. */
  async function focusedNow() {
    const focused = await quietly(() => driver.call('focused')).catch(() => null);
    return { secure: focused?.element?.secure === true, pid: focused?.app?.pid };
  }

  return {
    async observe() {
      const target = pid ? { pid } : exclude ? { exclude } : {};
      let failed = null;
      // Twice: a window can be mid-change (a sheet closing, a popup going away).
      for (let tries = 0; tries < 2; tries++) {
        if (failed) await wait(OBSERVE_RETRY_MS);
        try {
          return { ok: true, snapshot: await quietly(() => driver.call('snapshot', { limit: 300, ...target })) };
        } catch (err) {
          failed = err;
        }
      }
      return { ok: false, detail: failed.message };
    },

    async execute(action, snapshot) {
      const element = action.id === undefined ? null : elementById(snapshot, action.id);
      if (action.id !== undefined && !element) return { ok: false, detail: `There is no element ${action.id} on this screen.` };
      switch (action.action) {
        case 'click': {
          const pressed = await press(snapshot, element);
          if (pressed.ok) await wait(SETTLE_MS);
          return pressed;
        }
        case 'type': {
          if (element?.role === 'password') return { ok: false, detail: NO_PASSWORDS };
          if (!(await inFront(snapshot))) return notInFront(snapshot);
          if (element) await focus(snapshot, element);
          // Whatever has the focus gets the text: it must be in this app, and not a password field.
          const focused = await focusedNow();
          if (focused.secure) return { ok: false, detail: NO_PASSWORDS };
          if (focused.pid !== undefined && focused.pid !== snapshot.app?.pid) return notInFront(snapshot);
          await driver.call('text', { text: action.text });
          if (action.enter) await driver.call('key', { key: 'enter', modifiers: [] });
          await wait(SETTLE_MS);
          return { ok: true };
        }
        case 'press': {
          const plan = parseShortcut(action.keys);
          if (!(await inFront(snapshot))) return notInFront(snapshot);
          if (!HARMLESS_KEYS.has(plan.key) && (await focusedNow()).secure) return { ok: false, detail: NO_PASSWORDS };
          await driver.call('key', { key: plan.key, modifiers: plan.modifiers });
          await wait(SETTLE_MS);
          return { ok: true };
        }
        case 'scroll': {
          if (!(await inFront(snapshot))) return notInFront(snapshot);
          // Wheel events go to what's under the pointer: the element, or the window's middle.
          const at = middle(element?.frame) || middle(snapshot.window?.frame);
          await driver.call('scroll', { ...(at || {}), dy: action.direction === 'up' ? SCROLL_PIXELS : -SCROLL_PIXELS, unit: 'pixel' });
          await wait(SETTLE_MS);
          return { ok: true };
        }
        case 'open_app': {
          const opened = await openApp(action.name);
          return { ok: opened.ok, detail: opened.text };
        }
        case 'open_url':
          await openUrl(action.url);
          await wait(PAGE_MS);
          return { ok: true };
        case 'media': {
          const outcome = await dispatch(MEDIA_KEYS[action.key], { source: 'voice', quiet: true });
          return { ok: outcome.ok, detail: outcome.ok ? '' : outcome.detail };
        }
        case 'find': {
          const found = findElements(snapshot, action.query);
          return { ok: true, detail: found.length ? `${found.length} found` : 'nothing on screen matches', found };
        }
        case 'wait':
          await wait(action.ms);
          return { ok: true };
        default:
          return { ok: false, detail: `Jester can’t ${action.action}.` };
      }
    }
  };
}
