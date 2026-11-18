/**
 * Learning from the chats the user imported from Claude and ChatGPT (chat-import.js). Imported, a chat is only a
 * note that a question may find a line of: asked "what do you know about me?" after 1,648 of them, Jester knew the
 * same five things as before (2026-11-17). So, when the user says to (Settings › Memory), each chat is read once by
 * the talking model:
 *
 * 1. What it was about is kept in the chat's own note, as properties: a one-sentence `summary`, `topics`, `people`,
 *    and `about_you`, the lasting things the user's own words said about themselves. Search finds a chat by these,
 *    and a note that has a `summary` has been read: stopped or quit, the run carries on from where it was.
 * 2. Then what was said about the user, over all the chats, is put before the model as a numbered list, oldest
 *    first, and it picks the numbers worth keeping: lasting, not out of date, not said twice. Those go into About me,
 *    dated by their chat. The model only picks: a fact kept is one a chat's reading found, word for word. What has
 *    been offered once isn't offered again, so a fact the user deletes from About me stays deleted.
 *
 * What the model is given of a chat is what the user wrote in it and how each reply began, never what was pasted or
 * made, nor a line left out as a secret. A fact is kept only if a word of it is in the user's own lines.
 */

import nodeFs from 'node:fs';
import path from 'node:path';
import { IMPORTED_IN, SECTIONS } from './vault.js';
import { checked, factKey } from './vault-memory.js';

/** How much of a chat the model reads: all of a short one, the start and the end of a long one. */
const SAID_CHARS = 6000;
/** Of one message of the user's, and of one reply (how it began says what the chat was doing). */
const YOURS_CHARS = 1200;
const THEIRS_CHARS = 240;
/** The most one chat says about its user. */
export const MOST_PER_CHAT = 5;
const LEARN_TOKENS = 500;
/** Chats read at once. */
const AT_ONCE = 3;
/** Failures in a row that end a run: the model's away, and the rest would fail the same. */
const FAILURES = 4;
/** How many facts the model picks from at a time, and the most a run puts in About me. */
const PICK_FROM = 200;
export const PICK_MOST = 60;
const PICK_TOKENS = 600;

export const LEARN_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    summary: { type: 'string' },
    topics: { type: 'array', items: { type: 'string' } },
    people: { type: 'array', items: { type: 'string' } },
    facts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { section: { type: 'string', enum: [...SECTIONS] }, fact: { type: 'string' } },
        required: ['section', 'fact'],
        additionalProperties: false
      }
    }
  },
  required: ['summary', 'topics', 'people', 'facts'],
  additionalProperties: false
});

export const PICK_SCHEMA = Object.freeze({
  type: 'object',
  properties: { keep: { type: 'array', items: { type: 'integer' } } },
  required: ['keep'],
  additionalProperties: false
});

