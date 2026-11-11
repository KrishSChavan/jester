/**
 * What Jester learns as it's used — Atticus's idea: a task the assistant got
 * done is kept as the steps that did it, under the words that matter in how
 * it was asked, and the next time those words come it's done again without
 * the model (agent/replay.js), in a moment and for nothing. And what the user
 * teaches: "when I say focus mode, open Notes and put it on the left". And
 * what the conversation worked out: words it took to mean a command that then
 * worked ("open canvas" → "open the PSU Canvas bookmark") stand for that
 * command from then on, so the next time they're said its model isn't asked.
 * So do words that were the command's own ("open canvas" → "open Canvas")
 * when only Chrome or the assistant could do it: the matcher doesn't know
 * them, but there's nothing left for a model to work out.
 *
 * Only steps a fresh read can find again are kept — a control by its kind,
 * name and section, never a screen number or a spot — and never a task that
 * needed the user's OK, typed words the user didn't say or the words it's kept
 * under don't hold (a model's own writing, or that time's words, which a
 * replay would type again word for word), was about "this", or asked
 * something, in the user's words or the command's (its answer was that day's
 * screen, not the next one's). Of what the model said, only a command it gave
 * that worked is kept. Words stand for one only when they name what it did
 * and lean on nothing said before (aliasable): "try now", "the first result"
 * or "play something" meant what they did then. Nor for a web address the
 * user didn't say: the model's guess at a site would be opened every time
 * with no model to put it right. Nothing holding a password or
 * card number is listed for the vault's Routines note, a plain-text file, and
 * no words holding one stand for a command (vault-memory.js secretIn).
 *
 * Pure but for `storage` (chrome.storage-shaped: get, set), changed one change
 * at a time. The app keeps it sealed, as it does API keys (chrome-bridge.js
 * PRIVATE_KEYS).
 */

import { secretIn } from './vault-memory.js';

export const LEARNED_KEY = 'desktopLearned';
export const LEARNED_LIMITS = Object.freeze({ tasks: 100, phrases: 50, aliases: 50, steps: 20, unusedDays: 30 });
const DAY_MS = 86400000;

