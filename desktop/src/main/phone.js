/**
 * The user's phone, for what he has to tell them when they aren't at the
 * computer: a notification through ntfy (ntfy.sh, or a server of their own).
 *
 * ntfy has no accounts here. A message is published to a topic, and whoever
 * has subscribed to that topic's name in the ntfy app gets it; so the name is
 * the key. Jester makes one nobody could guess (sixteen letters at random, in
 * fours so it can be typed into a phone), keeps it sealed on disk with the
 * other keys, and shows it only in Settings, for the user to subscribe to.
 * What's sent goes through that server in the clear to anyone who knew the
 * name: reminders, timers, a word before class, the evening's wrap-up. A line
 * that looks like a password or a card number is never sent: only that
 * there's something to see.
 *
 * Nothing is sent until the user has turned it on, which they can't sensibly
 * do before subscribing. Off, or with the send failing, tell.js does what it
 * did before there was a phone: keeps the line until they're back.
 */

import { secretIn } from './vault-memory.js';

export const DEFAULT_SERVER = 'https://ntfy.sh';
const SEND_MS = 10_000;
/** ntfy turns a longer message into a file. */
const MOST_BYTES = 3500;
/** Letters that aren't taken for one another, read off a screen and typed with a thumb. */
const LETTERS = 'abcdefghjkmnpqrstuvwxyz';

/**
 * A topic nobody could guess: "jester-kfmw-rtqz-hbnc-vxpd" (16 letters of 23: 72 bits).
 * @param {(n:number) => Uint8Array} [random]  n random bytes
 */
export function newTopic(random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))) {
  const picked = [];
  // Bytes that would favour the first letters are thrown away, not folded in.
  while (picked.length < 16) for (const byte of random(32)) if (byte < 256 - (256 % LETTERS.length) && picked.length < 16) picked.push(LETTERS[byte % LETTERS.length]);
  return `jester-${picked.join('').replace(/(.{4})(?=.)/g, '$1-')}`;
}

/** A server's address as it's used: https, with no path. Throws, in words for Settings, when it can't be one. */
export function serverUrl(input) {
  const text = String(input ?? '').trim();
  if (!text) return DEFAULT_SERVER;
  let url;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new Error('That isn’t a server’s address. It looks like https://ntfy.sh.');
  }
  if (url.protocol !== 'https:') throw new Error('The server’s address has to start with https://: what’s sent shouldn’t cross a network in the clear.');
  return url.origin;
}

/** Sent in place of a line that looks like a secret: that there's one, and where. */
export const WITHHELD = 'There’s something for you on your computer.';

/** What's sent of a line: all of it, cut to what ntfy takes whole; or, when it looks like a secret, only that there's something. */
export function phoneText(text) {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (secretIn(line)) return WITHHELD;
  const bytes = new TextEncoder().encode(line);
  return bytes.length <= MOST_BYTES ? line : `${new TextDecoder().decode(bytes.slice(0, MOST_BYTES)).replace(/�+$/, '')}…`;
}

/**
 * @param {object} deps
 * @param {{get:Function, set:Function}} deps.storage  storage.local: the `phone` key, sealed (chrome-bridge.js)
 * @param {typeof fetch} [deps.fetchImpl]
 */