/** The same for every chat, so a provider that caches a prompt's start reads it once: the chat's own day is in what follows. */
export const LEARN_PROMPT = [
  'You keep the memory of Jester, a voice assistant. Below is a chat its user had with another AI assistant (Claude or ChatGPT), which they imported into their notes. ' +
    'Lines starting "User:" are the user’s own words. The other lines are only how each of the assistant’s replies began.',
  'Reply with JSON: {"summary":"…","topics":["…"],"people":["…"],"facts":[{"section":"…","fact":"…"}]}',
  '"summary": one sentence of at most 30 words on what the user wanted and what came of it, in the past tense, starting "The user". ' +
    'Never a password, PIN, code, card number or key. Call them "the user" or "they": never "he" or "she".',
  '"topics": one to four lowercase words or short phrases, like "calculus" or "resume".',
  '"people": the names of real people in the user’s life that the user talked about. Never the assistant, the user, an author, a public figure or a character.',
  '"facts": only lasting things the user’s own words plainly say about themselves, the people in their life, their preferences, routines, school, work, projects and plans. ' +
    'Each is one short sentence that leaves out "the user", like "Majors in data science at Penn State" or "Sister is named Priya".',
  'Most chats have none: then "facts" is []. Asking about a thing doesn’t make it theirs: homework, an essay, code, a job listing, text they pasted, ' +
    'a story, or a role they asked the assistant to play say nothing about them unless their own words say so ("my resume", "I’m taking", "my girlfriend"). ' +
    'Never what the assistant said or supposed, never a one-off request ("asked for a cover letter" is not a fact), never a guess of yours, never a password, PIN, code, card number or key.',
  'Never a passing mood, worry or trouble with someone: "felt unwanted by their girlfriend" is not a fact, "Girlfriend is named Trisha" is. ' +
    'Of a project, say what it is and who it’s for ("Building a rewards app for State College restaurants"), not how it’s built: never its stack, host, tools or settings. ' +
    'Each fact is at most 16 words.',
  'The chat’s date is given first. A fact that was true around then, and may not be now, says when, so that it stays true: ' +
    '"Was a high-school senior in spring 2024", "Took STAT 200 in fall 2025", "Was 17 in March 2023": never "Is a senior", "Takes STAT 200", "Is 17". A plan says its date.',
  `"section" is one of: ${SECTIONS.join(', ')}. At most ${MOST_PER_CHAT} facts.`
].join('\n');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDay = (date) => `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
const monthOf = (ms) => (Number.isFinite(ms) ? `${MONTHS[new Date(ms).getMonth()].slice(0, 3)} ${new Date(ms).getFullYear()}` : 'undated');

/** What the model's told, to pick the facts worth keeping. */
function pickPrompt(date, known, most) {
  return [
    'You keep the memory of Jester, a voice assistant. Below is a numbered list of things its user said about themselves in chats with other AI assistants over the years, ' +
      `each with the month it was said, oldest first. Today is ${longDay(date)}. Pick the ones worth Jester keeping as lasting facts about them.`,
    'Reply with JSON: {"keep":[numbers]}',
    'Keep what a good friend would remember, in this order: who they are, what and where they study, the jobs they have and have had, the people in their life by name, ' +
      'the projects they built or are building, lasting interests, habits and tastes, and plans still ahead.',
    'Leave out: what was only for one task or one day; how a project is built (its stack, host, tools, design choices); a mood, worry or trouble with someone, which is private and passes; ' +
      'what says the same as another you keep or as what Jester already knows (of two that say the same, keep the newer and fuller); ' +
      'what a newer line shows is no longer so; and plans for dates gone by.',
    `Keep at most ${most}. Fewer is fine, and so is none.`,
    `What Jester knows about the user already:\n${known.length ? known.map((fact) => `- ${fact}`).join('\n') : 'Nothing yet.'}`
  ].join('\n');
}

const one = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const cut = (text, most) => (text.length <= most ? text : `${text.slice(0, most).replace(/[\uD800-\uDBFF]$/, '').trimEnd()}…`);
const listOf = (value) => (Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : []);
const isChat = (rel, data) => data?.type === 'chat' && IMPORTED_IN.includes(String(rel).split('/')[0]);
/** Words that tell one fact from another: four letters or more, or a number. */
const tellingWords = (text) => String(text).toLowerCase().match(/[\p{L}]{4,}|\p{N}+/gu) || [];

/**
 * An imported chat's note as the model reads it: who said what, in order. Of the user, their words (not what they
 * pasted or attached); of the assistant, how each reply began. Code is "(code)". A long chat is its start and its end.
 * @param {string} body  the note's, as chat-import.js wrote it
 * @returns {{text:string, yours:string}}  yours: the user's own words, which a fact has to come from
 */
export function chatSaid(body) {
  const messages = [];
  let current = null;
  let fence = '';
  for (const raw of String(body ?? '').split(/\r?\n/)) {
    const heading = !fence && /^## (You|Claude|ChatGPT)(?: · .*)?$/.exec(raw);
    if (heading) {
      current = { you: heading[1] === 'You', who: heading[1], lines: [] };
      messages.push(current);
      continue;
    }
    if (!current) continue;
    const mark = /^ {0,3}(`{3,}|~{3,})/.exec(raw)?.[1];
    if (mark && (!fence || (mark[0] === fence[0] && mark.length >= fence.length))) {
      if (!fence) current.lines.push('(code)');
      fence = fence ? '' : mark;
      continue;
    }
    if (fence || /^>/.test(raw) || /^_(?:(?:Claude|ChatGPT) used|Attached): /.test(raw) || /^\s*\(Jester left out a line here: /.test(raw)) continue;
    current.lines.push(raw.replace(/^#{1,6}\s+/, '').replace(/\\#/g, '#'));
  }
  const said = messages
    .map((message) => ({ you: message.you, text: cut(one(message.lines.join(' ')), message.you ? YOURS_CHARS : THEIRS_CHARS), who: message.who }))
    .filter((message) => message.text);
  const lines = said.map((message) => `${message.you ? 'User' : message.who}: ${message.text}`);
  const yours = said.filter((message) => message.you).map((message) => message.text).join('\n');
  const total = lines.reduce((sum, line) => sum + line.length + 1, 0);
  if (total <= SAID_CHARS) return { text: lines.join('\n'), yours };
  // The start, where what's wanted is said, and the end, where it came out.
  const head = [];
  const tail = [];
  let used = 0;
  let from = 0;
  let to = lines.length - 1;
  while (from <= to && used + lines[from].length + 1 <= SAID_CHARS * 0.6) {
    used += lines[from].length + 1;
    head.push(lines[from++]);
  }
  while (to >= from && used + lines[to].length + 1 <= SAID_CHARS) {
    used += lines[to].length + 1;
    tail.unshift(lines[to--]);
  }
  const left = to - from + 1;
  return { text: [...head, ...(left > 0 ? [`(${left} message${left === 1 ? '' : 's'} left out here.)`] : []), ...tail].join('\n'), yours };
}

/**
 * The model's account of a chat, checked as a conversation's is (vault-memory.js): and its facts kept only when a
 * telling word of each is in what the user wrote, so the assistant's words and the model's guesses aren't theirs.
 */
export function learnedOf(json, { title, yours }, log = () => undefined) {
  const kept = checked({ title, summary: json?.summary, topics: json?.topics, people: json?.people, facts: { add: json?.facts, remove: [] } }, [], [{ who: 'you', text: title }], log);
  const said = new Set(tellingWords(yours));
  const about = kept.add.filter(({ fact }) => tellingWords(fact).some((word) => said.has(word))).slice(0, MOST_PER_CHAT);
  // A name is someone in their life only if they wrote it.
  const people = kept.people.filter((name) => tellingWords(name).some((word) => said.has(word)) || yours.toLowerCase().includes(name.toLowerCase()));
  return { summary: kept.summary, topics: kept.topics, people, about };
}

/**
 * @param {object} options
 * @param {() => object|null} options.vault  vault.js's, as it is now
 * @param {(request:object) => Promise<{json:object}>} options.request  the talking job
 * @param {string} [options.file]  where what's been offered for About me is kept (the app's own folder)
 * @param {() => void} [options.onChange]  the run moved on: Settings is told
 */
export function createChatLearner({ vault: chosen, request, file = '', fs = nodeFs, now = Date.now, log = () => undefined, onChange = () => undefined, atOnce = AT_ONCE }) {
  const state = { running: false, phase: '', total: 0, done: 0, failed: 0, added: 0, error: '', finished: 0 };
  /** The vault's imported chats as last counted: null until they have been. */
  let counted = null;
  /** …and the vault they were counted in: another one chosen, they're not its. */
  let countedIn = '';
  let stopping = false;
  const current = () => {
    try {
      return chosen?.() || null;
    } catch {
      return null;
    }
  };
  const changed = () => {
    try {
      onChange();
    } catch (err) {
      log('learning: couldn’t say how it’s going:', err.message);
    }
  };

  /** Every imported chat's note: where it is and what its properties say. */
  function chats(vault) {
    const found = [];
    for (const note of vault.listNotes()) {
      if (!IMPORTED_IN.includes(note.rel.split('/')[0])) continue;
      try {
        const { data, title } = vault.read(note.rel);
        if (isChat(note.rel, data)) found.push({ rel: note.rel, data, title });
      } catch {
        /* unreadable: not one to learn from */
      }
    }
    return found;
  }
  const learned = (data) => typeof data?.summary === 'string' && !!data.summary.trim();

  /** How many chats are imported, how many have been read, and what they're mostly about: for Settings, and for him. */
  function count() {
    const vault = current();
    if (!vault) return (counted = null);
    try {
      const all = chats(vault);
      const sources = {};
      const topics = new Map();
      let first = Infinity;
      let last = -Infinity;
      for (const { rel, data } of all) {
        const source = rel.split('/')[0];
        sources[source] = (sources[source] || 0) + 1;
        const at = Date.parse(data.created);
        if (Number.isFinite(at)) {
          first = Math.min(first, at);
          last = Math.max(last, at);
        }
        for (const topic of listOf(data.topics)) topics.set(one(topic).toLowerCase(), (topics.get(one(topic).toLowerCase()) || 0) + 1);
      }
      const top = [...topics].filter(([topic]) => topic).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12).map(([topic]) => topic);
      counted = { chats: all.length, learned: all.filter(({ data }) => learned(data)).length, sources, topics: top, from: Number.isFinite(first) ? new Date(first).getFullYear() : null, to: Number.isFinite(last) ? new Date(last).getFullYear() : null };
      // Kept, so that he knows of them when next started without reading every chat again.
      countedIn = vault.root;
      keep({ counted, root: vault.root });
    } catch (err) {
      log('learning: couldn’t count the imported chats:', err.message);
      counted = null;
    }
    return counted;
  }

  /** What's kept between runs, in the app's own folder: what's been offered for About me, and the last count. */
  function kept() {
    try {
      const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
      return stored && typeof stored === 'object' ? stored : {};
    } catch {
      return {};
    }
  }
  function keep(changes) {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const next = `${file}.tmp`;
      fs.writeFileSync(next, JSON.stringify({ ...kept(), version: 1, ...changes }), { mode: 0o600 });
      fs.renameSync(next, file);
    } catch (err) {
      log('learning: couldn’t keep where it had got to:', err.message);
    }
  }
  const offered = () => new Set(listOf(kept().offered).filter((key) => typeof key === 'string'));
  const keepOffered = (keys) => keep({ offered: [...keys] });

  /** One chat, read by the model and its note told what it's about. */
  async function learn(vault, { rel, title }) {
    const note = vault.read(rel);
    const { text, yours } = chatSaid(note.body);
    const source = rel.split('/')[0];
    const at = Date.parse(note.data.created);
    // Nothing of the user's in it (a picture alone, say): it's about what it's called, and there's nothing to ask.
    if (!one(yours)) return vault.learnedChat(rel, { summary: `The user’s chat with ${source} called “${cut(one(title), 80)}”, with nothing they wrote kept.`, topics: [], people: [], about: [] });
    const { json } = await request({
      system: LEARN_PROMPT,
      prompt: `Chat with ${source}${Number.isFinite(at) ? ` on ${longDay(new Date(at))}` : ''}, called “${cut(one(title), 120)}”.\n\n${text}`,
      schema: LEARN_SCHEMA,
      maxOutputTokens: LEARN_TOKENS
    });
    return vault.learnedChat(rel, learnedOf(json, { title, yours }, log));
  }

  /** The model's pick of `list` (numbered from 1): their places in it, at most `most`. */
  async function pick(list, known, most) {
    const { json } = await request({
      system: pickPrompt(new Date(now()), known, most),
      prompt: list.map((item, i) => `${i + 1}. [${monthOf(item.at)}] ${item.section}: ${item.fact}`).join('\n'),
      schema: PICK_SCHEMA,
      maxOutputTokens: PICK_TOKENS
    });
    const seen = new Set();
    return listOf(json?.keep)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= list.length && !seen.has(n) && seen.add(n))
      .slice(0, most)
      .map((n) => list[n - 1]);
  }

  /** What the chats said about the user, not yet offered: picked over, and the picks put in About me. */
  async function settle(vault) {
    const known = listOf(vault.aboutMe()?.facts).map((item) => one(item?.fact)).filter(Boolean);
    const have = new Set(known.map(factKey));
    const before = offered();
    const byKey = new Map();
    for (const { data } of chats(vault)) {
      const at = Date.parse(data.created);
      for (const line of listOf(data.about_you)) {
        // As the note keeps it: "People: Sister is named Priya".
        const [, section, fact] = /^([^:]{1,40}):\s+(.+)$/.exec(one(line)) || [];
        const key = factKey(fact);
        if (!key || !SECTIONS.includes(section) || have.has(key) || before.has(key)) continue;
        const had = byKey.get(key);
        if (!had || (Number.isFinite(at) && at > had.at)) byKey.set(key, { key, section, fact, at: Number.isFinite(at) ? at : had?.at ?? NaN });
      }
    }
    let list = [...byKey.values()].sort((a, b) => (Number.isFinite(a.at) ? a.at : 0) - (Number.isFinite(b.at) ? b.at : 0));
    if (!list.length) return 0;
    const all = list;
    // A long list is picked from a part at a time, then the picks from each other.
    if (list.length > PICK_FROM) {
      const picks = [];
      for (let i = 0; i < list.length && !stopping; i += PICK_FROM) picks.push(...(await pick(list.slice(i, i + PICK_FROM), known, Math.ceil(PICK_MOST / 2))));
      list = picks;
    }
    if (stopping) return 0;
    const kept = list.length > PICK_MOST || list === all ? await pick(list, known, PICK_MOST) : list;
    // Dated by the chat each was said in, a day's together.
    const days = new Map();
    for (const item of kept) {
      const day = Number.isFinite(item.at) ? new Date(item.at).toDateString() : '';
      days.set(day, [...(days.get(day) || []), item]);
    }
    let added = 0;
    for (const items of days.values()) {
      added += vault.updateAboutMe({ add: items.map(({ section, fact }) => ({ section, fact })) }, Number.isFinite(items[0].at) ? items[0].at : undefined).added;
    }
    keepOffered(new Set([...before, ...all.map((item) => item.key)]));
    return added;
  }

  async function run() {
    const vault = current();
    if (!vault) throw new Error('There’s no vault to learn into.');
    const todo = chats(vault).filter(({ data }) => !learned(data));
    Object.assign(state, { phase: 'chats', total: todo.length, done: 0, failed: 0, added: 0, error: '' });
    changed();
    let next = 0;
    let inARow = 0;
    let fatal = null;
    const worker = async () => {
      while (next < todo.length && !stopping && !fatal) {
        const chat = todo[next++];
        try {
          await learn(vault, chat);
          inARow = 0;
          state.done++;
        } catch (err) {
          state.failed++;
          log(`learning: couldn’t read a chat (${err.message})`);
          // The vault gone, or a model only Settings can put right: the rest would go the same way.
          if (++inARow >= FAILURES || ['ENOTDIR', 'EACCES', 'EPERM', 'ENOSPC', 'model_pool_empty'].includes(err.code) || (err.code === 'http_error' && [401, 403, 404].includes(err.status))) fatal = err;
        }
        changed();
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(atOnce, todo.length)) }, worker));
    if (fatal) throw fatal;
    if (stopping) return;
    state.phase = 'facts';
    changed();
    state.added = await settle(vault);
  }

  return {
    /** How the run's going, or went. */
    status: () => ({ ...state }),
    /** The imported chats, counted now. */
    count,
    /** …or as last counted, in this run or an earlier one (null if never, or for another vault): for a turn of talk, which doesn't wait on the disk. */
    counted() {
      const vault = current();
      if (!vault) return null;
      if (countedIn !== vault.root) {
        const stored = kept();
        counted = stored.root === vault.root && Number.isInteger(stored.counted?.chats) ? stored.counted : null;
        countedIn = vault.root;
      }
      return counted;
    },
    /** Reads every chat not yet read, then settles what goes in About me. Resolves when it's over, however it ended. */
    async start() {
      if (state.running) return;
      stopping = false;
      Object.assign(state, { running: true, error: '', phase: 'chats', total: 0, done: 0, failed: 0, added: 0 });
      try {
        await run();
        log(`learning: ${stopping ? 'stopped' : 'done'}: ${state.done} chat(s) read, ${state.failed} not, ${state.added} fact(s) into About me`);
      } catch (err) {
        state.error = err.message;
        log('learning: stopped:', err.message);
      } finally {
        Object.assign(state, { running: false, phase: '', finished: now() });
        count();
        changed();
      }
    },
    /** Ends the run after the chats being read now. */
    stop() {
      if (state.running) stopping = true;
    }
  };
}