/** Words that don't change what's asked. Prepositions do ("from A to B"), so they stay. */
const FILLER = new Set(['a', 'an', 'the', 'please', 'can', 'could', 'would', 'will', 'you', 'me', 'um', 'uh', 'er', 'just', 'jester', 'hey', 'ok', 'okay']);
/** Words that ask for the same thing. */
const SAME = { create: 'make', start: 'make', launch: 'open' };
/** A task about what's on screen now is no task to repeat. */
const DEICTIC = /\b(?:this|that|these|those|here|it)\b/i;
/** A question: answered from what was on screen that time. */
const QUESTION_WORDS = /^\W*(?:what|what's|whats|who|whose|when|where|why|how|which|is|are|was|were|does|did|tell me|read me)\b/i;
/** A request put politely, which speech often writes with a question mark ("Can you make a new note?"). */
const POLITE = /^\W*(?:(?:can|could|would|will) you|please)\b[\s,]*/i;
/** A part of it that asks to be told something: "open Canvas and tell me what's due". A replay would do the rest, and never tell. */
const TELLS_BACK = /\b(?:tell|read) me\b|\blet me know\b|\bfind out\b|\b(?:check|see) (?:if|whether|what|when|who|how)\b|\b(?:and|then),? (?:what|what's|whats|who|when|where|which|whether|if|how|is|are|was|were|does|did)\b/i;

/** Words that lean on what came before: what they meant was the conversation's to work out, and changes with it. */
const LEANS_ON = new Set([
  'it', 'its', 'this', 'that', 'thats', 'these', 'those', 'here', 'heres', 'there', 'theres', 'him', 'his', 'her', 'hers', 'them', 'they', 'theyre',
  'their', 'theirs', 'he', 'hes', 'she', 'shes', 'one', 'again', 'same', 'other', 'another', 'else', 'instead', 'next', 'last', 'previous',
  'something', 'anything', 'someone', 'somebody', 'somewhere', 'whatever',
  // Which of a list just shown, or the newest of something: "the first result", "the latest episode".
  'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
  'top', 'bottom', 'latest', 'newest', 'oldest', 'earliest', 'recent'
]);
/** "The 2nd video": which of a list, in figures. */
const ORDINAL = /^\p{N}+(?:st|nd|rd|th)$/u;
/** Carrying on, or an answer: said after something, and meaning something only with it. */
const CARRIES_ON = /^\W*(?:yes|yeah|yep|yup|no|nope|nah|sure|alright|go ahead|go on|keep going|continue|carry on|try|retry|redo|resume|do it|and|also|then|now|but|wait|actually)\b/i;
/** Words that say only what kind of thing is asked for, or nothing: two requests that share no others needn't be one. */
const GENERIC = new Set([
  'open', 'play', 'start', 'launch', 'go', 'show', 'find', 'search', 'chrome', 'google', 'browser', 'bookmark', 'tab', 'app',
  'my', 'the', 'please', 'can', 'you', 'me', 'up',
  'make', 'create', 'new', 'get', 'put', 'set', 'turn', 'run', 'use', 'add', 'write', 'close', 'switch', 'bring', 'pull', 'take', 'look',
  'want', 'need', 'like', 'let',
  'and', 'for', 'with', 'from', 'into', 'onto', 'about', 'out', 'off', 'some', 'any', 'all', 'now', 'then', 'our', 'your',
  'page', 'site', 'website', 'link', 'window', 'screen', 'file', 'folder', 'song', 'music', 'video', 'playlist', 'album', 'episode', 'movie', 'podcast',
  'thing', 'stuff', 'note', 'email', 'mail', 'message', 'text', 'meeting', 'event', 'reminder'
]);
/** Where it's done, not what: "play a song on Spotify" names only a song, which the conversation chose. */
const WHERE = /\b(?:on|in|using|through|via)\s+(?:(?:the|my|a|an)\s+)?[\p{L}\p{N}’']+/giu;
/** A detail that dates: a number, a day, a month. One in the command that the user didn't say was the clock's or the conversation's. */
const DATED = /^(?:\p{N}.*|today|tonight|tomorrow|yesterday|(?:mon|tues|wednes|thurs|fri|satur|sun)day|january|february|march|april|may|june|july|august|september|october|november|december)$/u;
/** A web address, or a site by its domain: "https://canvas.psu.edu/grades", "www.reddit.com", "canvas.instructure.com". */
const WEB_ADDRESS = /\b(?:https?:\/\/|www\.)\S+|\b[\w-]+(?:\.[\w-]+)*\.(?:com|edu|org|net|io|dev|gov|app)\b\S*/gi;

/** Whether what was said asks something, rather than asking for something done. */
function asks(goal) {
  const said = String(goal).trim();
  const request = said.replace(POLITE, '');
  if (QUESTION_WORDS.test(request)) return true;
  // A question mark on a polite request is the recognizer's, not a question.
  return /\?\s*$/.test(said) && request === said;
}

/** Whether what was said is about what's on screen now: "this", or a question. */
export const aboutTheScreen = (goal) => DEICTIC.test(goal) || asks(goal);

/** Whether what was said asks to be told something, as a question or as "…and tell me what's due": a replay would tell nothing. */
export const asksToBeTold = (text) => asks(text) || TELLS_BACK.test(text);

const words = (text) => String(text ?? '').toLowerCase().replace(/[’']/g, '').match(/[\p{L}\p{N}]+/gu) || [];

/** The words that matter, in order: "Um, can you make a new Zoom meeting?" is "make new zoom meeting". */
export function gist(text) {
  return words(text)
    .filter((word) => !FILLER.has(word))
    .map((word) => SAME[word] || word)
    .join(' ');
}

/** A taught phrase as it's matched: its words, nothing else. */
export const phraseKey = (text) => words(text).join(' ');

/** Whether every word of `text` was said, in order, in `goal`. */
function wasSaid(goal, text) {
  const want = words(text);
  const have = words(goal);
  if (!want.length) return false;
  for (let start = 0; start + want.length <= have.length; start++) {
    if (want.every((word, i) => have[start + i] === word)) return true;
  }
  return false;
}

/** Whether a web address was said: written out, or spoken ("canvas dot psu dot edu"), with or without "https://" and "www.". */
const saidAddress = (goal, address) => wasSaid(String(goal).replace(/\s+dot\s+/gi, '.'), address.replace(/^(?:https?:\/\/)?(?:www\.)?/i, ''));

/**
 * The steps of a task done, if they can be done again without the model.
 * @param {string} goal  what was asked: the user's words, or in conversation the command they were taken to mean
 * @param {object[]} trace  loop.js's: {action, app, target?, targets?, sensitive?}
 * @param {{said?:string}} [options]  said: the user's own words, when `goal` is the conversation's command for
 *   them. They mustn't ask anything either, and what was typed must be in both: the user's, never the
 *   model's own writing, and the command's, which a replay for it would type again whatever was said then
 * @returns {{ok:true, steps:object[]}|{ok:false, why:string}}
 */
export function learnable(goal, trace, { said = '' } = {}) {
  if (!Array.isArray(trace) || !trace.length) return { ok: false, why: 'nothing was done' };
  if (DEICTIC.test(goal)) return { ok: false, why: 'it was about what was on screen then' };
  // "What's due on Canvas?" may come as "open Canvas and check my assignments": the asking was the user's.
  if ([goal, said].some((asked) => asked && asksToBeTold(asked))) return { ok: false, why: 'it asked something, and the answer changes' };
  if (trace.length > LEARNED_LIMITS.steps) return { ok: false, why: 'it took too many steps' };
  for (const step of trace) {
    if (step.sensitive) return { ok: false, why: 'a step needed your OK' };
    if ('target' in step && !step.target?.label) return { ok: false, why: 'a control it used has no name' };
    if (step.targets && !(step.targets.from?.label && step.targets.to?.label)) return { ok: false, why: 'a control it used has no name' };
    if (step.action.action === 'type') {
      if (!wasSaid(said || goal, step.action.text)) return { ok: false, why: 'it typed words you didn’t say' };
      if (!wasSaid(goal, step.action.text)) return { ok: false, why: 'it typed words the command didn’t say' };
    }
  }
  return { ok: true, steps: trace.map(({ sensitive, ...step }) => step) };
}

/** A word as two requests are compared by: "notes" is "note". */
const stem = (word) => (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word);

/** Why the user's words can't stand for the conversation's command, or '' when they can. `same`: aliasable's. */
function aliasProblem(said, text, same = false) {
  const key = gist(said);
  if (!key) return 'there were no words to know it by';
  if ((key === gist(text)) !== same) return same ? 'they aren’t the command’s own words' : 'they’re the command’s own words';
  if (String(said).length > 200 || String(text).length > 300) return 'it’s too long to keep';
  // Words that stand for a command are listed in the vault's Routines note, a plain-text file.
  const secret = secretIn(said) || secretIn(text);
  if (secret) return `it holds ${secret}`;
  if ([said, text].some((either) => aboutTheScreen(either) || TELLS_BACK.test(either))) return 'it was about the screen, or asked something';
  const yours = words(said);
  if (CARRIES_ON.test(said) || yours.some((word) => LEANS_ON.has(word) || ORDINAL.test(word))) return 'it leaned on what was said before';
  if (words(text).some((word) => DATED.test(word) && !yours.includes(word))) return 'the command had a date or number you didn’t say';
  // Nor a site: one the model made up ("open canvas" → canvas.instructure.com) would be opened every time, with no model to put it right.
  if ((String(text).match(WEB_ADDRESS) || []).some((address) => !saidAddress(said, address))) return 'the command had a web address you didn’t say';
  if (same) return '';
  const done = new Set(words(text).map(stem));
  const named = words(String(said).replace(WHERE, ' ')).map(stem).filter((word) => word.length >= 3 && !GENERIC.has(word) && !FILLER.has(word));
  return named.some((word) => done.has(word)) ? '' : 'the command wasn’t plainly what you named';
}

/**
 * Whether the user's words can stand for the command the conversation took them to mean, from now on: no
 * secret in either, not about the screen or a question, leaning on nothing said before ("try now", "open it",
 * "play something else", "the first result"), with no date, number or web address the user didn't say, and
 * naming something the command does ("open canvas" → "open the PSU Canvas bookmark"; never "play something"
 * → "play Gunna on Spotify"). `same`: the words are the command's own ("open canvas" → "open Canvas"), which
 * stand for it only where the matcher doesn't know them (voice-runner.js), and so name what it does already.
 */
export const aliasable = (said, text, { same = false } = {}) => !aliasProblem(said, text, same);

/** A learned task's steps, in a few words: "3 steps in Notes". */
function stepsDone(steps = []) {
  const apps = [...new Set(steps.map((step) => step.app).filter(Boolean))];
  const where = apps.length > 1 ? `${apps.slice(0, -1).join(', ')} and ${apps.at(-1)}` : apps[0];
  return `${steps.length} step${steps.length === 1 ? '' : 's'}${where ? ` in ${where}` : ''}`;
}

/**
 * @param {object} deps
 * @param {{get:(keys:any) => Promise<object>, set:(items:object) => Promise<void>}} deps.storage
 * @param {() => number} [deps.now]
 * @param {() => void|Promise<void>} [deps.onChange]  after anything is saved (the vault's Routines note reads list())
 */
export function createLearned({ storage, now = Date.now, onChange = () => undefined }) {
  async function load() {
    const { [LEARNED_KEY]: saved } = await storage.get(LEARNED_KEY);
    return { tasks: { ...(saved?.tasks || {}) }, phrases: { ...(saved?.phrases || {}) }, aliases: { ...(saved?.aliases || {}) } };
  }
  async function save(data) {
    await storage.set({ [LEARNED_KEY]: data });
    // Not waited for, and its trouble isn't the save's.
    try {
      Promise.resolve(onChange()).catch(() => undefined);
    } catch {
      /* a listener that threw: what was saved stands */
    }
  }
  /**
   * Each change loads, changes and saves the whole store, after the one before it is saved: two at once
   * (a replay's bookkeeping, not waited for, and the shortcut kept with it) would load the same, and the
   * second saved would undo the first.
   */
  let changing = Promise.resolve();
  function change(task) {
    const done = changing.then(task);
    changing = done.catch(() => undefined);
    return done;
  }
  const latest = (entry) => entry.used || entry.at || 0;
  const fresh = (entry) => now() - latest(entry) < LEARNED_LIMITS.unusedDays * DAY_MS;
  /** The newest `max` of `entries` that are still `keep`. */
  const newest = (entries, max, keep = () => true) =>
    Object.fromEntries(
      Object.entries(entries)
        .filter(([, entry]) => keep(entry))
        .sort(([, a], [, b]) => latest(b) - latest(a))
        .slice(0, max)
    );
  /** `entries` still `keep`, newest first, as list() gives them. */
  const listed = (entries, keep, shape) =>
    Object.values(entries)
      .filter(keep)
      .sort((a, b) => latest(b) - latest(a))
      .map((entry) => ({ ...shape(entry), used: latest(entry) }));

  return {
    /** A learned task asked for in these words, or null. */
    async find(text) {
      const key = gist(text);
      if (!key) return null;
      const entry = (await load()).tasks[key];
      return entry && fresh(entry) ? { key, ...entry } : null;
    },

    /**
     * Keeps a task the assistant got done, if it can be done again (learnable); says whether it's new.
     * @param {{said?:string}} [options]  said: the user's own words, when `goal` is the conversation's command for them
     */
    async remember(goal, trace, { said } = {}) {
      const kept = learnable(goal, trace, { said });
      const key = gist(goal);
      if (!kept.ok || !key) return { saved: false, why: kept.why || 'no words to know it by' };
      return change(async () => {
        const data = await load();
        const known = !!data.tasks[key];
        data.tasks[key] = { said: String(goal).slice(0, 200), steps: kept.steps, at: now(), used: now() };
        data.tasks = newest(data.tasks, LEARNED_LIMITS.tasks, fresh);
        await save(data);
        return { saved: true, known };
      });
    },

    /** A replay, or a command stood for, worked: its 30 days start again. @param {'task'|'alias'} [kind] */
    async used(key, kind = 'task') {
      return change(async () => {
        const data = await load();
        const entries = kind === 'alias' ? data.aliases : data.tasks;
        if (!entries[key]) return;
        entries[key].used = now();
        await save(data);
      });
    },

    /** The command these words were taken to mean in conversation, when it worked: {key, said, does, at, used}, or null. */
    async aliasFor(text) {
      const key = gist(text);
      if (!key) return null;
      const entry = (await load()).aliases[key];
      return entry && fresh(entry) ? { key, ...entry } : null;
    },

    /**
     * The user's words, which the conversation took to mean a command that then worked: they stand for it from
     * now on, if they can (aliasable). Says whether they stood for something already.
     * @param {{same?:boolean}} [options]  same: the words are the command's own, which only Chrome or the
     *   assistant could do: kept so that the next time they're said, no model is asked to work them out
     */
    async alias(said, text, { same = false } = {}) {
      const why = aliasProblem(said, text, same);
      if (why) return { saved: false, why };
      return change(async () => {
        const data = await load();
        // A phrase is only ever the user's own words, never what other words stand for.
        if (data.phrases[phraseKey(text)]) return { saved: false, why: 'the command is a phrase you taught' };
        const key = gist(said);
        const known = !!data.aliases[key];
        data.aliases[key] = { said: String(said).trim(), does: String(text).trim(), at: now(), used: now() };
        data.aliases = newest(data.aliases, LEARNED_LIMITS.aliases, fresh);
        await save(data);
        return { saved: true, known };
      });
    },

    /** Words whose command didn't work stand for nothing now: the next time, the conversation works them out afresh. */
    async unalias(text) {
      return change(async () => {
        const data = await load();
        const key = gist(text);
        if (!data.aliases[key]) return false;
        delete data.aliases[key];
        await save(data);
        return true;
      });
    },

    /** The sentence a taught phrase stands for, or null. */
    async phrase(text) {
      const key = phraseKey(text);
      return key ? (await load()).phrases[key] || null : null;
    },

    /** "When I say <phrase>, <sentence>": the user's own command. */
    async teach(phrase, sentence) {
      return change(async () => {
        const data = await load();
        data.phrases[phraseKey(phrase)] = { phrase: String(phrase).slice(0, 80), say: String(sentence).slice(0, 300), at: now() };
        data.phrases = newest(data.phrases, LEARNED_LIMITS.phrases);
        await save(data);
      });
    },

    /**
     * Forgets what these words were taught, taken to mean or learned to do, all of it: nothing learned is
     * left to answer to them. Says what went, a phrase before an alias before a task, or null.
     */
    async forget(text) {
      return change(async () => {
        const data = await load();
        const phrase = phraseKey(text);
        const key = gist(text);
        const gone = data.phrases[phrase] ? 'phrase' : data.aliases[key] ? 'alias' : data.tasks[key] ? 'task' : null;
        delete data.phrases[phrase];
        delete data.aliases[key];
        delete data.tasks[key];
        if (gone) await save(data);
        return gone;
      });
    },

    /**
     * Everything taught, taken to mean and learned, for the vault's Routines note: phrases, then aliases,
     * then tasks, each newest first. `does`: the taught sentence, the command, or the steps in a few words.
     * The note is a plain-text file, so nothing holding a password, card number or key is listed: a phrase
     * or task holding one is still kept here, sealed, and done.
     * @returns {Promise<{kind:'phrase'|'alias'|'task', said:string, does:string, used:number}[]>} used: ms, last used or kept
     */
    async list() {
      const data = await load();
      return [
        ...listed(data.phrases, () => true, (entry) => ({ kind: 'phrase', said: entry.phrase, does: entry.say })),
        ...listed(data.aliases, fresh, (entry) => ({ kind: 'alias', said: entry.said, does: entry.does })),
        ...listed(data.tasks, fresh, (entry) => ({ kind: 'task', said: entry.said, does: stepsDone(entry.steps) }))
      ].filter((item) => !secretIn(item.said) && !secretIn(item.does));
    }
  };
}
