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
 *     ask {id, label, open?, options?}, done {id, ok, say, trace?, chose?}, reply {id, result}, voice {},
 *     scrape {id, request}, scrape-cancel {id}
 *   to it: welcome {version, scraping}, task {id, text, meant?, ways?}, answer {id, approved, text?}, cancel {},
 *     scrape-result {id, result},
 *     request {id, op, ...}, op being knows {text}, aim {x, y, radius} or act {action, source, gesture}
 */

/** How long each question to the extension may take before it's taken as a no. */
export const REQUEST_MS = Object.freeze({ knows: 600, aim: 250, act: 3000, web: 35_000 });
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
 * @param {(request:object, options:{signal:AbortSignal}) => Promise<object>} [deps.onScrape] background web reader
 * @param {(...parts:any[]) => void} [deps.log]
 */
export function createChromeLink({ send, version, onChange = () => undefined, onPill = () => undefined, onAsk = async () => false, onVoice = () => undefined, onScrape, log = () => undefined }) {
  let linked = null;
  let browser = null;
  let next = 0;
  const pending = new Map();
  const scraping = new Map();
  let task = null;

  function settle(id, result) {
    const waiting = pending.get(id);
    if (!waiting) return;
    pending.delete(id);
    clearTimeout(waiting.timer);
    waiting.cleanup?.();
    waiting.resolve(result);
  }

  /** A question for the extension: its answer, or `fallback` if it's gone or slow. */
  function request(op, args, fallback = null, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
    if (!linked) return Promise.resolve(fallback);
    const id = String(++next);
    return new Promise((resolve, reject) => {
      const cancel = () => {
        const waiting = pending.get(id);
        if (!waiting) return;
        pending.delete(id);
        clearTimeout(waiting.timer);
        waiting.cleanup?.();
        if (op === 'web') send({ type: 'web-cancel', id });
        reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
      };
      pending.set(id, { resolve, cleanup: () => signal?.removeEventListener('abort', cancel), timer: setTimeout(() => {
        if (op === 'web') send({ type: 'web-cancel', id });
        settle(id, fallback);
      }, REQUEST_MS[op] ?? 1000) });
      signal?.addEventListener('abort', cancel, { once: true });
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
          send({ type: 'welcome', version, scraping: typeof onScrape === 'function' });
          log('chrome link: linked to Jester', linked.version);
          return onChange();
        case 'settings':
          if (!linked) return undefined;
          linked.settings = message.settings || {};
          return onChange();
        case 'pill':
          return onPill(message.voice || {});
        case 'ask': {
          // A question the extension's task can't settle (which profile, which account): the user's own answer goes
          // back as `text`. One that asks leave comes back approved or not, as it always has.
          const options = Array.isArray(message.options) ? message.options.slice(0, 4).map((option) => String(option).slice(0, 80)) : [];
          const open = message.open === true || options.length > 0;
          return void Promise.resolve(onAsk(String(message.label || ''), open ? { open: true, options } : {})).then(
            (answer) => send({ type: 'answer', id: message.id, approved: open ? typeof answer === 'string' && !!answer : answer === true, ...(open && typeof answer === 'string' && answer ? { text: answer.slice(0, 400) } : {}) }),
            () => send({ type: 'answer', id: message.id, approved: false })
          );
        }
        case 'done':
          if (task?.id === message.id) {
            // What the extension did, step by step (0.2.3 on): the log's only account of a browser task.
            for (const line of Array.isArray(message.trace) ? message.trace.slice(-40) : []) log('chrome', String(line).slice(0, 220));
            // chose: what the user answered when the task asked them something (which profile), for ways.js to keep.
            const chose = (Array.isArray(message.chose) ? message.chose : []).filter((one) => one && typeof one.about === 'string' && typeof one.choice === 'string').slice(0, 5)
              .map(({ about, choice }) => ({ about: about.slice(0, 60), choice: choice.slice(0, 120) }));
            finishTask({ ok: message.ok === true, text: String(message.say || ''), ...(typeof message.answer === 'string' ? { answer: message.answer.slice(0, 6000) } : {}), ...(Array.isArray(message.sources) ? { sources: message.sources.slice(0, 24) } : {}), ...(chose.length ? { chose } : {}) });
          }
          return undefined;
        case 'reply':
          return settle(String(message.id), message.result ?? null);
        case 'voice':
          return onVoice();
        case 'scrape': {
          if (!linked || typeof message.id !== 'string' || message.id.length > 80 || scraping.has(message.id)) return undefined;
          const id = message.id;
          if (typeof onScrape !== 'function') return void send({ type: 'scrape-result', id, result: { ok: false, code: 'scrape_unavailable', detail: 'Background scraping is unavailable in this version of Jester Desktop.' } });
          if (scraping.size >= 8) return void send({ type: 'scrape-result', id, result: { ok: false, code: 'scrape_busy', detail: 'Too many background web requests are already running.' } });
          const controller = new AbortController();
          scraping.set(id, controller);
          const reply = (result) => {
            if (scraping.get(id) !== controller) return;
            scraping.delete(id);
            if (linked && !controller.signal.aborted) send({ type: 'scrape-result', id, result });
          };
          return void Promise.resolve().then(() => onScrape(message.request, { signal: controller.signal })).then(reply,
            () => reply({ ok: false, code: 'scrape_failed', detail: 'The background web request failed.' }));
        }
        case 'scrape-cancel': {
          const controller = scraping.get(message.id);
          scraping.delete(message.id);
          controller?.abort();
          return undefined;
        }
        default:
          return undefined;
      }
    },

    disconnected() {
      const was = !!linked;
      linked = null;
      browser = null;
      for (const controller of scraping.values()) controller.abort();
      scraping.clear();
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
    task(text, { signal, meant = '', skipResearch = false, ways = [] } = {}) {
      if (!linked) return Promise.resolve({ ok: false, text: 'Chrome isn’t linked.' });
      cancel();
      const id = String(++next);
      return new Promise((resolve) => {
        task = { id, resolve };
        signal?.addEventListener('abort', () => task?.id === id && cancel(), { once: true });
        // ways: how the user likes things done ("Hulu profile: Krish"), which the extension's agent goes by.
        const how = (Array.isArray(ways) ? ways : []).filter((line) => typeof line === 'string' && line.trim()).slice(0, 12).map((line) => line.slice(0, 120));
        if (!send({ type: 'task', id, text: String(text).slice(0, 2000), ...(meant ? { meant: String(meant).slice(0, 2000) } : {}), ...(skipResearch ? { skipResearch: true } : {}), ...(how.length ? { ways: how } : {}) })) finishTask({ ok: false, text: 'Chrome isn’t linked.' });
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
    act: (action, { source = 'pose', gesture = '' } = {}) => request('act', { action, source, gesture }, { ok: false, detail: 'Chrome didn’t answer' }),
    /** Read an open signed-in page through Chrome, without focusing or navigating it. */
    web: (webRequest, options = {}) => request('web', { request: webRequest }, { ok: false, code: 'browser_unavailable', detail: 'Chrome did not answer the background web request.' }, options)
  };
}
