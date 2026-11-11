/**
 * Jester Desktop and its Chrome extension, linked (link.js carries the
 * messages; the extension's half is src/background/desktop-link.js). While
 * they are:
 *
 * - the app has the camera and mic, and the extension's own engine sleeps;
 * - with the linked browser in front, a gesture does what the extension's
 *   settings say it does, and the extension does it to the page;
 * - a spoken command for the browser (its bookmarks, tabs and pages) is the
 *   extension's to carry out, on the app's pill, its questions asked by the app;
 * - a click aimed at a page lands on the link or button nearest it, found by
 *   the extension as its own cursor's are.
 *
 * Messages are JSON objects with a `type`:
 *   from the extension: hello {version, settings}, settings {settings}, pill {voice},
 *     ask {id, label}, done {id, ok, say}, reply {id, result}, voice {}
 *   to it: welcome {version}, task {id, text, meant?}, answer {id, approved}, cancel {},
 *     request {id, op, ...}, op being knows {text}, aim {x, y, radius} or act {action, source, gesture}
 */

/** How long each question to the extension may take before it's taken as a no. */
export const REQUEST_MS = Object.freeze({ knows: 600, aim: 250, act: 3000 });
/** The extension's settings that say what a gesture does in Chrome. */
const BINDING_KEYS = ['bindings', 'windowedBindings', 'swipeBindings', 'windowedSwipeBindings', 'windowedBindingsEnabled'];

/** Words that make a command the browser's whatever is in front. */
const BROWSERISH = /\b(?:bookmarks?|bookmarked|tabs?|browser|chrome|web\s?sites?|web\s?pages?|this page|the page|links?|urls?|google|youtube|netflix|hulu|gmail|history)\b|\b[a-z0-9-]+\.(?:com|org|net|edu|io|gov|co|tv|app|dev)\b/i;

export const browserish = (text) => BROWSERISH.test(String(text || ''));

/**
 * @param {object} deps
 * @param {(message:object) => boolean} deps.send  to the extension; false when it isn't there
 * @param {string} deps.version  the app's
 * @param {() => void} [deps.onChange]  linked, unlinked, or the extension's settings changed
 * @param {(voice:object) => void} [deps.onPill]  a frame for the app's pill
 * @param {(label:string) => Promise<boolean>} [deps.onAsk]  the user's yes or no to a step
 * @param {() => void} [deps.onVoice]  the extension's shortcut or gesture, for the app's mic
 * @param {(...parts:any[]) => void} [deps.log]
 */
export function createChromeLink({ send, version, onChange = () => undefined, onPill = () => undefined, onAsk = async () => false, onVoice = () => undefined, log = () => undefined }) {
  let linked = null;
  let browser = null;
  let next = 0;
  const pending = new Map();
  let task = null;

  function settle(id, result) {
    const waiting = pending.get(id);
    if (!waiting) return;
    pending.delete(id);
    clearTimeout(waiting.timer);
    waiting.resolve(result);
  }

  /** A question for the extension: its answer, or `fallback` if it's gone or slow. */
  function request(op, args, fallback = null) {
    if (!linked) return Promise.resolve(fallback);
    const id = String(++next);
    return new Promise((resolve) => {
      pending.set(id, { resolve, timer: setTimeout(() => settle(id, fallback), REQUEST_MS[op] ?? 1000) });
      if (!send({ type: 'request', id, op, ...args })) settle(id, fallback);
    });
  }

  function finishTask(result) {
    const current = task;
    task = null;
    current?.resolve(result);
  }

  function cancel() {
    if (!task) return;
    send({ type: 'cancel' });
    finishTask(null);
  }

  return {
    /** The extension connected: it says hello next. `hello.browser`: the browser's process, from the relay. */
    connected(origin, hello = {}) {
      browser = hello.browser ?? null;
      log('chrome link: connected from', origin, browser ? `(browser ${browser})` : '');
    },

    message(message) {
      switch (message?.type) {
        case 'hello':
          linked = { version: String(message.version || ''), settings: message.settings || {} };
          send({ type: 'welcome', version });
          log('chrome link: linked to Jester', linked.version);
          return onChange();
        case 'settings':
          if (!linked) return undefined;
          linked.settings = message.settings || {};
          return onChange();
        case 'pill':
          return onPill(message.voice || {});
        case 'ask':
          return void onAsk(String(message.label || '')).then(
            (approved) => send({ type: 'answer', id: message.id, approved: approved === true }),
            () => send({ type: 'answer', id: message.id, approved: false })
          );
        case 'done':
          if (task?.id === message.id) finishTask({ ok: message.ok === true, text: String(message.say || '') });
          return undefined;
        case 'reply':
          return settle(String(message.id), message.result ?? null);
        case 'voice':
          return onVoice();
        default:
          return undefined;
      }
    },

    disconnected() {
      const was = !!linked;
      linked = null;
      browser = null;
      for (const id of [...pending.keys()]) settle(id, null);
      finishTask({ ok: false, text: 'The link to Chrome closed before that was done.' });
      if (was) {
        log('chrome link: unlinked');
        onChange();
      }
    },

    get linked() {
      return !!linked;
    },
    get version() {
      return linked?.version || '';
    },
    /** Whether the app in front is the browser the extension is in. */
    inFront: (pid) => !!linked && !!browser && pid === browser,
    /** What gestures do in Chrome, by the extension's settings; null while unlinked. */
    bindings() {
      if (!linked) return null;
      return Object.fromEntries(BINDING_KEYS.filter((key) => key in linked.settings).map((key) => [key, linked.settings[key]]));
    },

    /** Whether a command is the browser's: by its words, with Chrome in front, or by a bookmark or site the extension knows by that name. */
    async claims(text, { browserInFront = false } = {}) {
      if (!linked) return false;
      if (browserInFront || browserish(text)) return true;
      return (await request('knows', { text: String(text).slice(0, 300) }, false)) === true;
    },

    /**
     * The extension carries out a command; its pill frames and questions come
     * here meanwhile. One at a time: a new one replaces the last.
     * @param {string} text  the user's words
     * @param {{signal?:AbortSignal, meant?:string}} [options]  meant: what the conversation took them to mean
     * @returns {Promise<{ok:boolean, text:string}|null>} null: cancelled
     */
    task(text, { signal, meant = '' } = {}) {
      if (!linked) return Promise.resolve({ ok: false, text: 'Chrome isn’t linked.' });
      cancel();
      const id = String(++next);
      return new Promise((resolve) => {
        task = { id, resolve };
        signal?.addEventListener('abort', () => task?.id === id && cancel(), { once: true });
        if (!send({ type: 'task', id, text: String(text).slice(0, 2000), ...(meant ? { meant: String(meant).slice(0, 2000) } : {}) })) finishTask({ ok: false, text: 'Chrome isn’t linked.' });
      });
    },
    get running() {
      return !!task;
    },
    /** Stops the task the extension is doing for the app. */
    cancel,

    /** The link or button nearest a point on the page in front, in screen points, or null. */
    aim: ({ x, y, radius }) => request('aim', { x: Math.round(x), y: Math.round(y), radius: Math.round(radius) }),
    /** A gesture's action, done by the extension: {ok, detail}. */
    act: (action, { source = 'pose', gesture = '' } = {}) => request('act', { action, source, gesture }, { ok: false, detail: 'Chrome didn’t answer' })
  };
}
