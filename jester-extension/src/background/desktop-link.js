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
 *
 * Chrome gives a worker runtime.connectNative only if it held the permission
 * when it started: one already running when the user says Link never gets it.
 * So that worker reloads the extension once, and the next one connects.
 */

export const DESKTOP_HOST = 'com.jester.desktop';
export const LINK_STATE = Object.freeze({ OFF: 'off', MISSING: 'missing', WAITING: 'waiting', LINKED: 'linked', RESTART: 'restart' });
const RETRY_ALARM = 'jester-desktop-link';
/** Chrome's shortest alarm. */
const RETRY_MINUTES = 0.5;
/** How long starting up waits to learn whether the app has the camera, before opening Jester's own. */
const FIRST_TRY_MS = 1500;
/** When the extension last reloaded to get connectNative, and whether Settings was open then. */
const RESTART_KEY = 'desktopLinkRestart';
/** A reload this recent that still didn't bring connectNative won't be followed by another: Chrome itself needs restarting. */
const RESTART_GUARD_MS = 60_000;
/** Includes a headless page load, without keeping the worker waiting indefinitely. */
const SCRAPE_MS = 90_000;
const SETTINGS_PAGE = 'src/options/options.html';
/** What the app needs to know of the extension's settings: what each gesture does. */
const BINDING_KEYS = ['bindings', 'windowedBindings', 'swipeBindings', 'windowedSwipeBindings', 'windowedBindingsEnabled'];

export const desktopBindings = (settings) => Object.fromEntries(BINDING_KEYS.filter((key) => key in (settings || {})).map((key) => [key, settings[key]]));

/**
 * @param {object} deps
 * @param {() => typeof chrome} [deps.api]
 * @param {string} deps.version  this extension's
 * @param {() => Promise<object>} deps.settings
 * @param {(id:string, text:string, meant:string) => Promise<{ok:boolean, say:string}>} deps.task  a command from the app,
 *   carried out; `meant`: what the app's conversation took the words to mean, or ''
 * @param {() => void} deps.cancel  the app stopped it
 * @param {(op:string, args:object, options?:{signal:AbortSignal}) => Promise<unknown>} deps.request  a question from the app: knows, aim, act, web
 * @param {(state:string, detail:string) => void} [deps.onChange]
 */
