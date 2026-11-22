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
 *
 * After Atticus 2 (github.com/SaarthurR/atticus-mac, 2026-11-22): a click
 * that changed nothing readable is checked by eye too (a glance at the screen
 * round it, before and after: a canvas, a map or a video changes pixels and
 * no control); a spot in a picture of the window can be clicked where no
 * control is listed; a shortcut is known by the menu command it stands for;
 * text can go in after words already in a field; and the icons at the right
 * of the menu bar open, what they open being read as a window is. A task
 * whose app has gone behind another stays on it: read by its process, and
 * done to where it is. Accessibility's own ways reach it there; what they
 * can't do (a click where it's drawn, keys, text for a web page) is sent to
 * the app itself (the driver's clickBehind, keyBehind and textBehind:
 * macOS's private way in, as Atticus uses), so nothing comes forward and
 * the pointer stays put. Whatever can't be done that way, or showed nothing
 * when it was, is done as it always was: the app brought to the front.
 */

import { parseShortcut } from '../os-actions.js';
import { MEDIA_KEYS, menuPath } from './actions.js';
import { pictureRefusal } from './marks.js';
import { elementById, findElements, screenChanges } from './screen.js';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** After a step, the app gets this long to redraw before the screen is read again. */
const SETTLE_MS = 350;
/** A press that opened something modal: the app answers again after a moment. */
const BUSY_MS = 700;
/** After opening a link, the browser needs a little longer. */
const PAGE_MS = 1200;
/** Once in front, an app just started needs a moment before it takes keys. */
const OPENED_MS = 400;
const SCROLL_PIXELS = 400;
/** Before reading the screen again when a read fails. */
const OBSERVE_RETRY_MS = 400;
/** How long an app brought forward may take to be in front: 20 looks, 100 ms apart. */
const FRONT_TRIES = 20;
/** The processes macOS shows its own dialogs from: permission prompts, alerts, passwords, "wants to control". */
const SYSTEM_DIALOGS = /^(?:UserNotificationCenter|SecurityAgent|CoreServicesUIAgent|universalAccessAuthWarn|coreauthd|loginwindow)$/;
export const MACOS_ASKING = 'macOS is asking you something in a dialog of its own, and I can’t work past it: answer it, then say “keep going”.';
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
/** Text areas whose line breaks are read back at each look of the screen. */
const LINED_FIELDS = 2;
const NO_PASSWORDS = 'Jester never types into password fields.';
const FOCUS_UNKNOWN = 'Jester couldn’t tell what has the keyboard focus, so nothing was typed.';
/** Keys that can't put anything into a field. */
const HARMLESS_KEYS = new Set(['tab', 'escape', 'up', 'down', 'left', 'right', 'pageup', 'pagedown', 'home', 'end']);
/** Fields of one line, whose text a typed answer replaces. */
const LINE_INPUTS = new Set(['textfield', 'searchfield', 'combobox']);
/** Accessibility roles that are text fields themselves, whatever secure input says. */
const AX_TEXT_ROLES = new Set(['AXTextField', 'AXTextArea', 'AXComboBox', 'AXSearchField']);
/** Steps whose effect shows on screen, and is worth checking. */
const VISIBLE = new Set(['click', 'type', 'press', 'scroll', 'menu', 'menu_bar', 'drag']);
/** Steps whose effect may not show in a snapshot at all (formatting, a toggle, the clipboard). */
const UNSEEN = new Set(['menu', 'press']);
/**
 * How different two glances at the screen must be to count: their greys, 0 to 255, apart by this much on average
 * (Atticus's threshold for a click). A caret's blink in a 64 × 40 patch is about that; a button's new look is far more.
 */
const GLANCE_CHANGE = 1.5;
/** The pointer on a control, before it's pressed: how it looks hovered over is in the "before", so isn't the change. */
const HOVER_MS = 60;
/** Screen Recording refused: not looked for again for this long. */
const GLANCE_RETRY_MS = 60_000;
const PIXELS_CHANGED = 'The screen changed where it was clicked, though no control reads differently.';
/** Controls a place in a picture stands for when it's inside one: pressed as themselves, by name. */
const PRESSED_ROLES = new Set(['button', 'link', 'checkbox', 'switch', 'radio', 'tab', 'popup', 'menuitem', 'disclosure']);
/** The most a named thing under a spot may measure for its name to be the spot's (points). */
const SPOT_NAMED = { w: 480, h: 160 };
/** How long after a step put the keyboard focus in a field a key is taken to be for that field. */
const FIELD_FOCUS_MS = 10_000;
const NOTHING_BEHIND = 'It was clicked where it is, behind the window in front, and nothing changed: asked for again, it’s brought to the front and clicked there.';
/** The driver's refusal to set text into a field that only takes typed keys (mac.rs insert_after). */
const TYPE_INSTEAD = /type it instead/;
/** The driver's refusal when a read came between choosing an element and acting on it. */
const STALE = /read again since/;
/** The driver's refusal when the control has left the screen since it was read (protocol.rs GONE). */
const GONE = /gone from the screen/;
const SCROLL_ENDS = { up: 'the top', down: 'the bottom', left: 'the far left', right: 'the far right' };

const middle = (frame) => (frame && frame.w > 0 && frame.h > 0 ? { x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 } : null);
const tidy = (value, max = 240) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const quoted = (value) => `“${tidy(value, 60)}”`;
/** Whether an app is the one read: its process, or (a Windows Store app) the one its frame holds. */
const sameApp = (pid, app) => pid === app?.pid || (app?.hostedPid !== undefined && pid === app.hostedPid);

/**
 * Whether two glances at the screen (the driver's `glance`: grey bytes as hex) differ enough to say something
 * there changed. Not alike in size, or either missing, is no verdict: false.
 */
export function glanceChanged(before, after, least = GLANCE_CHANGE) {
  if (typeof before !== 'string' || typeof after !== 'string' || !before || before.length !== after.length) return false;
  let apart = 0;
  for (let at = 0; at < before.length; at += 2) apart += Math.abs(parseInt(before.slice(at, at + 2), 16) - parseInt(after.slice(at, at + 2), 16));
  return apart / (before.length / 2) >= least;
}

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
 * @param {Function & {allowed?: () => boolean}} [deps.picture]  (snapshot, {goal}) => a picture of
 *   its window with the controls numbered (window-shot.js); `allowed`, whether one can be taken now
 * @param {number} [deps.exclude]  Jester's own process: its windows are never the screen meant
 * @param {number} [deps.pid]  read this app's window instead of the front one (tests)
 * @param {string} [deps.platform]
 * @param {() => number} [deps.now]
 * @param {() => boolean} [deps.behind]  whether an app that isn't in front may be clicked and typed into where it
 *   is (Settings › Assistant, "Work behind your windows"); off, it's brought to the front first, as before
 */
export function createDesktopHost({ driver, openApp, activate, openUrl, dispatch, place = null, picture = null, wait = pause, quietly = (task) => task(), exclude, pid, platform = process.platform, now = Date.now, behind = () => true }) {
  const primary = platform === 'darwin' ? 'cmd' : 'ctrl';
  /** An accessibility action on an element of the snapshot (none: its window). */
  const act = (snapshot, element, action, value, after) =>
    quietly(() =>
      driver.call('act', { snapshot: snapshot.snapshot, ...(element ? { element: element.id } : {}), action, ...(value !== undefined ? { value } : {}), ...(after !== undefined ? { after } : {}) })
    );
  const frontPid = async () => (await driver.call('frontmost').catch(() => null))?.app?.pid;
  /** Until when the screen isn't glanced at: Screen Recording was refused. */
  let glanceOffUntil = 0;
  /** The last picture taken: the read it's of, and what of the screen it shows (window-shot.js viewOf). */
  let shot = null;
  /** A menu-bar icon's panel is open, as far as is known: it's what's read until it has closed. */
  let panel = false;
  /** The app a task is working on behind another (its process): read by that, not by what's in front. */
  let stay = null;
  /** Apps (their processes) that, in this task, took a click where they were and showed nothing, or couldn't be sent one: brought forward from then on. */
  const frontOnly = new Set();
  /** The app whose keyboard focus the last step put in a field it chose, and when: a key that follows goes there. */
  let fieldFocus = null;

  /**
   * The screen round a point, small and grey, for telling whether a click showed (the driver's `glance`). Null when
   * it can't be had: no Screen Recording (not asked for, and not tried again for a minute), or nothing to look at.
   */
  async function glance(at, window = undefined) {
    if (!at || now() < glanceOffUntil) return null;
    // One window alone is seen as it is whatever lies over it: how a click behind other windows is checked.
    const reply = await driver.call('glance', { x: at.x, y: at.y, ...(window ? { window } : exclude ? { exclude } : {}) }).catch(() => null);
    if (reply?.allowed === false) glanceOffUntil = now() + GLANCE_RETRY_MS;
    return typeof reply?.gray === 'string' && reply.gray ? reply.gray : null;
  }

  /**
   * A click with the real pointer. Watched (`looked`: a checked step), the pointer goes there first and the screen
   * is glanced at once it has: a control's hover look is then in the "before", and only what the press does is
   * the change.
   */
  async function pointerClick(at, extra = {}, looked = null) {
    if (looked) {
      await driver.call('move', at);
      await wait(HOVER_MS);
      const hovered = await glance(at);
      if (hovered) Object.assign(looked, { spot: at, before: hovered });
    }
    await driver.call('click', { ...at, ...extra });
  }

  /**
   * Where the app the screen was read from is: in front (`front`); or behind another and to be worked where it
   * is (`behind`): on a Mac, with working behind on, and nothing done to it there in this task having come to
   * nothing. Neither, and it's brought to the front (inFront).
   */
  async function placeOf(snapshot) {
    // What a menu-bar icon opened is over everything, and its app (Control Center) is never "in front".
    if (snapshot.panel) return { front: true };
    const want = snapshot.app?.pid;
    const app = (await driver.call('frontmost').catch(() => null))?.app;
    const front = app?.pid;
    if (want && front === want) return { front: true };
    // macOS's own dialog is what's in front: it's the user's to answer, and nothing is worked on behind it (execute says so).
    if (SYSTEM_DIALOGS.test(String(app?.name || ''))) return { front: false, known: false, behind: false };
    // `known`: something else is in front for sure (the driver said what), which accessibility's own ways need no leave for.
    const known = !!want && front !== undefined;
    return { front: false, known, behind: known && platform === 'darwin' && !frontOnly.has(want) && behind() === true };
  }

  /** Whether the app the screen was read from is in front, bringing it back if it isn't. `place`: where it was just found to be (placeOf). */
  async function inFront(snapshot, place = null) {
    if (snapshot.panel || place?.front) return true;
    const want = snapshot.app?.pid;
    if (!want) return false;
    if (!place && (await frontPid()) === want) return true;
    await activate(snapshot.app);
    for (let tries = FRONT_TRIES; tries > 0; tries--) {
      await wait(100);
      if ((await frontPid()) === want) return true;
    }
    return false;
  }
  /**
   * macOS's own dialog, when one is over everything: a permission being asked for, a password, an alert. The app a
   * task works on can't be had in front while it's up, and what it asks is the user's to answer, never Jester's.
   * (2026-11-14: a picture of the window brought up "…is requesting to bypass the system private window picker",
   * and for a minute every step after it failed as "Calculator isn't in front any more".)
   * @returns {Promise<string>} its owner's name, or ''
   */
  async function systemDialog() {
    if (platform !== 'darwin') return '';
    const name = String((await driver.call('frontmost').catch(() => null))?.app?.name || '');
    return SYSTEM_DIALOGS.test(name) ? name : '';
  }

  // `front: false`: it failed for want of the app in front, which is when macOS's own dialog may be why (execute).
  const notInFront = (snapshot) => ({ ok: false, front: false, detail: `${snapshot.app?.name || 'The app'} isn’t in front any more, so nothing was typed or clicked.` });
  /** The screen it was chosen from is gone, or the control is: the loop reads it again. */
  const changed = (err) => STALE.test(err?.message) || GONE.test(err?.message);

  /**
   * Where a real click lands on a control, as the driver finds it after
   * agent-desktop: the frame read now rather than as the snapshot had it,
   * scrolled into view, still, and hit-tested at up to five points. `covered`
   * names what's on top of it; `stale`, that it's gone. A driver that can't
   * say gives the middle of the frame the screen was read with. Asked with
   * the app in front: behind another app's window, everything is covered.
   */
  async function aim(snapshot, element, how = 'point') {
    let reply = null;
    try {
      reply = await act(snapshot, element, how);
    } catch (err) {
      if (changed(err)) return { stale: true };
    }
    if (typeof reply?.covered === 'string') return { covered: reply.covered };
    if (Number.isFinite(reply?.x) && Number.isFinite(reply?.y)) return { at: { x: reply.x, y: reply.y } };
    const at = middle(element?.frame);
    return at ? { at } : {};
  }
  /** Why a click didn't happen, from what `aim` found. */
  const missed = (aimed, done) =>
    aimed.covered
      ? { ok: false, detail: `It’s covered by ${aimed.covered}, so it wasn’t ${done}.` }
      : aimed.stale
        ? { ok: false, detail: `The screen changed before it could be ${done}; nothing was done.` }
        : { ok: false, detail: 'It has no place on screen to click.' };

  /**
   * A click sent to an app that isn't in front, at a place in one of its windows: the app stays where it is and
   * the pointer doesn't move. Watched (`looked`), the window alone is glanced at first, since what lies over it
   * is all a glance at the screen would show. Null when it couldn't be sent (no way to on this macOS, no window
   * there): nothing was done, the app is brought forward from now on, and the caller clicks as it always did.
   */
  async function spotBehind(snapshot, at, extra, looked, done) {
    const window = snapshot.window?.id || undefined;
    if (looked) {
      const seen = window ? await glance(at, window) : null;
      // No look at the window alone: no verdict from pixels at all (the look at the screen was of what's over it).
      Object.assign(looked, { spot: at, before: seen, window });
    }
    try {
      await driver.call('clickBehind', { pid: snapshot.app.pid, ...at, ...extra, ...(window ? { window } : {}) });
    } catch {
      frontOnly.add(snapshot.app.pid);
      return null;
    }
    fieldFocus = null;
    return { ok: true, behind: true, detail: `${done} where it is, behind the window in front` };
  }

  /** A control clicked where it's drawn in a window behind others: aimed within its own app, where only the app's own things can be over it. */
  async function clickBehind(snapshot, element, extra, looked, done = 'clicked') {
    const aimed = await aim(snapshot, element, 'pointBehind');
    if (!aimed.at) return missed(aimed, 'clicked');
    return spotBehind(snapshot, aimed.at, extra, looked, done);
  }

  /**
   * The accessibility ways of clicking first (the driver tries each in turn):
   * they reach the element wherever its app is. All refused, a click where
   * it's drawn — if nothing is on top of it. Two answers are never clicked
   * again: none at all (the press may have opened a dialog that holds the
   * app, and a click would do it twice, Atticus's lesson) and a read in
   * between or the control gone (the screen it was chosen from is gone, and
   * something else may be where it was: the loop reads it again).
   */
  async function press(snapshot, element, looked = null) {
    let reply;
    try {
      reply = await act(snapshot, element, 'press');
    } catch (err) {
      if (err?.code === 'timeout') return { ok: true, busy: true, detail: 'pressed; the app is busy, perhaps with a dialog' };
      if (changed(err)) return { ok: false, detail: 'The screen changed before it could be pressed; nothing was done.' };
      if (!middle(element.frame)) throw err;
      const place = await placeOf(snapshot);
      const sent = place.behind ? await clickBehind(snapshot, element, {}, looked) : null;
      if (sent) return sent;
      if (!(await inFront(snapshot, place))) return notInFront(snapshot);
      const aimed = await aim(snapshot, element);
      if (!aimed.at) return missed(aimed, 'clicked');
      await pointerClick(aimed.at, {}, looked);
      return { ok: true, detail: 'clicked where it is drawn' };
    }
    return { ok: true, detail: reply?.via === 'select' ? 'selected it' : '', ...(reply?.busy ? { busy: true } : {}) };
  }

  /** A click with the real pointer, for what accessibility has no action for: a double or right click. */
  async function pointer(snapshot, element, { button, count }, looked = null) {
    if (!middle(element.frame)) return { ok: false, detail: 'It has no place on screen to click.' };
    const extra = { ...(button === 'left' ? {} : { button }), ...(count > 1 ? { count } : {}) };
    const done = count > 1 ? 'double-clicked' : 'right-clicked';
    const place = await placeOf(snapshot);
    const sent = place.behind ? await clickBehind(snapshot, element, extra, looked, done) : null;
    if (sent) return sent;
    if (!(await inFront(snapshot, place))) return notInFront(snapshot);
    const aimed = await aim(snapshot, element);
    if (!aimed.at) return missed(aimed, 'clicked');
    await pointerClick(aimed.at, extra, looked);
    return { ok: true, detail: `${done} where it is drawn` };
  }

  /**
   * A click on a spot in a picture of the window, where no control is listed (locate() found the place on screen
   * and what could be read of it): the real pointer, there. There's no element to check it against, so it's the
   * one click that's never an accessibility press, and what it did is told by the screen alone.
   */
  async function clickSpot(snapshot, action, looked = null) {
    if (!action.at) return { ok: false, detail: 'x and y are a place in a picture of this screen: take a screenshot first.' };
    const button = action.button || 'left';
    const extra = { ...(button === 'left' ? {} : { button }), ...(action.count > 1 ? { count: action.count } : {}) };
    const place = await placeOf(snapshot);
    const sent = place.behind ? await spotBehind(snapshot, action.at, extra, looked, 'clicked that spot') : null;
    if (sent) return sent;
    if (!(await inFront(snapshot, place))) return notInFront(snapshot);
    await pointerClick(action.at, extra, looked);
    return { ok: true, detail: 'clicked that spot' };
  }

  /**
   * A click, and (a checked step) what the screen looked like where it went just before: `glanced`, for execute
   * to compare with after when nothing readable changed.
   */
  async function clicked(snapshot, element, action, verify) {
    const spot = action.at || middle(element?.frame);
    const before = verify && spot ? await glance(spot) : null;
    // Only a watched click is worth the pointer's detour (pointerClick); one whose "before" couldn't be had isn't.
    const looked = before ? { spot, before } : null;
    const result = await (element ? click(snapshot, element, action, looked) : clickSpot(snapshot, action, looked));
    return looked && result.ok ? { ...result, glanced: looked } : result;
  }

  async function click(snapshot, element, action, looked = null) {
    if (action.count === 2 && (action.button || 'left') === 'left') {
      // A double click's meaning, where the element has it (Finder opens a file
      // with AXOpen): no pointer. Busy is done, as a press is.
      try {
        const opened = await act(snapshot, element, 'open');
        return { ok: true, detail: 'opened it', ...(opened?.busy ? { busy: true } : {}) };
      } catch (err) {
        if (err?.code === 'timeout') return { ok: true, busy: true, detail: 'opened; the app is busy' };
        if (changed(err)) return { ok: false, detail: 'The screen changed before it could be clicked; nothing was done.' };
      }
    }
    if (action.count === 2) return pointer(snapshot, element, { button: action.button || 'left', count: 2 }, looked);
    if (action.button === 'right') {
      // The control's own menu, where it has one. A menu that opened keeps the
      // app busy until it closes: that's shown, not a reason to right-click again.
      try {
        const shown = await act(snapshot, element, 'showMenu');
        return { ok: true, detail: '', ...(shown?.busy ? { busy: true } : {}) };
      } catch (err) {
        if (err?.code === 'timeout') return { ok: true, busy: true, detail: 'its menu is open' };
        if (changed(err)) return { ok: false, detail: 'The screen changed before it could be clicked; nothing was done.' };
      }
      return pointer(snapshot, element, { button: 'right', count: 1 }, looked);
    }
    return press(snapshot, element, looked);
  }

  async function focus(snapshot, element) {
    try {
      await act(snapshot, element, 'focus');
    } catch (err) {
      if (!middle(element.frame) || changed(err)) throw err;
      const aimed = await aim(snapshot, element);
      if (!aimed.at) throw new Error(missed(aimed, 'clicked').detail);
      await driver.call('click', aimed.at);
    }
    await wait(120);
  }

  /**
   * A field given its app's keyboard focus while the app is behind another: asked of it through accessibility,
   * else by a click sent to it where it is. False when neither took, and nothing was done to it.
   */
  async function focusBehind(snapshot, element) {
    try {
      await act(snapshot, element, 'focus');
    } catch (err) {
      if (!middle(element.frame) || changed(err)) throw err;
      const clicked = await clickBehind(snapshot, element, {}, null);
      if (!clicked?.ok) return false;
    }
    await wait(120);
    return true;
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
   * the field), how long it is, and how it starts and ends. Null when it can't
   * be read, which is no verdict either way.
   */
  async function readField(snapshot, element, text) {
    const reply = await act(snapshot, element, 'read', text).catch(() => null);
    if (!reply || (typeof reply.contains !== 'boolean' && typeof reply.value !== 'string')) return null;
    const contains = typeof reply.contains === 'boolean' ? reply.contains : `${reply.value || ''}${reply.tail || ''}`.toLowerCase().includes(tidy(text, 60).toLowerCase());
    return { contains, length: reply.length ?? String(reply.value ?? '').length, value: reply.value ?? '', tail: reply.tail ?? '' };
  }

  /**
   * Text into a field: replacing a one-line field's text, added to the end of
   * a longer one's, or at the cursor (no field named, or one that isn't a
   * text field). A native field's value is set outright; a web page's, which
   * wouldn't notice that, is typed. Everything about the app and its focus is
   * checked before anything is written, and what was written is read back
   * before any Enter: a search or a message with the wrong words in it isn't
   * sent. A field holding more than the screen showed isn't replaced: that
   * would wipe text the model never saw. Text read back says so (`landed`);
   * with nothing to read, the answer is a plain ok.
   */
  async function type(snapshot, element, action) {
    if (element?.role === 'password') return { ok: false, detail: NO_PASSWORDS };
    // A tab typed is a Tab pressed: what follows it would go into the next field, which may be a password's.
    if (action.text.includes('\t')) return { ok: false, detail: 'Typed text can’t hold a tab (it moves to the next field): type each field on its own.' };
    if (action.after !== undefined) return typeAfter(snapshot, element, action);
    const shown = typeof element?.value === 'string' ? element.value : '';
    const lines = element?.role === 'textarea' || /[\r\n]/.test(shown);
    let mode = action.mode || (!element ? 'insert' : LINE_INPUTS.has(element.role) && !lines ? 'replace' : element.role === 'textarea' ? 'append' : 'insert');
    if (element && mode === 'replace' && lines) {
      // Its formatting, its lists and attachments, and whatever the screen didn't show of it would all go.
      if (element.role === 'textarea') {
        // An empty one has nothing to lose: adding to it is replacing it.
        if (shown || (await readField(snapshot, element, ''))?.length !== 0) {
          return { ok: false, detail: `A text area isn’t replaced whole (its formatting would go): to add, use mode append; to change all of it, press ${primary}+a and type with the field’s id in the same reply.` };
        }
        mode = 'append';
      } else {
        const before = await readField(snapshot, element, '');
        if (before && before.length > SHOWN_VALUE) return { ok: false, detail: `That field holds more lines than the screen showed (${before.length} characters), so it wasn’t replaced.` };
      }
    }
    /**
     * Whether it's typed where the app is, behind another: only into a field named by its id, whose focus is put
     * there first. Text where the cursor is, in an app that won't say where that is, waits for the app in front.
     */
    let there = false;
    /** The app in front, the focus in the field (when there is one), and nothing secret about it: before any key. */
    const here = async (place = null) => {
      if (!(await inFront(snapshot, place))) return notInFront(snapshot);
      if (element) await focus(snapshot, element);
      return keysMayGo(snapshot);
    };
    const target = { pid: snapshot.app?.pid, ...(snapshot.window?.id ? { window: snapshot.window.id } : {}) };
    // With Enter to come, the app and its focus are checked before the text goes in, not after.
    if (action.enter || !element || mode === 'insert') {
      const place = await placeOf(snapshot);
      there = place.behind && !!element && mode !== 'insert' && (await focusBehind(snapshot, element));
      if (!there) {
        const keys = await here(place);
        if (!keys.ok) return keys;
      }
    }
    let typed = false;
    let landed = false;
    if (element && mode !== 'insert') {
      let late = false;
      const set = await act(snapshot, element, mode === 'append' ? 'appendValue' : 'setValue', action.text).catch((err) => ((late = err?.code === 'timeout'), null));
      // No answer in time: the driver may still set it, and added again it would go in twice.
      if (late && mode === 'append') return { ok: false, detail: 'The app was busy: the text may have been added. Check the field before trying again.' };
      typed = set?.landed === true;
      landed = typed;
      // Set, but not as asked, or no answer: typing it again could add it twice (replacing is safe to redo; adding isn't).
      if (mode === 'append' && (set?.landed === false || set?.busy)) {
        return { ok: false, detail: set.busy ? 'The app was busy: the text may have been added. Check the field before trying again.' : `Added the text, but the field reads ${quoted(set.value)}: check it before trying again.` };
      }
    }
    if (!typed) {
      if (!action.enter && element && mode !== 'insert') {
        const place = await placeOf(snapshot);
        there = place.behind && (await focusBehind(snapshot, element));
        if (!there) {
          const keys = await here(place);
          if (!keys.ok) return keys;
        }
      }
      const before = element && mode === 'append' ? await readField(snapshot, element, '') : null;
      if (there) {
        // No ⌘A reaches an app behind others: all of the field is selected (or the caret put at its end) through
        // accessibility, read back, and the text sent to the app itself. Either refused, nothing has been typed,
        // and it's typed the usual way with the app in front.
        const sent =
          (await act(snapshot, element, 'select', mode === 'append' ? 'end' : 'all').then(() => true, () => false)) &&
          (await driver.call('textBehind', { ...target, text: action.text }).then(() => true, () => false));
        if (!sent) {
          there = false;
          const keys = await here();
          if (!keys.ok) return keys;
        }
      }
      if (!there) {
        if (element && mode === 'replace') await driver.call('key', { key: 'a', modifiers: [primary] });
        if (element && mode === 'append') await driver.call('key', platform === 'darwin' ? { key: 'down', modifiers: ['cmd'] } : { key: 'end', modifiers: ['ctrl'] });
        await driver.call('text', { text: action.text });
      }
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
        landed = !!now;
      }
    }
    if (action.enter) {
      // Sent to the app itself, into the field its focus was just put in. Refused there (another of its windows
      // has come in front of this one), it's pressed with the app in front, the focus where it was left.
      const pressed = there && (await driver.call('keyBehind', { ...target, key: 'enter', sure: true }).then(() => true, () => false));
      if (!pressed) {
        if (there) {
          there = false;
          const keys = await here();
          if (!keys.ok) return keys;
        }
        await driver.call('key', { key: 'enter', modifiers: [] });
      }
    }
    if (element) fieldFocus = { pid: snapshot.app?.pid, at: now() };
    return { ok: true, ...(landed ? { landed: true } : {}), ...(there ? { behind: true } : {}) };
  }

  /**
   * Text put in right after words already in a field (after Atticus's type-after), the rest of the field left as
   * it is: a correction in the middle of a note, a word added to a sentence. A field of the Mac's own takes it
   * through accessibility, wherever its app is, and is read back whole. One that only takes typed keys (a web
   * page's) has its caret put after the words, read back, and the text typed there with its app in front. The
   * words must be in the field exactly once: twice, and which was meant is anyone's guess, so nothing is typed.
   */
  async function typeAfter(snapshot, element, action) {
    if (!element) return { ok: false, detail: 'after needs the id of the field its words are in.' };
    const busy = { ok: false, detail: 'The app was busy: the text may have gone in. Check the field before trying again.' };
    const target = { pid: snapshot.app?.pid, ...(snapshot.window?.id ? { window: snapshot.window.id } : {}) };
    /** Typed where the app is, behind another (its focus put in the field through accessibility), not with it in front. */
    let there = false;
    const front = async (place = null) => {
      if (!(await inFront(snapshot, place))) return notInFront(snapshot);
      await focus(snapshot, element);
      return keysMayGo(snapshot);
    };
    /** Before any key: the field has its app's focus, where the app is if that can be, else with the app in front. */
    const ready = async () => {
      const place = await placeOf(snapshot);
      there = place.behind && (await focusBehind(snapshot, element));
      return there ? { ok: true } : front(place);
    };
    const caret = () =>
      act(snapshot, element, 'caretAfter', undefined, action.after).then(
        () => null,
        (err) => ({ ok: false, detail: changed(err) ? 'The screen changed before it could be typed; nothing was done.' : tidy(err?.message || err) })
      );
    // With Enter to come, the app and its focus are checked before the text goes in, not after.
    if (action.enter) {
      const keys = await ready();
      if (!keys.ok) return keys;
    }
    let set = null;
    try {
      set = await act(snapshot, element, 'insertAfter', action.text, action.after);
    } catch (err) {
      if (err?.code === 'timeout') return busy;
      if (changed(err)) return { ok: false, detail: 'The screen changed before it could be typed; nothing was done.' };
      if (!TYPE_INSTEAD.test(err?.message)) return { ok: false, detail: tidy(err?.message || err) };
    }
    let landed = true;
    if (set) {
      if (set.busy) return busy;
      if (set.landed !== true) return { ok: false, detail: `Put the text in, but the field reads ${quoted(set.value)}: check it before trying again.` };
    } else {
      if (!action.enter) {
        const keys = await ready();
        if (!keys.ok) return keys;
      }
      const before = await readField(snapshot, element, '');
      const lost = await caret();
      if (lost) return lost;
      if (there && !(await driver.call('textBehind', { ...target, text: action.text }).then(() => true, () => false))) {
        // It can't be typed there (nothing was sent): with the app in front, the caret put after the words again.
        there = false;
        const keys = await front();
        if (!keys.ok) return keys;
        const again = await caret();
        if (again) return again;
      }
      if (!there) await driver.call('text', { text: action.text });
      let read = null;
      for (let look = 0; look < READ_BACK_LOOKS; look++) {
        if (look) await wait(READ_BACK_MS);
        read = await readField(snapshot, element, `${action.after}${action.text}`);
        if (!read || (read.contains && (!before || read.length > before.length))) break;
      }
      if (read && !(read.contains && (!before || read.length > before.length))) {
        return { ok: false, detail: `The text didn’t land after ${quoted(action.after)}: the field reads ${quoted(read.value)}${action.enter ? ', so Enter wasn’t pressed' : ''}.` };
      }
      landed = !!read;
    }
    if (action.enter) {
      const pressed = there && (await driver.call('keyBehind', { ...target, key: 'enter', sure: true }).then(() => true, () => false));
      if (!pressed) {
        if (there) {
          there = false;
          const keys = await front();
          if (!keys.ok) return keys;
        }
        await driver.call('key', { key: 'enter', modifiers: [] });
      }
    }
    fieldFocus = { pid: snapshot.app?.pid, at: now() };
    return { ok: true, ...(landed ? { landed: true } : {}), ...(there ? { behind: true } : {}) };
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
    const reply = await act(snapshot, element, end ? 'scrollEnd' : 'scrollPage', action.direction).catch((err) => ((stale = changed(err)), null));
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

  /**
   * An icon at the right of the menu bar, opened by name (Wi-Fi, Battery, Control Center, an app's own), from
   * whatever app is in front: pressed through accessibility, no pointer. What it opens is then the screen
   * (observe), until it has closed. A wrong name comes back with the names there are.
   */
  async function menuBar(action) {
    let reply;
    try {
      reply = await quietly(() => driver.call('menuBar', { press: action.name, ...(exclude ? { exclude } : {}) }));
    } catch (err) {
      if (err?.code === 'timeout') return { ok: false, detail: 'The menu bar took too long to answer.' };
      return { ok: false, detail: tidy(err?.message || err) };
    }
    panel = reply?.opened === true;
    stay = null;
    const name = quoted(reply?.pressed || action.name);
    return panel ? { ok: true, detail: `opened ${name}`, ...(reply.busy ? { busy: true } : {}) } : { ok: true, detail: `pressed ${name}, but nothing opened that can be read` };
  }

  /**
   * A key or a shortcut. One that stands for a menu command (prepare found it: `runs`) is chosen as that command
   * when its app isn't in front: keys would go to whatever is, and bringing the app forward for them takes the
   * screen from what the user is doing. A web page keeps its keys (it may handle them itself), as does an app in
   * front, where keys are what a person would press.
   */
  async function pressKeys(snapshot, action, signal) {
    const plan = parseShortcut(action.keys);
    const runs = Array.isArray(action.runs) && action.runs.length ? action.runs : null;
    const said = runs ? runs.join(' › ') : '';
    const place = await placeOf(snapshot);
    // The field the step before put the focus in is where a key now goes: said, so a key that types isn't refused for not knowing.
    const sure = fieldFocus?.pid === snapshot.app?.pid && now() - fieldFocus.at < FIELD_FOCUS_MS;
    fieldFocus = null;
    if (!place.front && place.known && runs && !action.web) {
      let chosen = 0;
      let busy = false;
      for (let time = 0; time < (action.times || 1) && !signal?.aborted; time++) {
        if (time) await wait(KEY_GAP_MS);
        const reply = await quietly(() => driver.call('shortcut', { pid: snapshot.app.pid, key: plan.key, modifiers: plan.modifiers, press: true })).catch((err) => ({ failed: err }));
        // No answer: it opened something modal, as a menu command that does (menu()). Never pressed again as keys.
        if (reply.failed?.code === 'timeout') return { ok: true, busy: true, behind: true, detail: `chose ${said}; the app is busy` };
        if (reply.failed || reply.pressed !== true) break;
        chosen += 1;
        busy ||= reply.busy === true;
      }
      // Chosen at least once: the rest aren't made up for with keys, which would bring the app forward mid-way.
      if (chosen) return { ok: true, behind: true, detail: `chose ${said}`, ...(busy ? { busy: true } : {}) };
    }
    // A key that's no shortcut goes to the app itself, into its own keyboard focus. The driver refuses what it
    // can't be sure of (a password field, a focus it can't read for a key that types, another window in front
    // of this one): then, as before, the app comes to the front and the focus is checked from here.
    if (place.behind && !plan.modifiers.some((modifier) => modifier !== 'shift' && modifier !== 'alt')) {
      const window = snapshot.window?.id;
      const sent = await driver.call('keyBehind', { pid: snapshot.app.pid, key: plan.key, modifiers: plan.modifiers, times: action.times || 1, ...(window ? { window } : {}), ...(sure ? { sure: true } : {}) }).then(() => true, () => false);
      if (sent) return { ok: true, behind: true };
    }
    if (!(await inFront(snapshot, place))) return notInFront(snapshot);
    if (!HARMLESS_KEYS.has(plan.key)) {
      const keys = await keysMayGo(snapshot);
      if (!keys.ok) return keys;
    }
    for (let time = 0; time < (action.times || 1); time++) {
      if (time) await wait(KEY_GAP_MS);
      if (signal?.aborted) break;
      await driver.call('key', { key: plan.key, modifiers: plan.modifiers });
    }
    return said ? { ok: true, detail: `that’s ${said}` } : { ok: true };
  }

  /** Pressed on one control, moved in steps onto another, let go — always let go. */
  async function drag(snapshot, action) {
    const pickup = elementById(snapshot, action.from);
    const drop = elementById(snapshot, action.to);
    if (!middle(pickup?.frame) || !middle(drop?.frame)) return { ok: false, detail: 'Both ends must be controls on this screen.' };
    if (!(await inFront(snapshot))) return notInFront(snapshot);
    const fromAim = await aim(snapshot, pickup);
    if (!fromAim.at) return missed(fromAim, 'picked up');
    const toAim = await aim(snapshot, drop);
    if (!toAim.at) return missed(toAim, 'dropped there');
    const [from, to] = [fromAim.at, toAim.at];
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

  /**
   * The snapshot with its text areas' line breaks back: the driver squashes a
   * value's whitespace, so a finished list reads as one line. One with no
   * space in it has no break to lose. A copy, for the snapshot may be shared.
   */
  async function withLineBreaks(snapshot) {
    const flattened = (snapshot?.elements || []).filter((element) => element.role === 'textarea' && /\s/.test(typeof element.value === 'string' ? element.value : ''));
    const first = [...flattened.filter((element) => element.focused), ...flattened.filter((element) => !element.focused)].slice(0, LINED_FIELDS);
    const lined = new Map();
    for (const element of first) {
      const reply = await driver.call('act', { snapshot: snapshot.snapshot, element: element.id, action: 'read' }).catch(() => null);
      if (typeof reply?.value === 'string' && /[\r\n\u2028\u2029]/.test(reply.value)) lined.set(element.id, reply.value.slice(0, SHOWN_VALUE));
    }
    if (!lined.size) return snapshot;
    return { ...snapshot, elements: snapshot.elements.map((element) => (lined.has(element.id) ? { ...element, value: lined.get(element.id) } : element)) };
  }

  /** One read of a window (or of what a menu-bar icon opened), its text areas' line breaks back. */
  const read = (target) => quietly(async () => withLineBreaks(await driver.call('snapshot', { limit: 300, ...target })));

  /**
   * The screen: what a menu-bar icon opened while it's open; else the app a task is working on behind another,
   * while it's still behind; else the window in front.
   */
  async function observe() {
    if (panel) {
      const seen = await read({ panel: true }).catch(() => null);
      if (seen) return { ok: true, snapshot: seen };
      // Closed (chosen from, clicked away from, Escape): back to the windows.
      panel = false;
    }
    if (stay && !pid) {
      const front = await frontPid();
      const seen = front !== undefined && front !== stay ? await read({ pid: stay }).catch(() => null) : null;
      if (seen) return { ok: true, snapshot: seen };
      // In front again, or gone: it's read as any window in front is.
      stay = null;
    }
    const target = pid ? { pid } : exclude ? { exclude } : {};
    let failed = null;
    // Twice: a window can be mid-change (a sheet closing, a popup going away).
    for (let tries = 0; tries < 2; tries++) {
      if (failed) await wait(OBSERVE_RETRY_MS);
      try {
        return { ok: true, snapshot: await read(target) };
      } catch (err) {
        failed = err;
      }
    }
    return { ok: false, detail: failed.message };
  }

  /**
   * A picture of the window for the model's next step, from a fresh read: the
   * numbers drawn on it are that read's, so it's the next step's screen too,
   * whether or not the picture could be taken (the read before it is stale now).
   */
  async function screenshot(goal) {
    if (!picture) return { ok: false, detail: 'Pictures of the screen aren’t available here: work from the screen text.' };
    const seen = await observe();
    if (!seen.ok) return { ok: false, detail: 'The window couldn’t be read again to take its picture.' };
    const refused = pictureRefusal(seen.snapshot);
    if (refused) return { ok: false, detail: refused, snapshot: seen.snapshot };
    // It moves Jester's own windows aside itself, and waits for them to go.
    const taken = await picture(seen.snapshot, { goal }).catch((err) => ({ ok: false, detail: tidy(err?.message || err, 160) }));
    if (!taken?.ok) return { ok: false, detail: taken?.detail || 'No picture was taken.', snapshot: seen.snapshot };
    const count = taken.marked?.length ?? 0;
    // What it shows is kept with the read it's of: a place in it is a place on that screen, and no other.
    shot = taken.view ? { snapshot: seen.snapshot.snapshot, view: taken.view } : null;
    return {
      ok: true,
      detail: `a picture of the window comes with the next step, ${count} control${count === 1 ? '' : 's'} numbered`,
      image: taken.image,
      ...(taken.view ? { size: { width: taken.view.width, height: taken.view.height } } : {}),
      marked: taken.marked || [],
      snapshot: seen.snapshot
    };
  }

  async function perform(action, snapshot, signal, goal, verify = false) {
    const element = action.id === undefined ? null : elementById(snapshot, action.id);
    if (action.id !== undefined && !element) return { ok: false, detail: `There is no element ${action.id} on this screen.` };
    switch (action.action) {
      case 'click':
        return clicked(snapshot, element, action, verify);
      case 'type':
        return type(snapshot, element, action);
      case 'press':
        return pressKeys(snapshot, action, signal);
      case 'menu_bar':
        return menuBar(action);
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
        stay = null;
        const opened = await openApp(action.name);
        if (opened.ok) await wait(OPENED_MS);
        return { ok: opened.ok, detail: opened.text, ...(opened.ok ? {} : { front: false }) };
      }
      case 'open_url':
        stay = null;
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
      case 'screenshot':
        return screenshot(goal);
      default:
        return { ok: false, detail: `Jester can’t ${action.action}.` };
    }
  }

  return {
    observe,

    /** A task begins: nothing of the last one's app is held on to. What a menu-bar icon opened, if still open, is still the screen. */
    begin() {
      stay = null;
      shot = null;
      fieldFocus = null;
      frontOnly.clear();
    },

    /**
     * A click on a place in a picture of the window (x and y in its pixels), settled before it's judged: where that
     * is on screen, and what's there. Inside a listed control that presses, it becomes a click on that control, by
     * its id: judged by its name and pressed its own way. Else the place is kept (`at`) with whatever name
     * accessibility gives for what's under it (`under`), and it's clicked as a spot. The picture must be of this
     * very screen: after anything has been done, a place in it is a place in a screen gone by.
     * @returns {Promise<{ok:true, action:object}|{ok:false, detail:string}>}
     */
    async locate(action, snapshot) {
      if (!shot || shot.snapshot !== snapshot?.snapshot) return { ok: false, detail: 'x and y are a place in a picture of this screen, and there isn’t one: take a screenshot and click in the reply that follows it, or use an id.' };
      const { view } = shot;
      if (action.x > view.width || action.y > view.height) return { ok: false, detail: `That’s outside the picture, which is ${view.width} × ${view.height}.` };
      const at = { x: Math.round(view.x + (action.x / view.width) * view.w), y: Math.round(view.y + (action.y / view.height) * view.h) };
      const holds = (frame) => frame && frame.w > 0 && frame.h > 0 && at.x >= frame.x && at.y >= frame.y && at.x <= frame.x + frame.w && at.y <= frame.y + frame.h;
      const inside = (snapshot.elements || []).filter((element) => holds(element.frame));
      if (inside.some((element) => element.role === 'password')) return { ok: false, detail: NO_PASSWORDS };
      const control = inside.filter((element) => PRESSED_ROLES.has(element.role)).sort((a, b) => a.frame.w * a.frame.h - b.frame.w * b.frame.h)[0];
      const { x, y, what, ...rest } = action;
      if (control) return { ok: true, action: { ...rest, id: control.id } };
      const under = await quietly(() => driver.call('elementAt', { x: at.x, y: at.y, wait: false })).catch(() => null);
      if (under?.element?.secure || under?.actionable?.secure) return { ok: false, detail: NO_PASSWORDS };
      if (under?.app?.pid !== undefined && !sameApp(under.app.pid, snapshot.app)) return { ok: false, detail: `That spot is in ${under.app.name || 'another app'}’s window, not ${snapshot.app?.name || 'this one'}.` };
      // A name counts when it's the thing's own: a whole canvas or page called "Editor" names nothing at this spot.
      const named = [under?.actionable, under?.element].find((item) => item?.frame && item.frame.w <= SPOT_NAMED.w && item.frame.h <= SPOT_NAMED.h) || {};
      const name = tidy(named.title || named.description || (named.role === 'AXStaticText' ? named.value : '') || '', 80);
      return { ok: true, action: { ...rest, x, y, what, at, ...(name ? { under: name } : {}) } };
    },

    /** Whether a picture of the window can be taken now: a way to take one, and the OS and settings allowing it. */
    canPicture: () => !!picture && (picture.allowed ? picture.allowed() : true),

    /**
     * What a step needs settled before it is judged: a menu command's real
     * titles (whose last is what the user may be asked about), and whether it
     * can be chosen now. A level that can't be read without opening it comes
     * back as the model asked for it, which the press then takes word for
     * word. Mutates `action`: `resolved`.
     */
    async prepare(action, snapshot) {
      // A shortcut is the menu command it stands for, where the app's menus show one for it: known by name before
      // it's judged (⇧⌘D in Mail is Message › Send) and said in the result. Not found is no failure: the keys are pressed.
      if (action.action === 'press' && platform === 'darwin' && snapshot?.app?.pid && !snapshot.panel) {
        const plan = parseShortcut(action.keys);
        if (plan?.modifiers.includes('cmd')) {
          const found = await quietly(() => driver.call('shortcut', { pid: snapshot.app.pid, key: plan.key, modifiers: plan.modifiers })).catch(() => null);
          if (found?.found === true && Array.isArray(found.path) && found.path.length && found.path.every((title) => typeof title === 'string')) {
            action.runs = found.path.map((title) => tidy(title, 60));
            if (found.web === true) action.web = true;
          }
        }
        return { ok: true };
      }
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
     * What a field of the snapshot holds now, however long it is, and whether
     * that takes in `text`. Null when it can't be read, or is a password
     * field's, which is never read.
     * @returns {Promise<{length:number, value:string, tail:string, contains:boolean}|null>}
     */
    async peek(snapshot, id, text = '') {
      const element = elementById(snapshot, id);
      return element && element.role !== 'password' ? readField(snapshot, element, text) : null;
    },

    /**
     * Does it. With `verify`, a step whose effect shows on screen is checked:
     * the screen is read again, and the result says what changed (`changes`,
     * `changed`) and carries that read (`snapshot`) for the next step. A menu
     * command or a key whose effect the read can't show (bold text, a copy)
     * isn't "nothing changed" but unseen: `changed` is left unsaid. `patient`:
     * a slow app gets one more look before that's said. Cancelled (`signal`),
     * it stops where it is and reads nothing more. `goal` ranks which
     * controls a picture numbers when they can't all be.
     */
    async execute(action, snapshot, { verify = false, signal, patient = false, goal = '' } = {}) {
      // Whose turn the screen was before the step: a task's app behind another is checked where it is, not brought forward to be read.
      const frontBefore = verify && VISIBLE.has(action.action) && !snapshot?.panel && snapshot?.app?.pid ? await frontPid() : undefined;
      const { front, glanced, behind: behind_, ...result } = await perform(action, snapshot, signal, goal, verify);
      const behind = behind_ === true;
      // The app wouldn't come to the front, and macOS's own dialog is what's there: that's why, and it ends the
      // task (`asking`), since trying again can't help until the user has answered it.
      if (!result.ok && front === false && !signal?.aborted && (await systemDialog())) return { ok: false, asking: true, detail: MACOS_ASKING };
      if (!result.ok || !VISIBLE.has(action.action)) return result;
      await wait(result.busy ? BUSY_MS : SETTLE_MS);
      if (!verify || signal?.aborted) return result;
      // Done to an app that was behind another, and still is (the step brought nothing forward): it's the one read,
      // now and for the steps after. Anything else in front since is the step's own doing, and is read as it is.
      if (frontBefore !== undefined && snapshot?.app?.pid) {
        const wasBehind = !sameApp(frontBefore, snapshot.app);
        stay = wasBehind && (behind || (await frontPid()) === frontBefore) ? snapshot.app.pid : null;
      }
      let seen = await observe();
      if (!seen.ok) return result;
      let { changed, summary } = screenChanges(snapshot, seen.snapshot);
      if (!changed && patient && !signal?.aborted) {
        await wait(BUSY_MS);
        const again = await observe();
        if (again.ok) {
          seen = again;
          ({ changed, summary } = screenChanges(snapshot, seen.snapshot));
        }
      }
      // Nothing readable changed. A click may still have shown: on a canvas, a map, a video, what changes is pixels.
      if (!changed && glanced?.before && !signal?.aborted && glanceChanged(glanced.before, await glance(glanced.spot, glanced.window))) {
        return { ...result, changed: true, seenOnly: true, changes: PIXELS_CHANGED, snapshot: seen.snapshot };
      }
      // A click sent to an app behind others that showed nothing, read or seen: some apps take none that way. Said,
      // and from here on in this task its clicks are a hand's, with the app in front.
      if (!changed && behind && action.action === 'click' && snapshot?.app?.pid) {
        frontOnly.add(snapshot.app.pid);
        return { ...result, changed: false, changes: NOTHING_BEHIND, snapshot: seen.snapshot };
      }
      if (!changed && UNSEEN.has(action.action)) return { ...result, unseen: true, changes: 'No visible change (its effect may not show here).', snapshot: seen.snapshot };
      return { ...result, changed, changes: summary, snapshot: seen.snapshot };
    }
  };
}