export function createPhone({ storage, fetchImpl = globalThis.fetch, now = Date.now, log = () => undefined, onChange = () => undefined }) {
  /** @type {{on:boolean, topic:string, server:string}} */
  let kept = { on: false, topic: '', server: DEFAULT_SERVER };
  /** How the last send went, for Settings: {at, ok, problem}. Not kept. */
  let last = null;

  async function save(next) {
    kept = { ...kept, ...next };
    await storage.set({ phone: kept });
    onChange();
  }

  /** Publishes one message. Throws with why, in words. */
  async function publish({ title, text, priority = 3, tags = [] }) {
    const response = await fetchImpl(kept.server, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: kept.topic, title: String(title || 'Jester').slice(0, 80), message: phoneText(text), priority: Math.min(5, Math.max(1, Math.round(Number(priority) || 3))), ...(tags.length ? { tags } : {}) }),
      // Sent to the server asked for and nowhere it points on to: a redirect would carry the topic with it.
      redirect: 'error',
      signal: AbortSignal.timeout(SEND_MS)
    });
    if (response?.ok) return;
    const status = Number(response?.status) || 0;
    throw Object.assign(new Error(status === 429 ? 'the server says that’s too many for now' : `the server answered ${status || 'nothing it should'}`), { refused: true });
  }

  return {
    async start() {
      const stored = (await storage.get('phone')).phone;
      if (!stored || typeof stored !== 'object') return;
      // As it was kept, if it's what he'd have kept: a topic ntfy takes, on only with one, and a server over https.
      const topic = /^[-_A-Za-z0-9]{1,64}$/.test(stored.topic || '') ? stored.topic : '';
      let server = DEFAULT_SERVER;
      try {
        server = serverUrl(stored.server);
      } catch {
        /* not an address he'd send to: ntfy.sh's */
      }
      kept = { on: stored.on === true && !!topic, topic, server };
    },
    /** For Settings: whether it's on, the topic to subscribe to, the server, and how the last send went. */
    state: () => ({ on: kept.on, topic: kept.topic, server: kept.server, usual: kept.server === DEFAULT_SERVER, last: last && { ...last } }),
    /** Whether a line can be sent there at all. */
    get ready() {
      return kept.on && !!kept.topic;
    },
    /** A topic made, if there's none: nothing's sent to it until it's turned on. */
    async setUp() {
      if (!kept.topic) await save({ topic: newTopic() });
      return this.state();
    },
    /** A new topic, the old one left behind: for one that got out. The phone has to subscribe again. */
    async renew() {
      await save({ topic: newTopic(), on: false });
      last = null;
      return this.state();
    },
    async setOn(on) {
      await save({ on: on === true && !!kept.topic });
    },
    /** Another server than ntfy.sh, or '' for that one. Throws when it can't be one. */
    async setServer(input) {
      await save({ server: serverUrl(input) });
    },
    /**
     * A line to their phone.
     * @param {{title?:string, text:string, priority?:number, tags?:string[]}} message
     * @param {{anyway?:boolean}} [options]  anyway: though it isn't turned on (Settings' test)
     * @returns {Promise<{went:boolean, again:boolean, withheld:boolean}>}  went: it's on their phone, whole; again:
     *   it isn't, and can't have got there (the server refused it or wasn't reached), so trying again is safe;
     *   withheld: what went was only that there's something, the line looking like a secret
     */
    async send(message, { anyway = false } = {}) {
      if (!kept.topic || (!kept.on && !anyway) || !String(message?.text ?? '').trim()) return { went: false, again: false, withheld: false };
      const withheld = phoneText(message.text) === WITHHELD;
      try {
        await publish(message);
        last = { at: now(), ok: true, problem: '' };
        onChange();
        if (withheld) log('phone: a line looked like a secret, so only that there’s something was sent');
        // Withheld, the line itself is still to tell: it isn't on their phone.
        return { went: !withheld, again: false, withheld };
      } catch (err) {
        const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
        const unreached = /fetch failed|network|ENOTFOUND|ECONN|EAI_AGAIN/i.test(String(err?.message || ''));
        // Why, never what: the log is plain text, and so is the topic's name. An error not known is said in his own words.
        const problem = timedOut ? 'the server didn’t answer' : unreached ? 'the server couldn’t be reached' : err?.refused ? err.message : 'it couldn’t be sent';
        log('phone: a line didn’t go:', problem);
        last = { at: now(), ok: false, problem };
        onChange();
        // No answer in time may still have been delivered: that one isn't tried again.
        return { went: false, again: !timedOut && (unreached || err?.refused === true), withheld: false };
      }
    }
  };
}
