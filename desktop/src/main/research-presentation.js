/**
 * A search's progress, and the × that stops it: in his window while it's open, as the user asked (2026-11-16: "do
 * not show the pill when doing this if the desktop app is open"), and on the pill only while it isn't (hidden,
 * minimized or closed). Only a search's: everything else on the pill goes where it always went (main.js
 * showConversation), and the bar in his window says what's being searched for whoever asked (a briefing too).
 */
import { MSG } from '../../../jester-extension/src/common/constants.js';

/** Open: shown and not minimized. Unfocused, or on Settings, it's still open: the user's word was "open". */
export function homeVisible(win) {
  return !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized();
}

/** Clears the pill (overlay.js hideVoice, never his speaking): the search, and what led up to it, are in his window. */
const OVER = { type: MSG.VOICE, voice: { active: false } };

export function createResearchPresentation({ home, post, postTo, overlays = () => [], stopButton }) {
  let research = { active: false, phase: 'idle', label: '' };
  /** Whose search the bar shows, and what its Stop does: only they clear it, so an older one ending can't. */
  let owner = null;
  let halt = null;
  /** A search is the task at work (assistant.js, kind 'research'). */
  let searching = false;
  /** Its last step, for the pill if his window goes. */
  let latest = null;
  /** Where it's shown now: 'home', 'pill', or null with no search at work. */
  let shown = null;
  /** A show or hide event, believed over the window's own flags until they agree: they can lag it. */
  let told = null;

  function open() {
    const win = home();
    const flags = homeVisible(win);
    if (told && told.window === win && told.visible !== flags) return told.visible;
    told = null;
    return flags;
  }

  function sendState() {
    const win = home();
    if (win && !win.isDestroyed()) postTo(win.webContents, { type: 'jester/research-state', research });
  }

  /** The search, where it's seen. Only on a change, so the × isn't made again under a click on it. */
  function place() {
    const where = searching ? (open() ? 'home' : 'pill') : null;
    if (where === shown) return;
    shown = where;
    if (where === 'home') {
      stopButton()?.hide();
      for (const win of overlays()) if (!win.isDestroyed()) postTo(win.webContents, OVER);
    } else if (where === 'pill') {
      stopButton()?.show();
      if (latest) post(latest);
    }
  }

  return {
    state: () => ({ ...research }),
    /** His window asked for it, or was shown, hidden, minimized or closed (`visible`: what the event said). */
    sync({ visible } = {}) {
      if (typeof visible === 'boolean') told = { window: home(), visible };
      sendState();
      place();
    },
    /** Each tick (main.js watchFront): a window macOS hid without saying so. Three flags, read only mid-search. */
    observe() {
      if (searching) place();
    },
    /** The bar in his window. `owner`: whose search it is; `stop`: what its Stop does. */
    update(next, { owner: who = null, stop = null } = {}) {
      if (!next.active && who && owner && who !== owner) return;
      const score = Number.isFinite(next.scrapeConfidence)
        ? { scrapeConfidence: Math.round(Math.max(0, Math.min(100, next.scrapeConfidence))), strategyReason: String(next.strategyReason || '').slice(0, 300) }
        : {};
      research = next.active
        ? { active: true, phase: String(next.phase || 'searching').slice(0, 40), label: String(next.label || 'Searching the internet…').slice(0, 240), goal: String(next.goal || research.goal || '').slice(0, 300), ...score }
        : { active: false, phase: ['clarifying', 'review'].includes(next.phase) ? next.phase : 'idle', label: '', ...score };
      if (next.active) {
        owner = who;
        halt = stop;
      } else {
        owner = null;
        halt = null;
        latest = null;
      }
      sendState();
    },
    /** The bar's Stop: whatever it's showing, and nothing else. */
    stop() {
      halt?.();
    },
    /** A task begun or over (assistant.js onBusy): a search's × goes where the search is; any other's, as ever. */
    busy(on, { kind = 'task' } = {}) {
      searching = on && kind === 'research';
      if (searching) return place();
      latest = null;
      shown = null;
      if (on) stopButton()?.show();
      else stopButton()?.hide();
    },
    /** A task's step for the pill: a search's goes to his window while it's open. */
    voice(voice, { kind = 'task' } = {}) {
      const message = { type: MSG.VOICE, voice: { position: 'bottom-center', ...voice } };
      if (kind !== 'research' || !searching) return post(message);
      latest = voice.done ? null : message;
      place();
      const win = home();
      if (shown === 'home' && win && !win.isDestroyed()) postTo(win.webContents, message);
      else post(message);
    }
  };
}
