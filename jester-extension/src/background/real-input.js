/**
 * Chrome's own mouse and keyboard, through chrome.debugger, for the length of one
 * voice task. Sites receive trusted input — hover, press, typing — exactly as from
 * a person, which synthetic DOM events cannot promise: a page can ignore those, and
 * anything that waits for a real mouse move never sees one. The page script still
 * chooses where, and confirms the approved target is under the real pointer before
 * any press. Chrome shows "Jester started debugging this browser" while attached.
 *
 * The API is read when used, not when this module loads, so a worker without the
 * permission (or a test without the mock) simply reports real input unavailable.
 */
const PROTOCOL = '1.3';
const KEY_CODES = { Enter: 13, Escape: 27, Tab: 9, ' ': 32, Backspace: 8, Delete: 46, ArrowLeft: 37,
  ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34 };
const KEY_TEXT = { Enter: '\r', ' ': ' ' };

/** keyDown/keyUp for one key the agent may press; text keys carry their text so pages see input. */
export function keyEvents(key) {
  const name = key === 'Space' ? ' ' : key;
  if (Object.hasOwn(KEY_CODES, name)) {
    const text = KEY_TEXT[name];
    const base = { key: name, code: name === ' ' ? 'Space' : name,
      windowsVirtualKeyCode: KEY_CODES[name], nativeVirtualKeyCode: KEY_CODES[name] };
    return [{ ...base, type: text ? 'keyDown' : 'rawKeyDown', ...(text ? { text, unmodifiedText: text } : {}) },
      { ...base, type: 'keyUp' }];
  }
  if (typeof name === 'string' && /^[\p{L}\p{N}]$/u.test(name)) {
    const upper = name.toUpperCase();
    const ascii = /^[A-Z0-9]$/.test(upper);
    const base = { key: name, code: !ascii ? '' : /\d/.test(upper) ? `Digit${upper}` : `Key${upper}`,
      windowsVirtualKeyCode: ascii ? upper.charCodeAt(0) : 0, nativeVirtualKeyCode: ascii ? upper.charCodeAt(0) : 0 };
    return [{ ...base, type: 'keyDown', text: name, unmodifiedText: name }, { ...base, type: 'keyUp' }];
  }
  throw new Error('Unsupported key');
}

/**
 * @param onUserCancel called with the tab ID when the user dismisses Chrome's
 *        debugging bar, so the run in progress can stop asking for it.
 */
export function createRealInput({ api = () => globalThis.chrome?.debugger, onUserCancel } = {}) {
  /** tabId → { ready: Promise<boolean>, scale, last } */
  const sessions = new Map();
  /** tabId → a detach still in flight, which a new attach must wait out. */
  const detaching = new Map();
  let listening = false;
  const debuggerApi = () => api();
  const command = (tabId, method, params) => debuggerApi().sendCommand({ tabId }, method, params);
  const mouse = (tabId, params) => command(tabId, 'Input.dispatchMouseEvent', params);

  function listen() {
    if (listening || !debuggerApi()?.onDetach?.addListener) return;
    listening = true;
    debuggerApi().onDetach.addListener((source, reason) => {
      sessions.delete(source?.tabId);
      if (reason === 'canceled_by_user') onUserCancel?.(source?.tabId);
    });
  }

  /** Where the page will see a point: debugger units are scaled until a trusted move proves them. */
  const scaled = (tabId, x, y) => {
    const scale = sessions.get(tabId)?.scale || 1;
    return { x: x * scale, y: y * scale };
  };

  return {
    supported: () => typeof debuggerApi()?.attach === 'function',
    attached: (tabId) => sessions.has(tabId),

    /** Attaches once per tab; false when Chrome or the page will not allow it. */
    async attach(tabId) {
      if (typeof debuggerApi()?.attach !== 'function') return false;
      listen();
      let session = sessions.get(tabId);
      if (!session) {
        const previous = detaching.get(tabId);
        session = { scale: 1, last: null, ready: Promise.resolve(previous)
          .then(() => debuggerApi().attach({ tabId }, PROTOCOL)).then(() => true, () => false) };
        sessions.set(tabId, session);
      }
      const ok = await session.ready;
      if (!ok && sessions.get(tabId) === session) sessions.delete(tabId);
      return ok && sessions.get(tabId) === session;
    },

    /** Detaches, which also takes Chrome's debugging bar away. */
    release(tabId) {
      const session = sessions.get(tabId);
      if (!session) return Promise.resolve();
      sessions.delete(tabId);
      const detach = session.ready
        .then((ok) => ok && debuggerApi()?.detach({ tabId }))
        .catch(() => undefined)
        .finally(() => { if (detaching.get(tabId) === detach) detaching.delete(tabId); });
      detaching.set(tabId, detach);
      return detach;
    },

    /**
     * Corrects the scale from where the page saw the pointer land, for pages whose
     * zoom makes debugger units differ from CSS pixels.
     */
    calibrate(tabId, wanted, seen) {
      const session = sessions.get(tabId);
      const axis = Math.abs(wanted.x) >= Math.abs(wanted.y) ? 'x' : 'y';
      if (!session || !(seen?.[axis] > 0) || !(wanted[axis] > 0)) return false;
      session.scale *= wanted[axis] / seen[axis];
      return Number.isFinite(session.scale) && session.scale > 0.2 && session.scale < 5;
    },

    async move(tabId, x, y) {
      const session = sessions.get(tabId);
      const at = scaled(tabId, x, y);
      // A move to where the pointer already rests may never reach the page as an event.
      if (session?.last && Math.abs(session.last.x - at.x) < 1 && Math.abs(session.last.y - at.y) < 1) {
        await mouse(tabId, { type: 'mouseMoved', x: at.x + 2, y: at.y + 2, button: 'none', buttons: 0 });
      }
      await mouse(tabId, { type: 'mouseMoved', x: at.x, y: at.y, button: 'none', buttons: 0 });
      if (session) session.last = at;
    },

    async press(tabId, x, y) {
      const at = scaled(tabId, x, y);
      await mouse(tabId, { type: 'mousePressed', x: at.x, y: at.y, button: 'left', buttons: 1, clickCount: 1 });
      await mouse(tabId, { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', buttons: 0, clickCount: 1 });
    },

    insertText: (tabId, text) => command(tabId, 'Input.insertText', { text }),

    /** The visible viewport as base64 JPEG; works whether or not the tab is in front. */
    async screenshot(tabId) {
      const { data } = await command(tabId, 'Page.captureScreenshot', { format: 'jpeg', quality: 70, captureBeyondViewport: false });
      return data;
    },

    async key(tabId, name) {
      for (const event of keyEvents(name)) await command(tabId, 'Input.dispatchKeyEvent', event);
    }
  };
}
