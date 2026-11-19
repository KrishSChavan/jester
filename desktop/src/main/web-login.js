/**
 * Signing in to his website with a password (the user, 2026-11-19: a "public address with a login", "start with
 * password"), so a new device needs no link and no Tailscale.
 *
 * The password is the user's to set, from a device that's signed in already (Settings › Devices). Only a salted
 * scrypt hash of it is kept, sealed on the server's disk with his other keys. With his website reachable from the
 * whole internet, this is what stands between it and the user's mail, notes and Mac, so guessing is made slow:
 *
 *   - five wrong tries from one address lock that address out for a minute, then two, four… up to an hour;
 *   - thirty wrong tries from anywhere in a quarter of an hour lock password sign-in for everyone for that long
 *     (devices signed in already, and his key link, go on working: the key is far too long to guess);
 *   - and each try costs the server a tenth of a second of work (scrypt), whoever makes it.
 */

import crypto from 'node:crypto';

export const SHORTEST = 10;
const LONGEST = 200;
const COST = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };
const FREE_TRIES = 5;
const FIRST_LOCK_MS = 60 * 1000;
const LONGEST_LOCK_MS = 60 * 60 * 1000;
const FLOOD = 30;
const FLOOD_MS = 15 * 60 * 1000;
const REMEMBERED = 2000;
/** Passwords anyone would try first. */
const COMMON = new Set(['password', 'password1', 'password12', 'password123', 'passw0rd123', '1234567890', '12345678910', 'qwertyuiop', 'qwerty12345', 'iloveyou123', 'letmein1234', 'jester1234', 'jesterjester', 'administrator', 'welcome123', 'changeme123']);

/** Why a password won't do, in words, or '' if it will. */
export function passwordProblem(password) {
  const text = String(password ?? '');
  if (text.length < SHORTEST) return `Use at least ${SHORTEST} characters: a few words together is easy to type and hard to guess.`;
  if (text.length > LONGEST) return 'That’s longer than a password needs to be.';
  if (COMMON.has(text.toLowerCase()) || /^(.)\1+$/.test(text) || /^\d+$/.test(text)) return 'That one’s too easy to guess. Try a few words together.';
  return '';
}

const hashOf = (password, salt) =>
  new Promise((resolve, reject) => crypto.scrypt(String(password).normalize('NFKC'), salt, 32, COST, (err, key) => (err ? reject(err) : resolve(key))));

/**
 * @param {object} deps
 * @param {{get:Function, set:Function, remove:Function}} deps.storage   storage.local: the `webLogin` key, sealed (chrome-bridge.js)
 */
export function createWebLogin({ storage, now = Date.now, log = () => undefined }) {
  /** { salt, hash, at } as base64, or null with none set. */
  let kept = null;
  /** Wrong tries by where they came from: { count, until }. */
  const sources = new Map();
  /** When the wrong tries of the last quarter hour were, from anywhere. */
  let recent = [];
  let floodUntil = 0;

  const lockOf = (count) => (count < FREE_TRIES ? 0 : Math.min(FIRST_LOCK_MS * 2 ** (count - FREE_TRIES), LONGEST_LOCK_MS));

  /** How long a source must wait before another try, in ms: 0 if it may try now. */
  function waitFor(source) {
    const at = now();
    return Math.max(0, floodUntil - at, (sources.get(String(source))?.until || 0) - at);
  }

  /** A wrong try: of a password, or of a key or a code in a link. */
  function failed(source) {
    const at = now();
    const name = String(source);
    const entry = sources.get(name) || { count: 0, until: 0 };
    entry.count += 1;
    entry.until = at + lockOf(entry.count);
    sources.delete(name);
    sources.set(name, entry);
    if (sources.size > REMEMBERED) sources.delete(sources.keys().next().value);
    recent = recent.filter((time) => at - time < FLOOD_MS);
    recent.push(at);
    if (recent.length >= FLOOD && floodUntil <= at) {
      floodUntil = at + FLOOD_MS;
      log(`sign-in: ${recent.length} wrong tries in a quarter hour: password sign-in is closed for that long`);
    }
    if (entry.count === FREE_TRIES) log('sign-in: an address is locked out after wrong tries');
  }

  async function matches(password) {
    if (!kept) return false;
    const hash = await hashOf(password, Buffer.from(kept.salt, 'base64'));
    const mine = Buffer.from(kept.hash, 'base64');
    return hash.length === mine.length && crypto.timingSafeEqual(hash, mine);
  }

  return {
    async start() {
      const stored = (await storage.get('webLogin')).webLogin;
      if (stored && typeof stored.salt === 'string' && typeof stored.hash === 'string') kept = { salt: stored.salt, hash: stored.hash, at: Number(stored.at) || 0 };
    },
    /** Whether a password is set, and since when: for Settings and the sign-in page. Never the password or its hash. */
    state: () => ({ set: !!kept, at: kept?.at || 0 }),
    waitFor,
    failed,
    /**
     * A try at signing in.
     * @returns {Promise<{ok:boolean, wait:number, error:string}>}  wait: ms before this source may try again
     */
    async check(password, source) {
      const wait = waitFor(source);
      if (wait) return { ok: false, wait, error: `Too many wrong tries. Try again in ${Math.ceil(wait / 60000)} minute${wait > 60000 ? 's' : ''}.` };
      if (!kept) return { ok: false, wait: 0, error: 'No password is set for this Jester yet. Sign in with your link, then set one in Settings › Devices.' };
      const text = String(password ?? '');
      if (text && text.length <= LONGEST && (await matches(text))) {
        sources.delete(String(source));
        return { ok: true, wait: 0, error: '' };
      }
      failed(source);
      const next = waitFor(source);
      return { ok: false, wait: next, error: next ? `That’s not it, and that was one try too many. Try again in ${Math.ceil(next / 60000)} minute${next > 60000 ? 's' : ''}.` : 'That’s not the password.' };
    },
    /**
     * A password set or changed, from a device that's signed in. With one set already, the current one is asked
     * for: a browser left signed in somewhere can't be used to take the password over.
     * @returns {Promise<{ok:boolean, error:string}>}
     */
    async set(password, { current = '', source = 'signed-in' } = {}) {
      if (kept) {
        const allowed = await this.check(current, `change:${source}`);
        if (!allowed.ok) return { ok: false, error: allowed.wait ? allowed.error : 'The current password isn’t right.' };
      }
      const problem = passwordProblem(password);
      if (problem) return { ok: false, error: problem };
      const salt = crypto.randomBytes(16);
      kept = { salt: salt.toString('base64'), hash: (await hashOf(password, salt)).toString('base64'), at: now() };
      await storage.set({ webLogin: kept });
      log('sign-in: a password was set');
      return { ok: true, error: '' };
    },
    /** No password any more: only his key link signs a device in. The current one is asked for. */
    async remove({ current = '', source = 'signed-in' } = {}) {
      if (!kept) return { ok: true, error: '' };
      const allowed = await this.check(current, `change:${source}`);
      if (!allowed.ok) return { ok: false, error: allowed.wait ? allowed.error : 'The current password isn’t right.' };
      kept = null;
      await storage.remove('webLogin');
      log('sign-in: the password was removed');
      return { ok: true, error: '' };
    }
  };
}
