/**
 * His hands, when his brain is on a server (main.js's JESTER_SERVER): the user's computers'.
 *
 * A conversation (conversation.js) does things through two objects: `commands` (does the matcher know these
 * words, are they risky, are they the user's scripts, and do them) and `assistant` (is a task running, is a question
 * waiting, ask one, answer it, stop). On a server both are a computer's, over the web gateway's socket: each Mac runs
 * Jester too, with "Use Jester in the cloud" on (cloud-link.js), and does what's asked with its own voice runner and
 * assistant, exactly as it would for its own conversation.
 *
 * More than one computer can be connected (the user, 2026-11-18: "my laptop should be able to see if there are other
 * laptops with him signed in and coordinate with them"). Each chat has its own `commands` and `assistant` (`for`),
 * and what it asks goes to one computer (`pick`): the one named in the words ("on my desktop"), else the one the chat
 * is on, else the one touched last. A task's question comes back to the chat that started it.
 *
 * With no computer connected there are no hands: nothing is known or risky, a command is answered with why it can't
 * be done, and a question (a script's "Run it?") is asked here and answered by what the user says or types next.
 *
 * Controls, on his website, is a computer's scripts too: what its page asks goes to that computer (op 'scripts', the
 * page's message as it is), which decides what it may do (script-remote.js), and says when they've changed.
 *
 * Frames, on the gateway's socket:
 *   server → Mac   { t: 'hands', id, op, ...args }            op: knows | risky | scriptsAsk | run | confirm | answer | reask | cancel | scripts | where | set
 *   Mac → server   { t: 'hands-reply', id, result } | { t: 'hands-reply', id, error }
 *   Mac → server   { t: 'hands-state', running, asking, abilities, engine, switches, doing }   whenever any of it changes
 *   Mac → server   { t: 'hands-ask', label, open?, options?, again? }   its task has a question: asked in the conversation.
 *                                                             open: answered in the user's own words (one of options, if any)
 *   Mac → server   { t: 'presence', idleSeconds }             how long since the user touched it
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

const EMPTY = Object.freeze({ running: false, asking: false, abilities: {}, engine: '', switches: {}, doing: '' });

/** A computer's name as it's listened for in what's asked: "Krish’s MacBook Pro" → "krishs macbook pro". */
const plain = (text) => String(text ?? '').toLowerCase().replace(/[‘’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Whether words name a computer: all of its name ("on Krish's MacBook Pro"), or what kind it is where only one is
 * that ("on my MacBook", "on the iMac", "on my desktop" for the one that isn't a laptop).
 */
export function namedIn(text, computers) {
  const said = ` ${plain(text)} `;
  if (!/ (?:on|at|from|to|using) /.test(said)) return null;
  const whole = computers.filter((computer) => plain(computer.name) && said.includes(` ${plain(computer.name)} `));
  if (whole.length === 1) return whole[0];
  for (const word of ['macbook pro', 'macbook air', 'macbook', 'imac', 'mac mini', 'mac studio', 'laptop', 'desktop', 'pc']) {
    if (!new RegExp(` (?:on|at|from|to|using) (?:my |the )?${word} `).test(said)) continue;
    const laptop = (computer) => /macbook|laptop|book/.test(plain(computer.name));
    const fits = computers.filter((computer) => (word === 'laptop' ? laptop(computer) : word === 'desktop' || word === 'pc' ? !laptop(computer) : plain(computer.name).includes(word)));
    if (fits.length === 1) return fits[0];
  }
  return null;
}

/**
 * @param {object} deps
 * @param {(label:string, chat:string) => void} [deps.onAsk]   a computer's task has a question for the user: ask it in the chat that started it
 * @param {(text:string, computer:object) => void} [deps.onTold]   typed to him in a computer's own window
 * @param {(state:object) => void} [deps.onChange]   a computer came, went, or its state changed
 * @param {(change:object) => void} [deps.onScriptsChanged]   a computer's scripts changed, or one came or went: Controls reads them again
 * @param {() => string} [deps.adopt]   the chat that takes a computer's task no chat here started (begun on the computer itself): the one in front
 * @param {() => number} [deps.now]
 */
export function createRemoteHands({ onAsk = () => undefined, onTold = () => undefined, onChange = () => undefined, onScriptsChanged = () => undefined, adopt = () => 'local', log = () => undefined, now = Date.now } = {}) {
  /** The computers connected, by the gateway's client: { client, id, name, state, idle, joinedAt, owner }. */
  const macs = new Map();
  let nextId = 0;
  const waiting = new Map();
  let joins = 0;

  const idleOf = (mac) => (mac.idle ? mac.idle.seconds + (now() - mac.idle.at) / 1000 : Infinity);
  /** The one being used: touched last, and of those that haven't said, the one that came last. */
  const nearest = () => [...macs.values()].sort((a, b) => idleOf(a) - idleOf(b) || b.joinedAt - a.joinedAt)[0] || null;
  const byId = (id) => (id ? [...macs.values()].find((mac) => mac.id === id) || null : null);

  /**
   * Which computer something's asked of: the one named in the words, else the one the chat is on, else the one
   * being used.
   */
  function pick({ text = '', device = '' } = {}) {
    if (!macs.size) return null;
    if (macs.size === 1) return macs.values().next().value;
    return namedIn(text, [...macs.values()]) || byId(device) || nearest();
  }

  function request(mac, op, args = {}, timeoutMs = QUICK_MS) {
    if (!mac || !macs.has(mac.client)) return Promise.reject(Object.assign(new Error(NO_MAC), { code: 'no_mac' }));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(Object.assign(new Error('The Mac didn’t answer in time'), { code: 'timeout' }));
      }, timeoutMs);
      waiting.set(id, { resolve, reject, timer, client: mac.client });
      mac.client.send({ t: 'hands', id, op, ...args });
    });
  }

  /** Ask a computer, and take `fallback` if it can't say. */
  const quick = (mac, op, args, fallback) => request(mac, op, args).catch((err) => (err.code !== 'no_mac' && log(`hands: ${op} not answered:`, err.message), fallback));

  function settleAll(client, why) {
    for (const [id, entry] of waiting) {
      if (client && entry.client !== client) continue;
      clearTimeout(entry.timer);
      entry.reject(Object.assign(new Error(why), { code: 'no_mac' }));
      waiting.delete(id);
    }
  }

  /** A computer as it's listed: for Settings' Devices, and for him to know of. */
  const listed = (mac) => ({ id: mac.id, name: mac.name, running: !!mac.state.running, asking: !!mac.state.asking, doing: mac.state.doing || '', engine: mac.state.engine || '', switches: { ...mac.state.switches }, abilities: mac.state.abilities, idleSeconds: idleOf(mac), chat: mac.owner || '' });

  /**
   * A chat's own `commands` and `assistant` (conversation.js).
   * @param {string} chat  which chat they're for: a computer's question comes back to it
   * @param {() => string} [device]  the device that chat is on, when it's a computer: what's asked goes there first
   */
  function hands(chat = 'local', device = () => '') {
    /** The computer this chat last asked something of: its task, and its question, are this chat's. */
    let mine = null;
    /** A question asked here, with no computer: what settles it. */
    let localAsk = null;
    const target = (text) => pick({ text, device: device() });
    const own = (mac) => {
      mine = mac;
      if (mac) mac.owner = chat;
      return mac;
    };
    /** The computer whose task is this chat's: the one it last asked, or one with a task no chat started, if this chat's in front. */
    const current = () => {
      if (mine && macs.has(mine.client) && mine.owner === chat) return mine;
      return [...macs.values()].find((mac) => mac.owner === chat || (!mac.owner && adopt() === chat)) || null;
    };

    /** `more`: a question answered in the user's own words, with its options: resolves to their answer, or null. */
    function askHere(label, more = null) {
      localAsk?.settle(localAsk.open ? null : false);
      const open = !!more;
      const options = Array.isArray(more?.options) ? more.options.slice(0, 4).map(String) : [];
      return new Promise((resolve) => {
        const timer = setTimeout(() => settle(open ? null : false), ASK_MS);
        const settle = (answer) => {
          clearTimeout(timer);
          if (localAsk?.settle === settle) localAsk = null;
          resolve(open ? (typeof answer === 'string' && answer.trim() ? answer.trim() : null) : answer === true);
        };
        localAsk = { label, settle, open, options };
        onAsk(label, chat, open ? { open: true, options } : {});
      });
    }

    return {
      /** conversation.js's `commands`. */
      commands: {
        knows: (text) => quick(target(text), 'knows', { text }, false),
        risky: (text) => quick(target(text), 'risky', { text }, false),
        scriptsAsk: (text) => quick(target(text), 'scriptsAsk', { text }, false),
        /** `more`: where the conversation chose to have it done, and how the user likes things done (voice-runner.js run). */
        async run(text, said, context, more = {}) {
          try {
            const result = await request(own(target(`${text} ${said || ''}`)), 'run', { text, said, context: context || {}, ...(more?.where ? { where: more.where } : {}), ...(Array.isArray(more?.ways) && more.ways.length ? { ways: more.ways } : {}) }, RUN_MS);
            return { outcome: result?.outcome ?? null };
          } catch (err) {
            return { outcome: { ok: false, text: err.code === 'no_mac' ? NO_MAC : `I couldn’t get your Mac to do that: ${err.message}.` } };
          }
        }
      },

      /** conversation.js's `assistant`: the computer's this chat is using, or a question asked here when there's none. */
      assistant: {
        get running() {
          return !!current()?.state.running;
        },
        get asking() {
          return !!localAsk || !!current()?.state.asking;
        },
        /** The question waiting, as far as it's known here: `open`, it wants their own words, not a yes or a no. */
        get asked() {
          if (localAsk) return { label: localAsk.label, options: [...localAsk.options], open: localAsk.open };
          const mac = current();
          return mac?.state.asking ? { label: mac.asked?.label || '', options: [...(mac.asked?.options || [])], open: !!mac.asked?.open } : null;
        },
        confirm(label) {
          const mac = own(target(''));
          if (!mac) return askHere(String(label));
          return request(mac, 'confirm', { label: String(label) }, ASK_MS + QUICK_MS).then((yes) => !!yes, () => false);
        },
        /** A question only the user can settle (assistant.js inquire): asked on the computer in use, or here with none. */
        inquire({ question, options = [] } = {}) {
          const mac = own(target(''));
          if (!mac) return askHere(String(question ?? ''), { options });
          return request(mac, 'inquire', { question: String(question ?? ''), options }, ASK_MS + QUICK_MS).then((answer) => (typeof answer === 'string' && answer.trim() ? answer.trim() : null), () => null);
        },
        answer(value) {
          if (localAsk) return localAsk.settle(localAsk.open ? (typeof value === 'string' ? value : null) : value === true);
          const told = typeof value === 'string' ? { yes: true, text: value } : value === null ? { yes: false, left: true } : { yes: !!value };
          if (current()) request(current(), 'answer', told).catch(() => undefined);
          return undefined;
        },
        reask() {
          if (localAsk) {
            onAsk(localAsk.label, chat, { ...(localAsk.open ? { open: true, options: localAsk.options } : {}), again: true });
            return true;
          }
          const mac = current();
          if (!mac) return false;
          request(mac, 'reask').catch(() => undefined);
          return !!mac.state.asking;
        },
        cancel() {
          localAsk?.settle(localAsk.open ? null : false);
          if (current()) return request(current(), 'cancel').catch(() => undefined);
          return Promise.resolve();
        }
      }
    };
  }

  const local = hands('local');

  return {
    /** The gateway's client said it's a computer of the user's. The same one again takes over from its older line. */
    join(client) {
      const id = String(client.device?.id || `mac-${client.id ?? ++joins}`);
      for (const [other, mac] of macs) {
        if (mac.id !== id || other === client) continue;
        settleAll(other, 'It connected again');
        macs.delete(other);
      }
      macs.set(client, { client, id, name: String(client.device?.name || 'your Mac'), state: { ...EMPTY }, idle: null, joinedAt: ++joins, owner: '' });
      log('hands: connected,', macs.size === 1 ? 'the Mac' : `${macs.size} computers`);
      onChange();
      onScriptsChanged({ mac: true });
    },
    /** A client went: if it was a computer, its hands go with it. */
    leave(client) {
      if (!macs.delete(client)) return;
      settleAll(client, NO_MAC);
      log('hands: a computer is gone;', macs.size, 'left');
      onChange();
      onScriptsChanged({ mac: macs.size > 0 });
    },
    /** A frame from a client the gateway didn't take itself. */
    frame(client, frame) {
      const mac = macs.get(client);
      if (!mac) return;
      if (frame.t === 'hands-reply') {
        const entry = waiting.get(frame.id);
        if (!entry || entry.client !== client) return;
        waiting.delete(frame.id);
        clearTimeout(entry.timer);
        if (frame.error) entry.reject(new Error(String(frame.error)));
        else entry.resolve(frame.result);
      } else if (frame.t === 'hands-state') {
        const switches = frame.switches && typeof frame.switches === 'object' ? Object.fromEntries(Object.entries(frame.switches).filter(([, on]) => typeof on === 'boolean').slice(0, 8)) : {};
        mac.state = { running: !!frame.running, asking: !!frame.asking, abilities: frame.abilities && typeof frame.abilities === 'object' ? frame.abilities : {}, engine: String(frame.engine || '').slice(0, 24), switches, doing: String(frame.doing || '').slice(0, 200) };
        onChange();
      } else if (frame.t === 'hands-ask') {
        if (!mac.owner) mac.owner = adopt();
        const label = String(frame.label || '').slice(0, 300);
        const options = Array.isArray(frame.options) ? frame.options.slice(0, 4).map((option) => String(option).slice(0, 80)) : [];
        const open = frame.open === true || options.length > 0;
        // What kind of answer it wants, for the conversation that hears one before the Mac's state says.
        mac.asked = { label, open, options };
        onAsk(label, mac.owner, { ...(open ? { open: true, options } : {}), ...(frame.again === true ? { again: true } : {}) });
      } else if (frame.t === 'told' && typeof frame.text === 'string' && frame.text.trim()) {
        mac.idle = { seconds: 0, at: now() };
        onTold(frame.text.trim().slice(0, 12000), listed(mac));
      } else if (frame.t === 'presence' && Number.isFinite(frame.idleSeconds)) {
        mac.idle = { seconds: Math.max(0, frame.idleSeconds), at: now() };
      } else if (frame.t === 'scripts-changed') {
        const change = frame.change && typeof frame.change === 'object' && !Array.isArray(frame.change) ? frame.change : {};
        onScriptsChanged({ script: typeof change.script === 'string' ? change.script.slice(0, 64) : undefined });
      }
    },
    get connected() {
      return macs.size > 0;
    },
    /** The computers connected, the one being used first. */
    list: () => [...macs.values()].sort((a, b) => idleOf(a) - idleOf(b) || b.joinedAt - a.joinedAt).map(listed),
    /** What the computer being used says it can do (abilities.js's state), or null with none connected. */
    get abilities() {
      return nearest()?.state.abilities || null;
    },
    /** Seconds since the user touched any of them, as of now; Infinity with none or nothing said yet. */
    idleSeconds() {
      return Math.min(Infinity, ...[...macs.values()].map(idleOf));
    },

    /**
     * Training mode (voice-training.js), when the voice is heard here and the face is on a computer's camera: what
     * the computers with it on saw while a line was said, told by its time here as how long ago it began and how long
     * it lasted, which their clocks agree on whatever the time on them is. The one that saw the user talking, if any
     * did; else whatever one said; null with none on.
     * @param {{from:number, to:number}} line  on this server's clock
     */
    async face({ from, to }) {
      const watching = [...macs.values()].filter((mac) => mac.state.switches?.training === true);
      if (!watching.length || !(to > from)) return null;
      const said = await Promise.all(watching.map((mac) => quick(mac, 'face', { ago: now() - from, lasted: to - from }, null)));
      const told = said.filter((one) => one && typeof one === 'object' && typeof one.verdict === 'string');
      return told.find((one) => one.verdict === 'speaking') || told[0] || null;
    },
    /** How much training has learned from, for the Settings of the computers with it on. */
    trained(report = {}) {
      for (const mac of macs.values()) {
        if (mac.state.switches?.training !== true) continue;
        void quick(mac, 'trained', { kept: Number(report.kept) || 0, clips: Number(report.clips) || 0 }, null);
      }
    },

    /** A chat's own commands and assistant. */
    for: hands,
    /** The first chat's (and the only one's, where there's one). */
    commands: local.commands,
    assistant: local.assistant,

    /**
     * A switch of a computer's Jester, thrown from his website (the phone as a remote): asleep, gestures, the cursor,
     * Jester himself; or its task stopped.
     * @param {string} device  which computer, or '' for the one being used
     */
    async set(device, change) {
      try {
        return (await request(byId(device) || nearest(), 'set', { change }, QUICK_MS)) ?? { ok: false };
      } catch (err) {
        return { ok: false, why: err.code === 'no_mac' ? NO_MAC : `Your Mac didn’t answer: ${err.message}.` };
      }
    },

    /**
     * Where a computer is, from Location Services (mac-location.js): the user's using it, or his website in its window
     * (device-location.js). As whereabouts.js takes a position: { ok, lat, lon, accuracy } or { ok: false, code }.
     */
    async where(timeoutMs = 25000, device = '') {
      try {
        const got = await request(byId(device) || nearest(), 'where', { timeoutMs }, timeoutMs + QUICK_MS);
        return got && typeof got === 'object' ? got : { ok: false, code: 2 };
      } catch (err) {
        return { ok: false, code: err.code === 'timeout' ? 3 : 2, message: err.code === 'no_mac' ? '' : err.message };
      }
    },

    /**
     * Controls, asked on his website: the computer's answer, as main.js's scriptsAsked would give it there, or why not.
     * @param {object} message  the page's { op, … }, as it sent it
     * @param {string} [device]  the computer the page is on, when it's one of them
     */
    async scripts(message, device = '') {
      const op = String(message?.op ?? '');
      let asked;
      try {
        asked = JSON.parse(JSON.stringify(message ?? {}));
      } catch {
        return { ok: false, why: 'That couldn’t be sent to your Mac.' };
      }
      try {
        const result = await request(byId(device) || nearest(), 'scripts', { message: asked }, SCRIPTS_MS[op] || SCRIPTS_QUICK_MS);
        return result && typeof result === 'object' ? result : { ok: false, why: 'Your Mac didn’t say.' };
      } catch (err) {
        return { ok: false, why: err.code === 'no_mac' ? NO_MAC_SCRIPTS : `Your Mac didn’t answer: ${err.message}.` };
      }
    }
  };
}
