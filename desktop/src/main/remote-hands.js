/**
 * His hands, when his brain is on a server (main.js's JESTER_SERVER): the Mac's.
 *
 * The conversation (conversation.js) does things through two objects: `commands` (does the matcher know these
 * words, are they risky, are they the user's scripts, and do them) and `assistant` (is a task running, is a question
 * waiting, ask one, answer it, stop). On a server both are the Mac's, over the web gateway's socket: the Mac runs
 * Jester too, with "Use Jester in the cloud" on (cloud-link.js), and does what's asked with its own voice runner and
 * assistant, exactly as it would for its own conversation.
 *
 * With no Mac connected there are no hands: nothing is known or risky, a command is answered with why it can't be
 * done, and a question (a script's "Run it?") is asked here and answered by what the user says or types next.
 *
 * Controls, on his website, is the Mac's scripts too: what its page asks goes to the Mac (op 'scripts', the page's
 * message as it is), which decides what it may do (script-remote.js), and the Mac says when they've changed.
 *
 * Frames, on the gateway's socket:
 *   server → Mac   { t: 'hands', id, op, ...args }            op: knows | risky | scriptsAsk | run | confirm | answer | reask | cancel | scripts | where
 *   Mac → server   { t: 'hands-reply', id, result } | { t: 'hands-reply', id, error }
 *   Mac → server   { t: 'hands-state', running, asking, abilities }   whenever any of it changes
 *   Mac → server   { t: 'hands-ask', label }                  its task has a question: asked in the conversation
 *   Mac → server   { t: 'presence', idleSeconds }             how long since the user touched the Mac
 *   Mac → server   { t: 'told', text }                        typed in the Mac's own window: said to him here
 *   Mac → server   { t: 'scripts-changed', change }           its scripts or what's on changed: Controls reads them again
 */

/** Quick questions about words: a Mac that doesn't answer in this long is taken as not knowing them. */
const QUICK_MS = 5000;
/** A task can take minutes; past this it's given up on here (the Mac may still finish it). */
const RUN_MS = 10 * 60 * 1000;
/** A question asked with no Mac, unanswered this long, is a no. */
const ASK_MS = 60 * 1000;

export const NO_MAC = 'Your Mac isn’t connected to me right now, so I can’t do that from here. Open Jester on it with “Use Jester in the cloud” on, and ask again.';
/** Controls, with no Mac: its scripts are there. */
export const NO_MAC_SCRIPTS = 'They run on your Mac, and it isn’t connected to me right now. Open Jester on it with “Use Jester in the cloud” on, and they’ll be here.';

/**
 * How long Controls waits on the Mac for each thing it asks: a folder picked, or a yes, waits on the user there; a
 * draft on the talking model; a run on the script (a light's first connection takes a few seconds).
 */
const SCRIPTS_MS = { choose: 10 * 60 * 1000, save: 10 * 60 * 1000, inspect: 3 * 60 * 1000, edit: 3 * 60 * 1000, run: 2 * 60 * 1000, 'scene-run': 2 * 60 * 1000, refresh: 2 * 60 * 1000 };
const SCRIPTS_QUICK_MS = 15000;

/**
 * @param {object} deps
 * @param {(client:object, frame:object) => void} [deps.send]   to one client (the gateway's client.send)
 * @param {(label:string) => void} [deps.onAsk]   the Mac's task has a question for the user: ask it in the conversation
 * @param {(text:string) => void} [deps.onTold]   typed to him in the Mac's own window
 * @param {(state:object) => void} [deps.onChange]   the Mac came, went, or its state changed
 * @param {(change:object) => void} [deps.onScriptsChanged]   the Mac's scripts changed, or the Mac came or went: Controls reads them again
 * @param {() => number} [deps.now]
 */
