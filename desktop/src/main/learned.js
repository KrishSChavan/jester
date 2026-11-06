/**
 * What Jester learns as it's used — Atticus's idea: a task the assistant got
 * done is kept as the steps that did it, under the words that matter in how
 * it was asked, and the next time those words come it's done again without
 * the model (agent/replay.js), in a moment and for nothing. And what the user
 * teaches: "when I say focus mode, open Notes and put it on the left".
 *
 * Only steps a fresh read can find again are kept — a control by its kind,
 * name and section, never a screen number or a spot — and never a task that
 * needed the user's OK, typed words the user didn't say (a model's own
 * writing, which a replay would repeat word for word), was about "this", or
 * asked something (its answer was that day's screen, not the next one's).
 * Nothing the model said is kept, only what was done.
 *
 * Pure but for `storage` (chrome.storage-shaped: get, set). The app keeps it
 * sealed, as it does API keys (chrome-bridge.js PRIVATE_KEYS).
 */

export const LEARNED_KEY = 'desktopLearned';
export const LEARNED_LIMITS = Object.freeze({ tasks: 100, phrases: 50, steps: 20, unusedDays: 30 });
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
function said(goal, text) {
  const want = words(text);
  const have = words(goal);
  if (!want.length) return false;
  for (let start = 0; start + want.length <= have.length; start++) {
    if (want.every((word, i) => have[start + i] === word)) return true;
  }
  return false;
}

/**
 * The steps of a task done, if they can be done again without the model.
 * @param {string} goal  what the user said
 * @param {object[]} trace  loop.js's: {action, app, target?, targets?, sensitive?}
 * @returns {{ok:true, steps:object[]}|{ok:false, why:string}}
 */
export function learnable(goal, trace) {
  if (!Array.isArray(trace) || !trace.length) return { ok: false, why: 'nothing was done' };
  if (DEICTIC.test(goal)) return { ok: false, why: 'it was about what was on screen then' };
  if (asks(goal)) return { ok: false, why: 'it asked something, and the answer changes' };
  if (trace.length > LEARNED_LIMITS.steps) return { ok: false, why: 'it took too many steps' };
  for (const step of trace) {
    if (step.sensitive) return { ok: false, why: 'a step needed your OK' };
    if ('target' in step && !step.target?.label) return { ok: false, why: 'a control it used has no name' };
    if (step.targets && !(step.targets.from?.label && step.targets.to?.label)) return { ok: false, why: 'a control it used has no name' };
    if (step.action.action === 'type' && !said(goal, step.action.text)) return { ok: false, why: 'it typed words you didn’t say' };
  }
  return { ok: true, steps: trace.map(({ sensitive, ...step }) => step) };
}

/**
 * @param {object} deps
 * @param {{get:(keys:any) => Promise<object>, set:(items:object) => Promise<void>}} deps.storage
 * @param {() => number} [deps.now]
 */
export function createLearned({ storage, now = Date.now }) {
  async function load() {
    const { [LEARNED_KEY]: saved } = await storage.get(LEARNED_KEY);
    return { tasks: { ...(saved?.tasks || {}) }, phrases: { ...(saved?.phrases || {}) } };
  }
  const save = (data) => storage.set({ [LEARNED_KEY]: data });
  const fresh = (entry) => now() - (entry.used || entry.at || 0) < LEARNED_LIMITS.unusedDays * DAY_MS;
  /** The newest `max` of `entries` that are still `keep`. */
  const newest = (entries, max, keep = () => true) =>
    Object.fromEntries(
      Object.entries(entries)
        .filter(([, entry]) => keep(entry))
        .sort(([, a], [, b]) => (b.used || b.at || 0) - (a.used || a.at || 0))
        .slice(0, max)
    );

  return {
    /** A learned task asked for in these words, or null. */
    async find(text) {
      const key = gist(text);
      if (!key) return null;
      const entry = (await load()).tasks[key];
      return entry && fresh(entry) ? { key, ...entry } : null;
    },

    /** Keeps a task the assistant got done, if it can be done again (learnable); says whether it's new. */
    async remember(goal, trace) {
      const kept = learnable(goal, trace);
      const key = gist(goal);
      if (!kept.ok || !key) return { saved: false, why: kept.why || 'no words to know it by' };
      const data = await load();
      const known = !!data.tasks[key];
      data.tasks[key] = { said: String(goal).slice(0, 200), steps: kept.steps, at: now(), used: now() };
      data.tasks = newest(data.tasks, LEARNED_LIMITS.tasks, fresh);
      await save(data);
      return { saved: true, known };
    },

    /** A replay worked: its 30 days start again. */
    async used(key) {
      const data = await load();
      if (!data.tasks[key]) return;
      data.tasks[key].used = now();
      await save(data);
    },

    /** The sentence a taught phrase stands for, or null. */
    async phrase(text) {
      const key = phraseKey(text);
      return key ? (await load()).phrases[key] || null : null;
    },

    /** "When I say <phrase>, <sentence>": the user's own command. */
    async teach(phrase, sentence) {
      const data = await load();
      data.phrases[phraseKey(phrase)] = { phrase: String(phrase).slice(0, 80), say: String(sentence).slice(0, 300), at: now() };
      data.phrases = newest(data.phrases, LEARNED_LIMITS.phrases);
      await save(data);
    },

    /** Forgets a taught phrase, or a learned task, by its words; says what went. */
    async forget(text) {
      const data = await load();
      const phrase = phraseKey(text);
      const task = gist(text);
      const gone = data.phrases[phrase] ? 'phrase' : data.tasks[task] ? 'task' : null;
      if (gone === 'phrase') delete data.phrases[phrase];
      if (gone === 'task') delete data.tasks[task];
      if (gone) await save(data);
      return gone;
    }
  };
}
