/**
 * How the user likes things done, as they've told him: their answers to the
 * questions he asks at a fork (which Hulu profile, which of two Dads, which
 * app their texts go through), kept so he asks each only once.
 *
 * The user, 2026-11-21, asked what he should do with an answer: "Remember it":
 * use it the next time without asking, changeable by telling him or in a list
 * in Settings. So each way is one line of theirs, "Hulu profile: Krish", that
 * goes with every task (the agents follow it without asking) and before their
 * words to the model he talks through.
 *
 * A way is what a choice was about, in a few words, and what they chose. One
 * about the same thing replaces the one before. Nothing that looks like a
 * secret is kept (vault-memory.js secretIn): a password is no preference.
 */

import { secretIn } from './vault-memory.js';

export const WAYS_KEY = 'ways';
export const WAYS_LIMITS = Object.freeze({ most: 60, about: 60, choice: 120, lines: 12 });
/** Words that say nothing of what a choice is about. */
const FILLER = new Set(['the', 'a', 'an', 'my', 'your', 'their', 'which', 'what', 'who', 'to', 'for', 'of', 'on', 'in', 'use', 'using', 'should', 'i', 'it', 'is', 'one']);

const tidy = (text, most) => String(text ?? '').replace(/\s+/g, ' ').trim().replace(/[.?!:;,]+$/, '').slice(0, most);
/** What a choice is about, as it's matched: "Which Hulu profile?" and "hulu profile" are one thing. */
export const wayKey = (about) => (String(about ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((word) => !FILLER.has(word)).sort().join(' ');

/**
 * @param {object} deps
 * @param {{get:Function, set:Function}} deps.storage  a chrome.storage-shaped area (storage.js `local`)
 * @param {() => void} [deps.onChange]  one was kept, changed or forgotten: Settings shows them
 * @param {() => number} [deps.now]
 * @param {(...parts:any[]) => void} [deps.log]
 */
export function createWays({ storage, onChange = () => undefined, now = Date.now, log = () => undefined }) {
  /** In memory once read: every task asks for them, and storage is a file. */
  let ways = null;
  let reading = null;

  async function load() {
    if (ways) return ways;
    reading ||= Promise.resolve(storage.get(WAYS_KEY)).then(
      (saved) => (Array.isArray(saved?.[WAYS_KEY]?.list) ? saved[WAYS_KEY].list : []).filter((way) => way && typeof way.about === 'string' && typeof way.choice === 'string' && wayKey(way.about)),
      () => []
    );
    ways = await reading;
    return ways;
  }

  let saving = Promise.resolve();
  function save() {
    const list = ways.map((way) => ({ ...way }));
    saving = saving.then(() => storage.set({ [WAYS_KEY]: { list } })).catch((err) => log('ways: couldn’t save:', err.message));
    try {
      onChange();
    } catch {
      /* a listener's trouble isn't the save's */
    }
    return saving;
  }

  return {
    /** Read from storage, for callers that then use `lines` and `list` without waiting. */
    ready: () => load().then(() => undefined),

    /** Every way kept, the newest first: {id, about, choice, at}. */
    list: () => (ways || []).map((way) => ({ ...way })).sort((a, b) => b.at - a.at),

    /** As lines for a task or a prompt, the newest first: "Hulu profile: Krish". Nothing until `ready`. */
    lines: (most = WAYS_LIMITS.lines) => (ways || []).slice().sort((a, b) => b.at - a.at).slice(0, most).map((way) => `${way.about}: ${way.choice}`),

    /** What they chose about something, or '': "hulu profile" finds what "Which Hulu profile?" kept. */
    find(about) {
      const key = wayKey(about);
      return (key && (ways || []).find((way) => wayKey(way.about) === key)?.choice) || '';
    },

    /**
     * Keeps a choice. One about the same thing is replaced.
     * @returns {Promise<{ok:boolean, why?:string, way?:object, was?:string}>} was: what they'd chosen before, if it changed
     */
    async set(about, choice) {
      await load();
      const what = tidy(about, WAYS_LIMITS.about);
      const chosen = tidy(choice, WAYS_LIMITS.choice);
      const key = wayKey(what);
      if (!key || !chosen) return { ok: false, why: 'There was nothing to keep.' };
      const secret = secretIn(`${what}: ${chosen}`) || secretIn(chosen);
      if (secret) return { ok: false, why: `That looks like ${secret}, which I don’t keep.` };
      const at = ways.findIndex((way) => wayKey(way.about) === key);
      const was = at >= 0 ? ways[at].choice : '';
      const way = { id: at >= 0 ? ways[at].id : `w${now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`, about: what, choice: chosen, at: now() };
      if (at >= 0) ways[at] = way;
      else ways.push(way);
      // The oldest go when there are more than a person would look through.
      if (ways.length > WAYS_LIMITS.most) ways = ways.sort((a, b) => b.at - a.at).slice(0, WAYS_LIMITS.most);
      await save();
      log('ways: kept one', at >= 0 ? '(changed)' : '(new)');
      return { ok: true, way: { ...way }, ...(was && was !== chosen ? { was } : {}) };
    },

    /**
     * Forgets a choice: by its id (Settings' ×), or by what it was about, in their words ("the Hulu profile").
     * @returns {Promise<{ok:boolean, gone:object[]}>}
     */
    async forget(which) {
      await load();
      const asked = String(which ?? '').trim();
      const key = wayKey(asked);
      const words = key.split(' ').filter(Boolean);
      const going = (way) => way.id === asked || (key && (wayKey(way.about) === key || (words.length > 0 && words.every((word) => wayKey(`${way.about} ${way.choice}`).split(' ').includes(word)))));
      const gone = ways.filter(going);
      if (!gone.length) return { ok: false, gone: [] };
      ways = ways.filter((way) => !going(way));
      await save();
      log('ways: forgot', gone.length);
      return { ok: true, gone: gone.map((way) => ({ ...way })) };
    },

    /** All of them forgotten (Settings › Memory › Forget it all). */
    async clear() {
      await load();
      ways = [];
      await save();
    }
  };
}
