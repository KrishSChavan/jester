/**
 * The desktop assistant's eyes and hands: jester-driver's snapshot of the
 * front window, and the accessibility actions, keys and clicks that act on it.
 * The loop (loop.js) has already checked each action and, where it must, had
 * the user approve it; this only does it — to the app it read, or not at all.
 *
 * Accessibility first, as Atticus does: a control's own press, a field's value
 * set outright, a scroll area's own scrolling and a menu command reach the app
 * wherever it is, without the pointer or the keyboard. Keys, typed text and
 * clicks at a point are the fallback.
 *
 * Keystrokes go to whichever app is in front when they're sent, and that can
 * change while a step waits for the user's OK (a click elsewhere, a window
 * coming forward). So before any key or any click at a point, the app the
 * screen was read from is brought back to the front and checked; typing also
 * checks that the keyboard focus is in that app. Failing either, nothing is
 * typed or clicked. What has the focus is checked closed: when it can't be
 * read, nothing is typed.
 *
 * Asked to (`verify`), a step's screen is read again afterwards and compared,
 * so the model learns what its step changed — or that it changed nothing —
 * and that read is the next step's screen.
 */

import { parseShortcut } from '../os-actions.js';
import { MEDIA_KEYS, menuPath } from './actions.js';
import { elementById, findElements, screenChanges } from './screen.js';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** After a step, the app gets this long to redraw before the screen is read again. */
const SETTLE_MS = 350;
/** A press that opened something modal: the app answers again after a moment. */
const BUSY_MS = 700;
/** After opening a link, the browser needs a little longer. */
const PAGE_MS = 1200;
const SCROLL_PIXELS = 400;
/** Before reading the screen again when a read fails. */
const OBSERVE_RETRY_MS = 400;
/** How long an app brought forward may take to be in front: 20 looks, 100 ms apart. */
const FRONT_TRIES = 20;
/** Between the presses of a key pressed several times. */
const KEY_GAP_MS = 60;
/** Typed text is looked for in its field this often, this many times: a web page's value catches up a frame or two late. */
const READ_BACK_MS = 100;
const READ_BACK_LOOKS = 6;
/** How far scroll_to looks, a page at a time. */
const SCROLL_TO_PAGES = 15;
/** A drag is this many moves, a frame apart, so the app sees it as one. */
const DRAG_STEPS = 12;
/** What the snapshot shows of a field's value: one longer than this holds text the model never saw. */
const SHOWN_VALUE = 200;
const NO_PASSWORDS = 'Jester never types into password fields.';
const FOCUS_UNKNOWN = 'Jester couldn’t tell what has the keyboard focus, so nothing was typed.';
/** Keys that can't put anything into a field. */
const HARMLESS_KEYS = new Set(['tab', 'escape', 'up', 'down', 'left', 'right', 'pageup', 'pagedown', 'home', 'end']);
/** Fields of one line, whose text a typed answer replaces. */
const LINE_INPUTS = new Set(['textfield', 'searchfield', 'combobox']);
/** Accessibility roles that are text fields themselves, whatever secure input says. */
const AX_TEXT_ROLES = new Set(['AXTextField', 'AXTextArea', 'AXComboBox', 'AXSearchField']);
/** Steps whose effect shows on screen, and is worth checking. */
const VISIBLE = new Set(['click', 'type', 'press', 'scroll', 'menu', 'drag']);
/** Steps whose effect may not show in a snapshot at all (formatting, a toggle, the clipboard). */
const UNSEEN = new Set(['menu', 'press']);
/** The driver's refusal when a read came between choosing an element and acting on it. */
const STALE = /read again since/;
const SCROLL_ENDS = { up: 'the top', down: 'the bottom', left: 'the far left', right: 'the far right' };

const middle = (frame) => (frame && frame.w > 0 && frame.h > 0 ? { x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 } : null);
const tidy = (value, max = 240) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const quoted = (value) => `“${tidy(value, 60)}”`;
/** Whether an app is the one read: its process, or (a Windows Store app) the one its frame holds. */
const sameApp = (pid, app) => pid === app?.pid || (app?.hostedPid !== undefined && pid === app.hostedPid);

