/**
 * The extension's half of the link to Jester Desktop (the app's half is
 * desktop/src/main/chrome-link.js, where the messages are listed).
 *
 * The user turns it on from Settings, which asks Chrome for the
 * nativeMessaging permission; having it is the switch. Connecting starts the
 * app's relay, which reaches the app if it's running. If it isn't, the relay
 * says so and goes, and this tries again every half minute: the app can't
 * reach an extension by itself. While linked, the open port keeps the worker
 * awake, so a command from the app is never waiting on it to start.
 */

export const DESKTOP_HOST = 'com.jester.desktop';
export const LINK_STATE = Object.freeze({ OFF: 'off', MISSING: 'missing', WAITING: 'waiting', LINKED: 'linked' });
const RETRY_ALARM = 'jester-desktop-link';
/** Chrome's shortest alarm. */
const RETRY_MINUTES = 0.5;
/** How long starting up waits to learn whether the app has the camera, before opening Jester's own. */
const FIRST_TRY_MS = 1500;
/** What the app needs to know of the extension's settings: what each gesture does. */
const BINDING_KEYS = ['bindings', 'windowedBindings', 'swipeBindings', 'windowedSwipeBindings', 'windowedBindingsEnabled'];

export const desktopBindings = (settings) => Object.fromEntries(BINDING_KEYS.filter((key) => key in (settings || {})).map((key) => [key, settings[key]]));

/**
 * @param {object} deps
 * @param {() => typeof chrome} [deps.api]
 * @param {string} deps.version  this extension's
 * @param {() => Promise<object>} deps.settings
 * @param {(id:string, text:string) => Promise<{ok:boolean, say:string}>} deps.task  a command from the app, carried out
 * @param {() => void} deps.cancel  the app stopped it
 * @param {(op:string, args:object) => Promise<unknown>} deps.request  a question from the app: knows, aim, act
 * @param {(state:string, detail:string) => void} [deps.onChange]
 */
export function createDesktopLink({ api = () => globalThis.chrome, version, settings, task, cancel, request, onChange = () => undefined }) {
  const chrome = api;
  let port = null;
  let state = LINK_STATE.OFF;
  let detail = '';
  let next = 0;
  const asking = new Map();
  let firstTry = null;
  let settleFirst = () => undefined;

  const permitted = async () => {
    try {
      return await chrome().permissions.contains({ permissions: ['nativeMessaging'] });
    } catch {
      return false;
    }
  };

  function become(next, why = '') {
    // Whatever it is, it's now known whether the app has the camera.
    settleFirst();
    if (next === state && why === detail) return;
    state = next;
    detail = why;
    if (state === LINK_STATE.LINKED || state === LINK_STATE.OFF) chrome().alarms?.clear(RETRY_ALARM);
    else chrome().alarms?.create(RETRY_ALARM, { periodInMinutes: RETRY_MINUTES });
    if (state !== LINK_STATE.LINKED) for (const [id, resolve] of asking) (asking.delete(id), resolve(false));
    onChange(state, detail);
  }

  const post = (message) => {
    if (!port || state !== LINK_STATE.LINKED) return false;
    try {
      port.postMessage(message);
      return true;
    } catch {
      return false;
    }
  };

  async function onMessage(message) {
    switch (message?.type) {
      case 'welcome':
        return become(LINK_STATE.LINKED);
      case 'jester/link-error':
        return become(LINK_STATE.WAITING, String(message.detail || 'Jester Desktop isn’t running.'));
      case 'task': {
        const result = await task(String(message.id), String(message.text || '')).catch((err) => ({ ok: false, say: String(err?.message || err) }));
        return void post({ type: 'done', id: message.id, ok: !!result?.ok, say: String(result?.say || '') });
      }
      case 'cancel':
        return cancel();
      case 'answer':
        asking.get(String(message.id))?.(message.approved === true);
        return asking.delete(String(message.id));
      case 'request': {
        const { id, op, type: _type, ...args } = message;
        const result = await request(String(op), args).catch(() => null);
        return void post({ type: 'reply', id, result });
      }
      default:
        return undefined;
    }
  }

  async function connect() {
    if (port) return;
    if (!(await permitted())) return become(LINK_STATE.OFF);
    if (port) return;
    let opened;
    try {
      opened = chrome().runtime.connectNative(DESKTOP_HOST);
    } catch (err) {
      return become(LINK_STATE.MISSING, String(err?.message || err));
    }
    port = opened;
    opened.onMessage.addListener((message) => void onMessage(message));
    opened.onDisconnect.addListener(() => {
      const error = chrome().runtime.lastError?.message || '';
      if (port !== opened) return;
      port = null;
      // Chrome's words when no manifest names the app: it isn't installed, or hasn't run since.
      if (/not found/i.test(error)) become(LINK_STATE.MISSING, 'Jester Desktop isn’t installed, or hasn’t been opened yet.');
      else if (state !== LINK_STATE.OFF) become(LINK_STATE.WAITING, state === LINK_STATE.WAITING && detail ? detail : 'Jester Desktop isn’t running.');
    });
    opened.postMessage({ type: 'hello', version, settings: desktopBindings(await settings()) });
  }

  chrome().alarms?.onAlarm.addListener((alarm) => alarm.name === RETRY_ALARM && connect());
  chrome().permissions?.onAdded?.addListener(({ permissions = [] }) => permissions.includes('nativeMessaging') && connect());
  chrome().permissions?.onRemoved?.addListener(({ permissions = [] }) => {
    if (!permissions.includes('nativeMessaging')) return;
    const closing = port;
    port = null;
    closing?.disconnect();
    become(LINK_STATE.OFF);
  });

  return {
    /** Connects, if the user has turned the link on. */
    start() {
      firstTry ||= new Promise((resolve) => {
        settleFirst = resolve;
        setTimeout(resolve, FIRST_TRY_MS);
      });
      connect();
      return firstTry;
    },
    /** Resolves once it's known whether the app is there, or a moment has passed: before Jester opens its own camera. */
    ready: () => firstTry || Promise.resolve(),
    get state() {
      return state;
    },
    get detail() {
      return detail;
    },
    get linked() {
      return state === LINK_STATE.LINKED;
    },
    /** A frame for the app's pill, in place of this one's. */
    pill: (voice) => post({ type: 'pill', voice }),
    /** The app asks the user, and listens for their answer. */
    ask(label, signal) {
      const id = String(++next);
      return new Promise((resolve) => {
        if (!post({ type: 'ask', id, label: String(label).slice(0, 400) })) return resolve(false);
        asking.set(id, resolve);
        signal?.addEventListener('abort', () => (asking.delete(id), resolve(false)), { once: true });
      });
    },
    /** Jester's voice shortcut or gesture, here: the app's mic answers it. */
    voice: () => post({ type: 'voice' }),
    /** What the gestures do changed. */
    settingsChanged: (next) => post({ type: 'settings', settings: desktopBindings(next) })
  };
}