export function createRemoteHands({ onAsk = () => undefined, onTold = () => undefined, onChange = () => undefined, onScriptsChanged = () => undefined, log = () => undefined, now = Date.now } = {}) {
  /** The Mac connected, if one is: the gateway's client. */
  let mac = null;
  let state = { running: false, asking: false, abilities: {} };
  /** The Mac's idle seconds, and when they were said. */
  let idle = null;
  let nextId = 0;
  const waiting = new Map();
  /** A question asked here, with no Mac: what settles it. */
  let localAsk = null;

  function request(op, args = {}, timeoutMs = QUICK_MS) {
    if (!mac) return Promise.reject(Object.assign(new Error(NO_MAC), { code: 'no_mac' }));
    const id = ++nextId;
    const client = mac;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(Object.assign(new Error('The Mac didn’t answer in time'), { code: 'timeout' }));
      }, timeoutMs);
      waiting.set(id, { resolve, reject, timer, client });
      client.send({ t: 'hands', id, op, ...args });
    });
  }

  /** Ask the Mac, and take `fallback` if it can't say. */
  const quick = (op, args, fallback) => request(op, args).catch((err) => (err.code !== 'no_mac' && log(`hands: ${op} not answered:`, err.message), fallback));

  function settleAll(client, why) {
    for (const [id, entry] of waiting) {
      if (client && entry.client !== client) continue;
      clearTimeout(entry.timer);
      entry.reject(Object.assign(new Error(why), { code: 'no_mac' }));
      waiting.delete(id);
    }
  }

  function askHere(label) {
    localAsk?.settle(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle(false), ASK_MS);
      const settle = (yes) => {
        clearTimeout(timer);
        if (localAsk?.settle === settle) localAsk = null;
        resolve(!!yes);
      };
      localAsk = { label, settle };
      onAsk(label);
    });
  }

  return {
    /** The gateway's client said it's a Mac. A newer one takes over from an older. */
    join(client) {
      if (mac && mac !== client) settleAll(mac, 'Another Mac connected');
      mac = client;
      state = { running: false, asking: false, abilities: {} };
      log('hands: the Mac is connected');
      onChange(state);
      onScriptsChanged({ mac: true });
    },
    /** A client went: if it was the Mac, there are no hands until it's back. */
    leave(client) {
      if (client !== mac) return;
      mac = null;
      idle = null;
      state = { running: false, asking: false, abilities: {} };
      settleAll(client, NO_MAC);
      log('hands: the Mac is gone');
      onChange(state);
      onScriptsChanged({ mac: false });
    },
    /** A frame from a client the gateway didn't take itself. */
    frame(client, frame) {
      if (client !== mac) return;
      if (frame.t === 'hands-reply') {
        const entry = waiting.get(frame.id);
        if (!entry) return;
        waiting.delete(frame.id);
        clearTimeout(entry.timer);
        if (frame.error) entry.reject(new Error(String(frame.error)));
        else entry.resolve(frame.result);
      } else if (frame.t === 'hands-state') {
        state = { running: !!frame.running, asking: !!frame.asking, abilities: frame.abilities && typeof frame.abilities === 'object' ? frame.abilities : {} };
        onChange(state);
      } else if (frame.t === 'hands-ask') {
        onAsk(String(frame.label || '').slice(0, 300));
      } else if (frame.t === 'told' && typeof frame.text === 'string' && frame.text.trim()) {
        onTold(frame.text.trim().slice(0, 12000));
      } else if (frame.t === 'presence' && Number.isFinite(frame.idleSeconds)) {
        idle = { seconds: Math.max(0, frame.idleSeconds), at: now() };
      } else if (frame.t === 'scripts-changed') {
        const change = frame.change && typeof frame.change === 'object' && !Array.isArray(frame.change) ? frame.change : {};
        onScriptsChanged({ script: typeof change.script === 'string' ? change.script.slice(0, 64) : undefined });
      }
    },
    get connected() {
      return !!mac;
    },
    /** What the Mac says it can do (abilities.js's state), or null with none connected. */
    get abilities() {
      return mac ? state.abilities : null;
    },
    /** Seconds since the user touched the Mac, as of now; Infinity with no Mac or nothing said yet. */
    idleSeconds() {
      return idle ? idle.seconds + (now() - idle.at) / 1000 : Infinity;
    },

    /** conversation.js's `commands`. */
    commands: {
      knows: (text) => quick('knows', { text }, false),
      risky: (text) => quick('risky', { text }, false),
      scriptsAsk: (text) => quick('scriptsAsk', { text }, false),
      async run(text, said, context) {
        try {
          const result = await request('run', { text, said, context: context || {} }, RUN_MS);
          return { outcome: result?.outcome ?? null };
        } catch (err) {
          return { outcome: { ok: false, text: err.code === 'no_mac' ? NO_MAC : `I couldn’t get your Mac to do that: ${err.message}.` } };
        }
      }
    },

    /**
     * Where the Mac is, from Location Services (mac-location.js): the user's using it, or his website in its window
     * (device-location.js). As whereabouts.js takes a position: { ok, lat, lon, accuracy } or { ok: false, code }.
     */
    async where(timeoutMs = 25000) {
      try {
        const got = await request('where', { timeoutMs }, timeoutMs + QUICK_MS);
        return got && typeof got === 'object' ? got : { ok: false, code: 2 };
      } catch (err) {
        return { ok: false, code: err.code === 'timeout' ? 3 : 2, message: err.code === 'no_mac' ? '' : err.message };
      }
    },

    /**
     * Controls, asked on his website: the Mac's answer, as main.js's scriptsAsked would give it there, or why not.
     * @param {object} message  the page's { op, … }, as it sent it
     */
    async scripts(message) {
      const op = String(message?.op ?? '');
      let asked;
      try {
        asked = JSON.parse(JSON.stringify(message ?? {}));
      } catch {
        return { ok: false, why: 'That couldn’t be sent to your Mac.' };
      }
      try {
        const result = await request('scripts', { message: asked }, SCRIPTS_MS[op] || SCRIPTS_QUICK_MS);
        return result && typeof result === 'object' ? result : { ok: false, why: 'Your Mac didn’t say.' };
      } catch (err) {
        return { ok: false, why: err.code === 'no_mac' ? NO_MAC_SCRIPTS : `Your Mac didn’t answer: ${err.message}.` };
      }
    },

    /** conversation.js's `assistant`: the Mac's, or a question asked here when there's no Mac. */
    assistant: {
      get running() {
        return !!mac && state.running;
      },
      get asking() {
        return !!localAsk || (!!mac && state.asking);
      },
      confirm(label) {
        if (!mac) return askHere(String(label));
        return request('confirm', { label: String(label) }, ASK_MS + QUICK_MS).then((yes) => !!yes, () => false);
      },
      answer(yes) {
        if (localAsk) return localAsk.settle(!!yes);
        if (mac) request('answer', { yes: !!yes }).catch(() => undefined);
      },
      reask() {
        if (localAsk) {
          onAsk(localAsk.label);
          return true;
        }
        if (!mac) return false;
        request('reask').catch(() => undefined);
        return state.asking;
      },
      cancel() {
        localAsk?.settle(false);
        if (mac) return request('cancel').catch(() => undefined);
        return Promise.resolve();
      }
    }
  };
}