/**
 * @param {object} deps
 * @param {{call: Function}} deps.driver
 * @param {(name:string) => Promise<{ok:boolean, text:string}>} deps.openApp  opens it and waits for it in front
 * @param {(app:{pid:number, name?:string, bundleId?:string}) => Promise<unknown>} deps.activate  brings a running app forward
 * @param {(url:string) => Promise<unknown>} deps.openUrl
 * @param {(action:string, options:object) => Promise<{ok:boolean, detail:string}>} deps.dispatch
 * @param {(request:{app?:string|null, pid?:number, name?:string, where:string, screen:string}) => Promise<{ok:boolean, text:string}>} [deps.place]
 *   moves a window (voice-runner.js's), checking where it lands
 * @param {(ms:number) => Promise<void>} [deps.wait]
 * @param {(task:Function) => Promise} [deps.quietly]  runs accessibility work with Jester's
 *   overlays hidden: macOS answers nothing useful while one is on screen (README)
 * @param {number} [deps.exclude]  Jester's own process: its windows are never the screen meant
 * @param {number} [deps.pid]  read this app's window instead of the front one (tests)
 * @param {string} [deps.platform]
 */
export function createDesktopHost({ driver, openApp, activate, openUrl, dispatch, place = null, wait = pause, quietly = (task) => task(), exclude, pid, platform = process.platform }) {
  const primary = platform === 'darwin' ? 'cmd' : 'ctrl';
  /** An accessibility action on an element of the snapshot (none: its window). */
  const act = (snapshot, element, action, value) =>
    quietly(() =>
      driver.call('act', { snapshot: snapshot.snapshot, ...(element ? { element: element.id } : {}), action, ...(value !== undefined ? { value } : {}) })
    );
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

  /**
   * The accessibility action first: it reaches the element wherever its app
   * is. Refused, a click where it's drawn. Two answers are never clicked
   * again: none at all (the press may have opened a dialog that holds the app,
   * and a click would do it twice, Atticus's lesson) and a read in between
   * (the screen it was chosen from is gone: the loop reads it again).
   */
  async function press(snapshot, element) {
    let reply;
    try {
      reply = await act(snapshot, element, 'press');
    } catch (err) {
      if (err?.code === 'timeout') return { ok: true, busy: true, detail: 'pressed; the app is busy, perhaps with a dialog' };
      if (STALE.test(err?.message)) return { ok: false, detail: 'The screen changed before it could be pressed; nothing was done.' };
      const at = middle(element.frame);
      if (!at) throw err;
      if (!(await inFront(snapshot))) return notInFront(snapshot);
      await driver.call('click', at);
      return { ok: true, detail: 'clicked where it is drawn' };
    }
    return { ok: true, detail: '', ...(reply?.busy ? { busy: true } : {}) };
  }

  /** A click with the real pointer, for what accessibility has no action for: a double or right click. */
  async function pointer(snapshot, element, { button, count }) {
    const at = middle(element.frame);
    if (!at) return { ok: false, detail: 'It has no place on screen to click.' };
    if (!(await inFront(snapshot))) return notInFront(snapshot);
    await driver.call('click', { ...at, ...(button === 'left' ? {} : { button }), ...(count > 1 ? { count } : {}) });
    return { ok: true, detail: `${count > 1 ? 'double-clicked' : 'right-clicked'} where it is drawn` };
  }

  async function click(snapshot, element, action) {
    if (action.count === 2) return pointer(snapshot, element, { button: action.button || 'left', count: 2 });
    if (action.button === 'right') {
      // The control's own menu, where it has one. A menu that opened keeps the
      // app busy until it closes: that's shown, not a reason to right-click again.
      try {
        const shown = await act(snapshot, element, 'showMenu');
        return { ok: true, detail: '', ...(shown?.busy ? { busy: true } : {}) };
      } catch (err) {
        if (err?.code === 'timeout') return { ok: true, busy: true, detail: 'its menu is open' };
        if (STALE.test(err?.message)) return { ok: false, detail: 'The screen changed before it could be clicked; nothing was done.' };
      }
      return pointer(snapshot, element, { button: 'right', count: 1 });
    }
    return press(snapshot, element);
  }

  async function focus(snapshot, element) {
    try {
      await act(snapshot, element, 'focus');
    } catch (err) {
      const at = middle(element.frame);
      if (!at || STALE.test(err?.message)) throw err;
      await driver.call('click', at);
    }
    await wait(120);
  }

  /**
   * What has the keyboard focus: whether it's a password field, and whose.
   * Unreadable is `unknown`, which nothing is typed into. On macOS, secure
   * input on (a password field anywhere takes keys in secret) with the focus
   * on something that isn't plainly a text field counts as a password field:
   * a web page's that isn't read yet looks like that.
   */
  async function focusedNow() {
    for (let tries = 0; tries < 2; tries++) {
      try {
        const focused = await quietly(() => driver.call('focused'));
        const role = focused?.element?.role;
        const secure = focused?.element?.secure === true || (focused?.secureInput === true && !AX_TEXT_ROLES.has(role));
        return { secure, pid: focused?.app?.pid };
      } catch (err) {
        // Nothing focused at all: there's nowhere for keys to go wrong.
        if (/nothing has the keyboard focus/.test(err?.message)) return { secure: false };
        if (err?.code !== 'timeout') break;
      }
    }
    return { secure: false, unknown: true };
  }

  /** Whether the keyboard focus may take keys for this app: refused, why. */
  async function keysMayGo(snapshot) {
    const focused = await focusedNow();
    if (focused.unknown) return { ok: false, detail: FOCUS_UNKNOWN };
    if (focused.secure) return { ok: false, detail: NO_PASSWORDS };
    if (focused.pid !== undefined && !sameApp(focused.pid, snapshot.app)) return notInFront(snapshot);
    return { ok: true };
  }

  /**
   * A field's text, read back: whether it holds `text` (in full, however long
   * the field), and how long it is. Null when it can't be read, which is no
   * verdict either way.
   */
  async function readField(snapshot, element, text) {
    const reply = await act(snapshot, element, 'read', text).catch(() => null);
    if (!reply || (typeof reply.contains !== 'boolean' && typeof reply.value !== 'string')) return null;
    const contains = typeof reply.contains === 'boolean' ? reply.contains : `${reply.value || ''}${reply.tail || ''}`.toLowerCase().includes(tidy(text, 60).toLowerCase());
    return { contains, length: reply.length ?? String(reply.value ?? '').length, value: reply.value ?? '' };
  }

  /**
   * Text into a field: replacing a one-line field's text, added to the end of
   * a longer one's, or at the cursor (no field named, or one that isn't a
   * text field). A native field's value is set outright; a web page's, which
   * wouldn't notice that, is typed. Everything about the app and its focus is
   * checked before anything is written, and what was written is read back
   * before any Enter: a search or a message with the wrong words in it isn't
   * sent. A field holding more than the screen showed isn't replaced: that
   * would wipe text the model never saw.
   */
  async function type(snapshot, element, action) {
    if (element?.role === 'password') return { ok: false, detail: NO_PASSWORDS };
    // A tab typed is a Tab pressed: what follows it would go into the next field, which may be a password's.
    if (action.text.includes('\t')) return { ok: false, detail: 'Typed text can’t hold a tab (it moves to the next field): type each field on its own.' };
    const shown = typeof element?.value === 'string' ? element.value : '';
    const lines = element?.role === 'textarea' || /[\r\n]/.test(shown);
    const mode = action.mode || (!element ? 'insert' : LINE_INPUTS.has(element.role) && !lines ? 'replace' : element.role === 'textarea' ? 'append' : 'insert');
    if (element && mode === 'replace' && lines) {
      // Its formatting, its lists and attachments, and whatever the screen didn't show of it would all go.
      if (element.role === 'textarea') return { ok: false, detail: 'A text area isn’t replaced whole (its formatting would go): add to it, or select what to change and type over it.' };
      const before = await readField(snapshot, element, '');
      if (before && before.length > SHOWN_VALUE) return { ok: false, detail: `That field holds more lines than the screen showed (${before.length} characters), so it wasn’t replaced.` };
    }
    // With Enter to come, the app and its focus are checked before the text goes in, not after.
    if (action.enter || !element || mode === 'insert') {
      if (!(await inFront(snapshot))) return notInFront(snapshot);
      if (element) await focus(snapshot, element);
      const keys = await keysMayGo(snapshot);
      if (!keys.ok) return keys;
    }
    let typed = false;
    if (element && mode !== 'insert') {
      let late = false;
      const set = await act(snapshot, element, mode === 'append' ? 'appendValue' : 'setValue', action.text).catch((err) => ((late = err?.code === 'timeout'), null));
      // No answer in time: the driver may still set it, and added again it would go in twice.
      if (late && mode === 'append') return { ok: false, detail: 'The app was busy: the text may have been added. Check the field before trying again.' };
      typed = set?.landed === true;
      // Set, but not as asked, or no answer: typing it again could add it twice (replacing is safe to redo; adding isn't).
      if (mode === 'append' && (set?.landed === false || set?.busy)) {
        return { ok: false, detail: set.busy ? 'The app was busy: the text may have been added. Check the field before trying again.' : `Added the text, but the field reads ${quoted(set.value)}: check it before trying again.` };
      }
    }
    if (!typed) {
      if (!action.enter && element && mode !== 'insert') {
        if (!(await inFront(snapshot))) return notInFront(snapshot);
        await focus(snapshot, element);
        const keys = await keysMayGo(snapshot);
        if (!keys.ok) return keys;
      }
      const before = element && mode === 'append' ? await readField(snapshot, element, '') : null;
      if (element && mode === 'replace') await driver.call('key', { key: 'a', modifiers: [primary] });
      if (element && mode === 'append') await driver.call('key', platform === 'darwin' ? { key: 'down', modifiers: ['cmd'] } : { key: 'end', modifiers: ['ctrl'] });
      await driver.call('text', { text: action.text });
      if (element) {
        // A web page's value catches up a frame or two late: looked for a few times before it's judged.
        let now = null;
        for (let look = 0; look < READ_BACK_LOOKS; look++) {
          if (look) await wait(READ_BACK_MS);
          now = await readField(snapshot, element, action.text);
          if (!now || (now.contains && (!before || now.length > before.length))) break;
        }
        if (now && !(now.contains && (!before || now.length > before.length))) {
          return { ok: false, detail: `The text didn’t land: the field reads ${quoted(now.value)}${action.enter ? ', so Enter wasn’t pressed' : ''}.` };
        }
      }
    }
    if (action.enter) await driver.call('key', { key: 'enter', modifiers: [] });
    return { ok: true };
  }

  /** The wheel, over the element or the window's middle: what scrolls when a scroll area won't by itself. */
  async function wheel(snapshot, element, direction, pages = 1) {
    if (!(await inFront(snapshot))) return notInFront(snapshot);
    const at = middle(element?.frame) || middle(snapshot.window?.frame);
    const pixels = pages * SCROLL_PIXELS * (direction === 'up' || direction === 'left' ? 1 : -1);
    const horizontal = direction === 'left' || direction === 'right';
    await driver.call('scroll', { ...(at || {}), ...(horizontal ? { dx: pixels } : { dy: pixels }), unit: 'pixel' });
    return { ok: true };
  }

  /**
   * The scroll area's own scrolling first (no pointer, and the app needn't be
   * in front), which says whether anything moved; else the wheel.
   */
  async function scroll(snapshot, element, action) {
    const end = action.to === 'end';
    let stale = false;
    const reply = await act(snapshot, element, end ? 'scrollEnd' : 'scrollPage', action.direction).catch((err) => ((stale = STALE.test(err?.message)), null));
    // Read again in between: the wheel would go where the window was.
    if (stale) return { ok: false, detail: 'The screen changed before it could be scrolled; nothing was done.' };
    if (reply?.moved === true) return { ok: true, detail: Number.isFinite(reply.position) ? `now ${Math.round(reply.position * 100)}% of the way` : '' };
    // Scrolled, though its scroll bar can't say how far.
    if (reply && reply.moved === null) return { ok: true, detail: end && reply.unconfirmed ? 'scrolled, but couldn’t confirm it reached the end' : '' };
    if (reply?.atEnd) return { ok: false, detail: `Already at ${SCROLL_ENDS[action.direction]}: there’s no more to scroll.` };
    return wheel(snapshot, element, action.direction, end ? 20 : 1);
  }

  /**
   * Pages through the window until something matching the words is on screen:
   * the scroll area's own scrolling, else the wheel; back the other way once,
   * at an end or where nothing moves.
   */
  async function scrollTo(snapshot, text, signal) {
    let current = snapshot;
    let direction = 'down';
    let turned = false;
    for (let page = 0; page <= SCROLL_TO_PAGES; page++) {
      const found = findElements(current, text, 5);
      if (found.length) return { ok: true, detail: page ? `found after scrolling ${page} page${page > 1 ? 's' : ''}` : 'it’s on screen', found, snapshot: current };
      if (signal?.aborted) break;
      let stale = false;
      const reply = await act(current, null, 'scrollPage', direction).catch((err) => ((stale = STALE.test(err?.message)), null));
      if (stale) break;
      if (reply?.atEnd) {
        if (turned) break;
        turned = true;
        direction = direction === 'down' ? 'up' : 'down';
        continue;
      }
      if (reply?.moved !== true && reply?.moved !== null) {
        const wheeled = await wheel(current, null, direction);
        if (!wheeled.ok) return wheeled;
      }
      await wait(SETTLE_MS);
      const seen = await observe();
      if (!seen.ok) break;
      // Nothing moved, whatever turned it: this way's end.
      if (!screenChanges(current, seen.snapshot).changed) {
        current = seen.snapshot;
        if (turned) break;
        turned = true;
        direction = direction === 'down' ? 'up' : 'down';
        continue;
      }
      current = seen.snapshot;
    }
    return { ok: false, detail: `Couldn’t find ${quoted(text)} by scrolling.`, ...(current === snapshot ? {} : { snapshot: current }) };
  }

  /**
   * A menu-bar command of the app that was read, by the titles prepare()
   * found, word for word: the command chosen is the one judged. Never while a
   * password field has the focus (Paste would put text into it).
   */
  async function menu(snapshot, action) {
    const focused = await focusedNow();
    if (focused.secure) return { ok: false, detail: NO_PASSWORDS };
    if (focused.unknown) return { ok: false, detail: 'Jester couldn’t tell what has the keyboard focus, so no menu command was chosen.' };
    try {
      const chosen = await quietly(() => driver.call('menu', { pid: snapshot.app?.pid, path: action.resolved || menuPath(action.path), press: true, exact: true }));
      return { ok: true, detail: '', ...(chosen?.busy ? { busy: true } : {}) };
    } catch (err) {
      return { ok: false, detail: tidy(err?.message || err) };
    }
  }

  /** Pressed on one control, moved in steps onto another, let go — always let go. */
  async function drag(snapshot, action) {
    const from = middle(elementById(snapshot, action.from)?.frame);
    const to = middle(elementById(snapshot, action.to)?.frame);
    if (!from || !to) return { ok: false, detail: 'Both ends must be controls on this screen.' };
    if (!(await inFront(snapshot))) return notInFront(snapshot);
    await driver.call('move', from);
    await driver.call('button', { ...from, down: true });
    try {
      for (let step = 1; step <= DRAG_STEPS; step++) {
        await wait(16);
        await driver.call('move', { x: from.x + ((to.x - from.x) * step) / DRAG_STEPS, y: from.y + ((to.y - from.y) * step) / DRAG_STEPS });
      }
    } finally {
      await driver.call('button', { ...to, down: false });
    }
    return { ok: true };
  }

  async function observe() {
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
  }

  async function perform(action, snapshot, signal) {
    const element = action.id === undefined ? null : elementById(snapshot, action.id);
    if (action.id !== undefined && !element) return { ok: false, detail: `There is no element ${action.id} on this screen.` };
    switch (action.action) {
      case 'click':
        return click(snapshot, element, action);
      case 'type':
        return type(snapshot, element, action);
      case 'press': {
        const plan = parseShortcut(action.keys);
        if (!(await inFront(snapshot))) return notInFront(snapshot);
        if (!HARMLESS_KEYS.has(plan.key)) {
          const keys = await keysMayGo(snapshot);
          if (!keys.ok) return keys;
        }
        for (let time = 0; time < (action.times || 1); time++) {
          if (time) await wait(KEY_GAP_MS);
          if (signal?.aborted) break;
          await driver.call('key', { key: plan.key, modifiers: plan.modifiers });
        }
        return { ok: true };
      }
      case 'scroll':
        return scroll(snapshot, element, action);
      case 'scroll_to':
        return scrollTo(snapshot, action.text, signal);
      case 'menu':
        return menu(snapshot, action);
      case 'drag':
        return drag(snapshot, action);
      case 'place': {
        if (!place) return { ok: false, detail: 'Jester can’t move windows here.' };
        const outcome = await place({ app: action.app || null, ...(action.app ? {} : { pid: snapshot.app?.pid, name: snapshot.app?.name }), where: action.where, screen: action.screen || 'current' });
        return { ok: outcome.ok, detail: outcome.text };
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
        // Its numbers are this read's: it's the next step's screen too.
        return { ok: true, detail: found.length ? `${found.length} found` : 'nothing on screen matches', found, snapshot };
      }
      case 'wait':
        await wait(action.ms);
        return { ok: true };
      default:
        return { ok: false, detail: `Jester can’t ${action.action}.` };
    }
  }

  return {
    observe,

    /**
     * What a step needs settled before it is judged: a menu command's real
     * titles (whose last is what the user may be asked about), and whether it
     * can be chosen now. A level that can't be read without opening it comes
     * back as the model asked for it, which the press then takes word for
     * word. Mutates `action`: `resolved`.
     */
    async prepare(action, snapshot) {
      if (action.action !== 'menu') return { ok: true };
      if (!snapshot?.app?.pid) return { ok: false, detail: 'No app was read to look in its menus.' };
      try {
        const found = await quietly(() => driver.call('menu', { pid: snapshot.app.pid, path: menuPath(action.path), press: false }));
        action.resolved = found.path;
        if (found.enabled === false) return { ok: false, detail: `“${found.path.join(' › ')}” is greyed out right now.` };
        return { ok: true };
      } catch (err) {
        return { ok: false, detail: tidy(err?.message || err) };
      }
    },

    /**
     * Does it. With `verify`, a step whose effect shows on screen is checked:
     * the screen is read again, and the result says what changed (`changes`,
     * `changed`) and carries that read (`snapshot`) for the next step. A menu
     * command or a key whose effect the read can't show (bold text, a copy)
     * isn't "nothing changed" but unseen: `changed` is left unsaid. Cancelled
     * (`signal`), it stops where it is and reads nothing more.
     */
    async execute(action, snapshot, { verify = false, signal } = {}) {
      const result = await perform(action, snapshot, signal);
      if (!result.ok || !VISIBLE.has(action.action)) return result;
      await wait(result.busy ? BUSY_MS : SETTLE_MS);
      if (!verify || signal?.aborted) return result;
      const seen = await observe();
      if (!seen.ok) return result;
      const { changed, summary } = screenChanges(snapshot, seen.snapshot);
      if (!changed && UNSEEN.has(action.action)) return { ...result, unseen: true, changes: 'No visible change (its effect may not show here).', snapshot: seen.snapshot };
      return { ...result, changed, changes: summary, snapshot: seen.snapshot };
    }
  };
}