export function createDesktopLink({ api = () => globalThis.chrome, version, settings, task, cancel, request, onChange = () => undefined, scrapeTimeoutMs = SCRAPE_MS }) {
  const chrome = api;
  let port = null;
  let state = LINK_STATE.OFF;
  let detail = '';
  let next = 0;
  const asking = new Map();
  const scraping = new Map();
  const webRequests = new Map();
  let scraperAvailable = false;
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
    if (state === LINK_STATE.LINKED || state === LINK_STATE.OFF || state === LINK_STATE.RESTART) chrome().alarms?.clear(RETRY_ALARM);
    else chrome().alarms?.create(RETRY_ALARM, { periodInMinutes: RETRY_MINUTES });
    if (state !== LINK_STATE.LINKED) {
      scraperAvailable = false;
      for (const [id, resolve] of asking) (asking.delete(id), resolve(false));
      for (const pending of [...scraping.values()]) pending.finish({ ok: false, code: 'scrape_unavailable', detail: 'The link to Jester Desktop closed before the web request finished.' });
      for (const controller of webRequests.values()) controller.abort();
      webRequests.clear();
    }
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
        scraperAvailable = message.scraping === true;
        return become(LINK_STATE.LINKED);
      case 'scrape-result':
        return scraping.get(String(message.id))?.finish(message.result && typeof message.result === 'object'
          ? message.result : { ok: false, code: 'scrape_failed', detail: 'Jester Desktop returned no web data.' });
      case 'jester/link-error':
        return become(LINK_STATE.WAITING, String(message.detail || 'Jester Desktop isn’t running.'));
      case 'task': {
        const result = await task(String(message.id), String(message.text || ''), String(message.meant || ''), { skipResearch: message.skipResearch === true }).catch((err) => ({ ok: false, say: String(err?.message || err) }));
        return void post({ type: 'done', id: message.id, ok: !!result?.ok, say: String(result?.say || ''), ...(typeof result?.answer === 'string' ? { answer: result.answer.slice(0, 6000) } : {}), ...(Array.isArray(result?.sources) ? { sources: result.sources.slice(0, 24) } : {}), ...(Array.isArray(result?.trace) ? { trace: result.trace.slice(-40).map((line) => String(line).slice(0, 220)) } : {}) });
      }
      case 'cancel':
        return cancel();
      case 'answer':
        asking.get(String(message.id))?.(message.approved === true);
        return asking.delete(String(message.id));
      case 'request': {
        const { id, op, type: _type, ...args } = message;
        if (op === 'web') {
          if (state !== LINK_STATE.LINKED || typeof id !== 'string' || id.length > 80 || webRequests.has(id)) return;
          if (webRequests.size >= 8) return void post({ type: 'reply', id, result: { ok: false, code: 'browser_busy', detail: 'Too many background page reads are already running.' } });
          const controller = new AbortController();
          webRequests.set(id, controller);
          const result = await request('web', args, { signal: controller.signal }).catch(() => ({ ok: false, code: 'browser_failed', detail: 'The background page read failed.' }));
          if (webRequests.get(id) !== controller) return;
          webRequests.delete(id);
          if (!controller.signal.aborted) post({ type: 'reply', id, result });
          return;
        }
        const result = await request(String(op), args).catch(() => null);
        return void post({ type: 'reply', id, result });
      }
      case 'web-cancel': {
        const controller = webRequests.get(message.id);
        webRequests.delete(message.id);
        controller?.abort();
        return;
      }
      default:
        return undefined;
    }
  }

  /** Reloads the extension, so a worker that starts with the permission connects; Settings, if open, opens again after. */
  async function restartForLink() {
    const store = chrome().storage?.local;
    const last = (await store?.get(RESTART_KEY).catch(() => null))?.[RESTART_KEY];
    if (!store || typeof chrome().runtime.reload !== 'function' || Date.now() - (last?.at || 0) < RESTART_GUARD_MS) {
      return become(LINK_STATE.RESTART, 'Quit and reopen Chrome to finish linking.');
    }
    const settingsPage = chrome().runtime.getURL(SETTINGS_PAGE);
    const tabs = await chrome().runtime.getContexts?.({ contextTypes: ['TAB'] }).catch(() => []);
    const reopen = (tabs || []).some((context) => String(context.documentUrl || '').startsWith(settingsPage));
    await store.set({ [RESTART_KEY]: { at: Date.now(), reopen } });
    chrome().runtime.reload();
  }

  /** After that reload: Settings back where the user was. */
  async function reopenSettings() {
    const store = chrome().storage?.local;
    const last = (await store?.get(RESTART_KEY).catch(() => null))?.[RESTART_KEY];
    if (!last?.reopen) return;
    await store.set({ [RESTART_KEY]: { ...last, reopen: false } });
    await chrome().tabs?.create({ url: chrome().runtime.getURL(`${SETTINGS_PAGE}#desktop`) });
  }

  async function connect() {
    if (port) return;
    if (!(await permitted())) return become(LINK_STATE.OFF);
    if (port) return;
    if (typeof chrome().runtime.connectNative !== 'function') return restartForLink();
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
      reopenSettings().catch(() => undefined);
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
    /** Older apps do not advertise a scraper; their ordinary browser link still works. */
    get scraping() {
      return state === LINK_STATE.LINKED && scraperAvailable;
    },
    /** Read web data through the desktop's Scrapling worker; no Chrome tab is opened or focused. */
    scrape(request, { signal } = {}) {
      if (signal?.aborted) return Promise.reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
      if (state !== LINK_STATE.LINKED || !scraperAvailable) return Promise.resolve({ ok: false, code: 'scrape_unavailable', detail: 'Open an updated Jester Desktop and link it from Settings to use Scrapling.' });
      const id = String(++next);
      return new Promise((resolve, reject) => {
        const finish = (result, error) => {
          if (!scraping.delete(id)) return;
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          if (error) reject(error); else resolve(result);
        };
        const abort = () => {
          post({ type: 'scrape-cancel', id });
          finish(null, Object.assign(new Error('cancelled'), { name: 'AbortError' }));
        };
        const timer = setTimeout(() => {
          post({ type: 'scrape-cancel', id });
          finish({ ok: false, code: 'scrape_timeout', detail: 'The background web request timed out.' });
        }, Math.max(1, scrapeTimeoutMs));
        scraping.set(id, { finish });
        signal?.addEventListener('abort', abort, { once: true });
        if (!post({ type: 'scrape', id, request })) finish({ ok: false, code: 'scrape_unavailable', detail: 'Jester Desktop is no longer linked.' });
      });
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
