/**
 * The window's screens, on one strip from left to right: a chat, Chats (and
 * Tasks, in the same place), the orb, Settings, then Settings' pages. Going from one to another slides the new
 * one in from the side it's on and pushes the old one out the other way, so
 * Chats comes in from the left of the orb and Settings from the right, as their
 * buttons sit, and going back slides it all the other way.
 */

/** Where a screen sits on the strip. */
export function placeOf(screen) {
  const name = String(screen);
  if (name === 'chat') return -2;
  if (name === 'chats' || name === 'tasks') return -1;
  if (name === 'settings') return 1;
  if (name.startsWith('settings/')) return 2;
  return 0;
}

/** Which side the new screen comes in from: 1 the right, -1 the left. Between Settings' pages, the right. */
export function direction(from, to) {
  return placeOf(to) < placeOf(from) ? -1 : 1;
}

/** One step back toward the orb, or null from the orb itself. */
export function backOf(screen) {
  const name = String(screen);
  if (name === 'chat') return 'chats';
  if (name.startsWith('settings/')) return 'settings';
  if (name === 'chats' || name === 'tasks' || name === 'settings') return 'main';
  return null;
}

const SLIDE_MS = 420;
const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';

/**
 * @param {object} options
 * @param {HTMLElement} options.root  holds an element per screen, `data-screen` naming it, one of them `.shown`
 * @param {(screen:string, from:string) => void} [options.onChange]  as a screen starts coming in
 */
export function createScreens({ root, onChange = () => undefined }) {
  const element = (screen) => root.querySelector(`[data-screen="${CSS.escape(String(screen))}"]`);
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  let current = root.querySelector('.screen.shown')?.dataset.screen || 'main';
  /** The slide going on, to be finished at once should another start. */
  let sliding = null;

  function show(el, on) {
    el.classList.toggle('shown', on);
    el.inert = !on;
  }

  function settle() {
    const done = sliding;
    sliding = null;
    done?.();
  }

  /** Focus goes with the screen: the box to type in on the orb's, the way back on the others. */
  function focusIn(el) {
    const target = el.querySelector('[data-autofocus]') || el.querySelector('.top [data-go]');
    target?.focus({ preventScroll: true });
  }

  /**
   * @param {string} screen
   * @param {{instant?:boolean, focus?:boolean}} [options]  instant: no slide
   * @returns {boolean} whether it went
   */
  function go(screen, { instant = false, focus = true } = {}) {
    const next = element(screen);
    if (!next || screen === current) return false;
    settle();
    const from = current;
    const prev = element(from);
    current = screen;
    show(next, true);
    onChange(screen, from);
    if (instant || still.matches || !prev) {
      if (prev) show(prev, false);
    } else {
      const dir = direction(from, screen);
      const timing = { duration: SLIDE_MS, easing: EASE };
      prev.inert = true;
      // Nothing takes a click till it's in place: a double-click's second would land on what's sliding in.
      root.classList.add('sliding');
      const incoming = next.animate([{ transform: `translateX(${dir * 100}%)` }, { transform: 'translateX(0)' }], timing);
      const outgoing = prev.animate(
        [
          { transform: 'translateX(0)', opacity: 1 },
          { transform: `translateX(${-dir * 100}%)`, opacity: 0.35 }
        ],
        { ...timing, fill: 'forwards' }
      );
      const done = () => {
        root.classList.remove('sliding');
        incoming.cancel();
        outgoing.cancel();
        // Unless it's been gone back to meanwhile.
        if (prev.dataset.screen !== current) show(prev, false);
      };
      sliding = done;
      outgoing.onfinish = () => sliding === done && settle();
    }
    if (focus) focusIn(next);
    return true;
  }

  return {
    go,
    back: () => {
      const to = backOf(current);
      return to ? go(to) : false;
    },
    get current() {
      return current;
    }
  };
}
