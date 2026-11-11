/**
 * Finding things in the user's Obsidian vault, for what Jester remembers
 * (vault-memory.js). All of the vault is read but Jester's own views (Routines,
 * Index, the readme) and hidden folders, and each note is kept in pieces a
 * heading long, or a few lines of a long one, so no piece is longer than what
 * the model is given of it. Each is labelled with its note's title, headings and
 * properties: "About me › People", "Conversations on Monday, November 9, 2026 ›
 * 10:05 AM · Algorithms midterm prep". A note's other properties ("birthday:
 * 2004-04-17") are its first lines.
 *
 * A question finds pieces two ways at once. By meaning, through nomic-embed-text
 * in Ollama on this computer, so "when's my algorithms midterm" finds "Midterm 2:
 * Friday, November 13"; and by words (BM25), so a name or a course number the
 * embedding blurs still counts, and so it all still works, less well, with Ollama
 * off. The two rankings are fused, with a nudge for a note the question names and
 * for the notes of a day it asks about ("what did we talk about yesterday"). A day
 * only mentioned ("what's the weather like today") nudges just what the rankings
 * found, so chit-chat doesn't bring back all of the day's notes.
 * Below a floor, meaning doesn't count: unrelated text still scores about 0.5 with
 * this model. The floor and nudges are from desktop/scripts/vault-eval.mjs, which
 * has the numbers.
 *
 * The index is a JSON file of the app's, never in the vault. A note is read again
 * only when it changes (or couldn't be read last time), and a piece is embedded
 * again only when its words do. It follows whichever vault `vault()` gives, so
 * choosing another needs no restart: close() is for quitting, and nothing works
 * after it.
 */

import { createHash } from 'node:crypto';
import nodeFs from 'node:fs';
import path from 'node:path';
import { PATHS } from './vault.js';

/** Raised whenever what a piece is made of changes: a note that hasn't changed isn't read again, so its old pieces would stay. */
const VERSION = 2;
const DOCUMENT = 'search_document: ';
const QUERY = 'search_query: ';
const KEEP_ALIVE = '10m';
/** Pieces Ollama embeds at once: 32 long ones took 0.6 s, warm, on the user's Mac. */
const BATCH = 32;
const EMBED_MS = 30000;
/** A question waits this long for its own embedding: recall has about 1.5 s in all, and words alone beat nothing. */
const QUERY_MS = 1200;
/** Loading the model took 0.3–1 s, cold. */
const WARM_MS = 20000;
/** After embedding fails, it's tried again at a refresh this long after. */
const RETRY_MS = 60 * 1000;
/** Obsidian saves as the user types: a refresh waits for a pause this long. */
const WATCH_MS = 1500;
/** A vault's first embedding is saved this often as it goes: a crash or a quit midway loses no more. */
const SAVE_MS = 30 * 1000;
/**
 * A section longer than LONG is cut at blank lines, else at line ends, into parts of about PART_MIN to PART_MAX
 * characters. The model is given at most 420 characters of a piece, with what it is ("- Note “Fall 2026
 * schedule”: …", vault-memory.js): a longer one lost its last lines, a schedule's Thursday (vault-eval.mjs).
 */
const LONG = 360;
const PART_MIN = 120;
const PART_MAX = 320;
/** A bigger note is an export or a log, not notes, and would take minutes to embed. */
const MAX_NOTE_BYTES = 2e6;
/** How far down each ranking is fused, and reciprocal-rank fusion's k. */
const TOP = 50;
const RRF_K = 60;
/** BM25's usual. */
const K1 = 1.2;
const B = 0.75;
/** Questions' embeddings kept: asking again costs nothing. */
const ASKED_KEPT = 100;
const NOT_RUNNING = 'Ollama isn’t running';
const SLOW = 'Ollama didn’t answer in time';
const DENIED = new Set(['EPERM', 'EACCES']);

/**
 * Tuned with vault-eval.mjs on a sample vault, 2026-11-10 (its header has the table), and the same again with
 * pieces cut to fit what the model is given.
 * floor           the least cosine that counts as meaning
 * wordShare       how much of a question's words (by BM25 weight) a piece needs to count by words
 * wordShareAlone  the same with Ollama off, when words are all there is: MRR 0.58 at 0.5, 0.83 at this
 * titleBonus      for a note the question names: its title, its file's name or an alias
 * dayBonus        for a note of a day the question asks about: that day's conversations, what was remembered then
 */
export const TUNING = Object.freeze({ floor: 0.6, wordShare: 0.5, wordShareAlone: 0.1, titleBonus: 0.01, dayBonus: 0.02 });

/** Words that say nothing about what's wanted, written or said aloud. Checked before and after plurals go. */
const STOPWORDS = new Set(
  `a about after again all also am an and any are as at be because been before being both but by can cant could couldnt did didnt do does doesnt
  doing dont during each few for from had hadnt has hasnt have havent having he her here hers herself him himself his how i if ill im in into is isnt
  it its itself ive just let lets me more most my myself no nor not now of off on once only or other our ours ourselves out over own same she should
  shouldnt so some such than that thats the their theirs them themselves then there theres these they theyd theyre this those through to too under
  until up us very was wasnt we were werent what whats when whens where wheres which while who whos whom why will with wont would wouldnt you youd
  youll youre youve your yours yourself hey hi hello jester please thanks thank okay ok um uh oh yeah like really actually maybe tell know remind
  thing things stuff`.split(/\s+/)
);
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
/** "Friday", "last Friday", "Friday’s": the weekday, and which one. */
const WEEKDAY = new RegExp(`\\b(?:(last|next|this) )?(${WEEKDAYS.join('|')})s?\\b`, 'g');
/** "November 9", "Nov. 9th", "November 9th’s". */
const MONTH_DAY = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)(?:uary|ruary|ch|il|e|y|ust|t|tember|ober|ember)?\.? (\d{1,2})(?:st|nd|rd|th)?s?\b/g;
/** Words for a day daysIn() works out: they count for a piece that has them, never against one that doesn't. */
const DAY_WORDS = new Set(['today', 'tonight', 'yesterday', 'tomorrow', 'morning', 'afternoon', 'evening', 'night']);
/**
 * What a question about a day itself asks: "what did we talk about yesterday", "what did I ask you to remember on
 * Thursday", "recap today’s conversations". One of these and, but for the day and DAY_FILLER, no other words.
 */
const ABOUT_A_DAY = new Set(
  `talk talked talking say said saying tell told telling ask asked asking discuss discussed discussing discussion chat chatted chatting
  conversation remember remembered mention mentioned happen happened do did done recap summary summarize summarise`
    .split(/\s+/)
    .map(stem)
);
/** "earlier today", "all day yesterday", "did anything happen on Friday". */
const DAY_FILLER = new Set(['day', 'earlier', 'later', 'past', 'anything', 'something', 'everything', 'else'].map(stem));
const LABEL_KEYS = /(?:^|; )(?:type|folder|tags|topics|people|aliases): /g;
/** Properties that file a note or say when it was written: labelsOf has the filing, and nobody asks the rest. */
const UNSAID = new Set(['type', 'tags', 'aliases', 'cssclasses', 'cssclass', 'title', 'created', 'updated', 'position']);
/** A day's topics and people are its conversations', each in its own section, and its date is in its name. */
const UNSAID_OF_A_DAY = new Set(['date', 'topics', 'people']);
/** Jester's own views of the vault, told by where they are: a note of the user's may well say `type: index`. */
const VIEWS = new Set([PATHS.routines, PATHS.index, PATHS.readme]);
const MEDIA = /\.(?:avif|bmp|gif|heic|jpe?g|png|svg|tiff?|webp|pdf|flac|m4a|mp3|ogg|wav|mkv|mov|mp4|webm)$/i;

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const nameOf = (rel) => path.posix.basename(String(rel)).replace(/\.md$/i, '');
const hidden = (rel) => String(rel).split(/[\\/]/).some((part) => part.startsWith('.'));
const digest = (text) => createHash('sha256').update(text).digest('hex').slice(0, 32);

/** Words as they're compared: NFKC, lower case, apostrophes gone ("what's" is "whats"). */
const tokens = (text) =>
  String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .match(/[\p{L}\p{M}\p{N}]+/gu) || [];

/**
 * Plurals, roughly, with the e gone after s, x, z, ch or sh, so a word and its plural meet however it's spelt:
 * "exams" is "exam", "classes" "class", "size" and "sizes" "siz", "cache" and "caches" "cach", "quizzes" "quiz",
 * "groceries" "grocery" (and "movie", "movies" both "movy").
 */
function stem(word) {
  if (word.length <= 3 || /\d/.test(word)) return word;
  const single = word.endsWith('s') && !/(?:ss|us|is)$/.test(word) ? word.slice(0, -1) : word;
  // "skies" is "sky". "lenses" stays apart from "lens", as "houses" ends as it does: meaning finds those.
  if (single.length > 3 && single.endsWith('ie')) return `${single.slice(0, -2)}y`;
  // Kept whole, to be known for one: "these" isn't "thes".
  if (STOPWORDS.has(single)) return single;
  const bare = single.length >= 4 && /(?:[sxz]|ch|sh)e$/.test(single) ? single.slice(0, -1) : single;
  return bare.endsWith('zz') ? bare.slice(0, -1) : bare;
}

/** The words BM25 counts: no stopwords, plurals made single. */
function terms(text) {
  return tokens(text).flatMap((word) => {
    if (STOPWORDS.has(word)) return [];
    const single = stem(word);
    return STOPWORDS.has(single) || (single.length < 2 && !/\d/.test(single)) ? [] : [single];
  });
}

/** A property's value as a list of strings, whichever shape it was written in. */
const listOf = (value, separator) =>
  (Array.isArray(value) ? value : value === null || value === undefined ? [] : separator ? String(value).split(separator) : [value])
    .map((item) => String(item ?? '').trim().replace(/^#/, ''))
    .filter(Boolean);

/**
 * A note's properties as one line to find it by: "type: profile; folder: Jester; tags: jester/profile; aliases: About me".
 * The folder, the user's own filing, only goes in what's embedded (vault-eval.mjs: MRR 0.84 to 0.88 by meaning):
 * as words, "car" would find everything in Car/.
 */
function labelsOf(data, folder = '') {
  const type = typeof data?.type === 'string' ? data.type.trim() : '';
  // A day's topics and people are all its conversations': each one's are in its own section.
  const day = type === 'conversations';
  return [
    ['type', type ? [type] : []],
    ['folder', folder ? [folder] : []],
    ['tags', listOf(data?.tags, /[,\s]+/)],
    ['topics', day ? [] : listOf(data?.topics, /,/)],
    ['people', day ? [] : listOf(data?.people, /,/)],
    ['aliases', listOf(data?.aliases)]
  ]
    .filter(([, values]) => values.length)
    .map(([key, values]) => `${key}: ${values.join(', ')}`)
    .join('; ');
}

/** What a note is called: its title, its file's name and its aliases. */
const namesOf = (rel, title, data) => [...new Set([title, nameOf(rel), ...listOf(data?.aliases)].map((name) => String(name ?? '').trim()).filter(Boolean))];

/** The day a note is of: its `date` property, or the date its file's name starts with (a day's conversations, what was remembered). */
const noteDay = (rel, data) => [data?.date, nameOf(rel)].map((value) => String(value ?? '').match(/^\d{4}-\d{2}-\d{2}/)?.[0]).find(Boolean) || '';

/**
 * The days a question is about, as local YYYY-MM-DD: "yesterday", "this morning", "on Friday" (the last
 * one and the next), "November 9", and "yesterday’s" too; `rest` is the question with them taken out.
 */
function daysIn(text, at) {
  const today = new Date(at);
  const day = (offset) => dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset));
  const days = new Set();
  const taken = (key) => {
    days.add(key);
    return ' ';
  };
  const rest = String(text)
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/\b(?:today|tonight)s?\b|\bthis (?:morning|afternoon|evening)s?\b/g, () => taken(day(0)))
    .replace(/\bday before yesterdays?\b/g, () => taken(day(-2)))
    .replace(/\b(?:yesterdays?|last nights?)\b/g, () => taken(day(-1)))
    .replace(/\btomorrows?\b/g, () => taken(day(1)))
    .replace(WEEKDAY, (all, which, name) => {
      const back = (today.getDay() - WEEKDAYS.indexOf(name) + 7) % 7;
      if (!back && !which) days.add(day(0));
      if (which !== 'next') days.add(day(-(back || 7)));
      if (which !== 'last') days.add(day(7 - back));
      return ' ';
    })
    .replace(MONTH_DAY, (all, month, date) => {
      const when = new Date(today.getFullYear(), MONTHS[month], Number(date));
      // "December 20" said in January is last December's.
      if (when - today > 183 * 86400000) when.setFullYear(when.getFullYear() - 1);
      return when.getDate() === Number(date) ? taken(dayKey(when)) : ' ';
    })
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, taken);
  return { days, rest };
}

/** Whether `words` holds `phrase`, word for word. */
function within(words, phrase) {
  for (let start = 0; start + phrase.length <= words.length; start++) {
    if (phrase.every((word, i) => words[start + i] === word)) return true;
  }
  return false;
}

/** A link's words: `[[a|b]]` is b, `[[a#Heading]]` "a › Heading". */
function linkWords(inner) {
  const [target, shown] = inner.split('|');
  return (shown ?? target.replace(/#\^[\w-]*$/, '').replace(/#/g, ' › ')).trim();
}

/** A note's text as it's read: no properties, comments or pictures, and links as their words. */
function clean(body) {
  return String(body ?? '')
    .replace(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/, '')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/!\[\[([^\]\n]*)\]\]/g, (all, inner) => (MEDIA.test(inner.split('|')[0].trim()) ? '' : linkWords(inner)))
    .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, '')
    .replace(/\[\[([^\]\n]*)\]\]/g, (all, inner) => linkWords(inner));
}

/** The text under each heading (#, ## and ###), with the headings it's under. A # in a code block is code. */
function sections(text) {
  const found = [];
  const heads = [];
  let lines = [];
  let fence = '';
  const close = () => {
    const body = lines.join('\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
    if (body) found.push({ heads: heads.filter(Boolean), text: body });
    lines = [];
  };
  for (const line of text.split(/\r?\n/)) {
    const mark = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (mark && (!fence || (mark[0] === fence[0] && mark.length >= fence.length))) fence = fence ? '' : mark;
    const heading = !fence && !mark && /^ {0,3}(#{1,3})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (!heading) {
      lines.push(line);
      continue;
    }
    close();
    heads.length = heading[1].length;
    heads[heading[1].length - 1] = heading[2].trim();
  }
  close();
  return found;
}

/** A paragraph over PART_MAX, cut at line ends, else after sentences, else between words. */
function fit(text, level = 0) {
  if (text.length <= PART_MAX) return [text];
  const cuts = [/\n/, /(?<=[.!?])\s+/, /\s+/];
  if (level === cuts.length) return text.match(new RegExp(`[\\s\\S]{1,${PART_MAX}}`, 'g'));
  const glue = level ? ' ' : '\n';
  const parts = [];
  let part = '';
  for (const bit of text.split(cuts[level]).flatMap((piece) => fit(piece, level + 1))) {
    const joined = part ? `${part}${glue}${bit}` : bit;
    if (part && joined.length > PART_MAX) {
      parts.push(part);
      part = bit;
    } else part = joined;
  }
  if (part) parts.push(part);
  return parts;
}

/** A section in parts of about PART_MIN to PART_MAX characters, cut at blank lines where it can be, else at line ends; a short one whole. */
function split(text) {
  if (text.length <= LONG) return [text];
  const parts = [];
  let part = '';
  for (const paragraph of text.split(/\n[ \t]*\n/).flatMap((piece) => fit(piece.trim())).filter(Boolean)) {
    const joined = part ? `${part}\n\n${paragraph}` : paragraph;
    if (part && joined.length > PART_MAX && (part.length >= PART_MIN || joined.length > LONG)) {
      parts.push(part);
      part = paragraph;
    } else part = joined;
  }
  // A scrap left at the end goes with the part before it.
  if (part && parts.length && part.length < PART_MIN / 2 && parts.at(-1).length + part.length + 2 <= LONG) parts.push(`${parts.pop()}\n\n${part}`);
  else if (part) parts.push(part);
  return parts;
}

/**
 * What a note's other properties say, a line each, as Obsidian lists them: "- birthday: 2004-04-17". Notes often
 * keep their facts there, and the model reads a piece's text, not its labels. A line each, so a password kept in
 * one leaves out only its own line of what the model is given (vault-memory.js).
 */
function propertiesOf(data, day) {
  const values = (value) =>
    [value]
      .flat(Infinity)
      .filter((item) => ['string', 'number', 'boolean'].includes(typeof item))
      .map((item) => String(item).replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  return clean(
    Object.entries(data && typeof data === 'object' ? data : {})
      .filter(([key]) => !UNSAID.has(key) && !(day && UNSAID_OF_A_DAY.has(key)))
      .map(([key, value]) => [key, values(value)])
      .filter(([, said]) => said.length)
      .map(([key, said]) => `- ${key}: ${said.join(', ')}`)
      .join('\n')
  );
}

/** A note's sections with its properties on top: in the first, if that's the top of the note, else a section of their own. */
function withProperties(found, said, name) {
  if (!said) return found;
  const [first, ...rest] = found;
  const top = first && (!first.heads.length || (first.heads.length === 1 && first.heads[0].toLowerCase() === name.toLowerCase()));
  return top ? [{ heads: first.heads, text: `${said}\n\n${first.text}` }, ...rest] : [{ heads: [], text: said }, ...found];
}

/**
 * A note in the pieces it's searched by: one per heading (#, ##, ###; About me's sections and a day's
 * conversations each their own, however short), a long one cut at blank lines and line ends, but for a
 * day's conversation, which the model is given by its summary. Its other properties are the first piece's
 * first lines, or its only ones. `embedText` is what's embedded: the piece with its note's title, headings
 * and labels on top, which is most of what makes "who's my roommate" find "- Dev Patel" under About me › People.
 * @param {{rel:string, title?:string, data?:object, body:string}} note  vault.read's
 * @returns {{id:string, rel:string, title:string, type:string, heading:string, text:string, embedText:string}[]}
 */
export function chunkNote({ rel, title, data, body }) {
  const name = String(title ?? '').trim() || nameOf(rel);
  const type = typeof data?.type === 'string' ? data.type.trim() : '';
  const folder = path.posix.dirname(String(rel));
  const labels = labelsOf(data, folder === '.' ? '' : folder);
  const day = type === 'conversations';
  const found = withProperties(sections(clean(body)), propertiesOf(data, day), name);
  // A day's conversations stay whole, however long: the model is given each by its summary, which fits, and a
  // conversation in two pieces would take both of what a search gives of its day.
  const pieces = found.flatMap(({ heads, text }) => (day ? [text] : split(text)).map((part) => ({ heads, text: part })));
  return pieces.map(({ heads, text }, i) => {
    const heading = heads.join(' › ');
    const header = !heads.length ? name : heads[0].toLowerCase() === name.toLowerCase() ? heading : `${name} › ${heading}`;
    return { id: `${rel}#${i}`, rel, title: name, type, heading, text, embedText: `${DOCUMENT}${header}\n${labels ? `${labels}\n` : ''}${text}` };
  });
}

const encode = (vector) => Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('base64');
function decode(text) {
  if (typeof text !== 'string' || !text) return null;
  const bytes = Buffer.from(text, 'base64');
  if (!bytes.length || bytes.length % 4) return null;
  // Copied, not viewed: a Buffer's bytes needn't sit where a Float32Array can start.
  const vector = new Float32Array(bytes.length / 4);
  new Uint8Array(vector.buffer).set(bytes);
  return vector;
}
/** At length 1, so a dot product is the cosine. */
function unit(values) {
  const vector = Float32Array.from(values);
  const length = Math.hypot(...vector) || 1;
  for (let i = 0; i < vector.length; i++) vector[i] /= length;
  return vector;
}

/**
 * A piece's whole section: it and the parts beside it that split() cut from the same one, in order. What's found is
 * a few lines, by what they say; what answers may be a line or two further on ("what time is my physics lab" finds
 * Tuesday's "PHYS 212 lecture" in a week's schedule, and the lab is Thursday's).
 * @returns {{first:number, section:string}}  first: where the section starts in the table, which names it
 */
function sectionAt(table, index) {
  const { rel, chunk } = table.pieces[index];
  const same = (at) => table.pieces[at]?.rel === rel && table.pieces[at].chunk.heading === chunk.heading;
  let first = index;
  while (same(first - 1)) first -= 1;
  let last = index;
  while (same(last + 1)) last += 1;
  return { first, section: table.pieces.slice(first, last + 1).map((piece) => piece.chunk.text).join('\n') };
}

/** What search reads: every piece with its words counted, and the notes' names. */
function build(notes) {
  const pieces = [];
  const postings = new Map();
  const names = [];
  let words = 0;
  for (const [rel, note] of Object.entries(notes)) {
    if (!note.chunks?.length) continue;
    for (const name of note.names || []) {
      const phrase = tokens(name).map(stem);
      // One word names a note only if it's a real one: "Mom", "Dev", not "me".
      if (phrase.length > 1 || (phrase.length === 1 && phrase[0].length >= 3 && !STOPWORDS.has(phrase[0]))) names.push([rel, phrase]);
    }
    const labelWords = String(note.labels || '').replace(LABEL_KEYS, ' ');
    for (const chunk of note.chunks) {
      const counted = terms(`${note.title}\n${chunk.heading}\n${labelWords}\n${chunk.text}`);
      const counts = new Map();
      for (const term of counted) counts.set(term, (counts.get(term) || 0) + 1);
      for (const [term, count] of counts) {
        if (!postings.has(term)) postings.set(term, []);
        postings.get(term).push([pieces.length, count]);
      }
      pieces.push({ rel, title: note.title, type: note.type || '', day: note.day || '', chunk, length: counted.length });
      words += counted.length;
    }
  }
  return { pieces, postings, names, average: pieces.length ? words / pieces.length : 1 };
}

/** BM25 over the pieces that have enough of the question's words (wordShare of their weight), best first. */
function byWords(table, text, share) {
  const asked = [...new Set(terms(text))];
  if (!asked.length) return [];
  const count = table.pieces.length;
  const weight = new Map(
    asked.map((term) => {
      const n = table.postings.get(term)?.length || 0;
      return [term, Math.log(1 + (count - n + 0.5) / (n + 0.5))];
    })
  );
  // A word nowhere in the vault weighs most: what's asked about may not be here at all.
  const whole = asked.filter((term) => !DAY_WORDS.has(term)).reduce((sum, term) => sum + weight.get(term), 0);
  // Only a day's words ("how are you doing this morning"): nothing to go on, or any piece saying "morning" would do.
  if (!whole) return [];
  const scores = new Map();
  const covered = new Map();
  for (const term of asked) {
    for (const [index, times] of table.postings.get(term) || []) {
      const saturated = (times * (K1 + 1)) / (times + K1 * (1 - B + (B * table.pieces[index].length) / table.average));
      scores.set(index, (scores.get(index) || 0) + weight.get(term) * saturated);
      if (!DAY_WORDS.has(term)) covered.set(index, (covered.get(index) || 0) + weight.get(term));
    }
  }
  return [...scores]
    .filter(([index]) => (covered.get(index) || 0) >= share * whole - 1e-9)
    .map(([index, score]) => ({ index, score }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, TOP);
}

/** The pieces whose meaning is at least `floor` like the question's, best first. */
function byMeaning(table, vector, floor) {
  const found = [];
  table.pieces.forEach((piece, index) => {
    const other = piece.chunk.vector;
    if (!other || other.length !== vector.length) return;
    let cosine = 0;
    for (let i = 0; i < vector.length; i++) cosine += vector[i] * other[i];
    if (cosine >= floor) found.push({ index, score: cosine });
  });
  return found.sort((a, b) => b.score - a.score || a.index - b.index).slice(0, TOP);
}

/** Reciprocal-rank fusion of the rankings, and the nudges: a note the question names, a day it asks about. */
function fuse(table, lists, text, at, tune) {
  const fused = new Map();
  const hit = (index) => {
    if (!fused.has(index)) fused.set(index, { index, score: 0, words: false, meaning: false, cosine: -1 });
    return fused.get(index);
  };
  for (const [kind, list] of lists) {
    list.forEach(({ index, score }, rank) => {
      const found = hit(index);
      found.score += 1 / (RRF_K + rank + 1);
      found[kind] = true;
      if (kind === 'meaning') found.cosine = score;
    });
  }
  const asked = tokens(text).map(stem);
  const named = new Set(table.names.filter(([, phrase]) => within(asked, phrase)).map(([rel]) => rel));
  const { days, rest } = daysIn(text, at);
  // A question about the day itself takes in all its notes. One that only mentions a day ("what's the weather like
  // today") is about something else: the day nudges what a ranking found, or chit-chat would bring back the day's notes.
  const ofADay = (term) => ABOUT_A_DAY.has(term) || DAY_FILLER.has(term) || DAY_WORDS.has(term);
  const wholeDay = tokens(rest).some((word) => ABOUT_A_DAY.has(stem(word))) && terms(rest).every(ofADay);
  if (named.size || days.size) {
    // Found by name, or by the day asked about, a note is in even if neither ranking had it.
    table.pieces.forEach((piece, index) => {
      const ofTheDay = days.has(piece.day) && (wholeDay || fused.has(index));
      const bonus = (named.has(piece.rel) ? tune.titleBonus : 0) + (ofTheDay ? tune.dayBonus : 0);
      if (bonus <= 0) return;
      const found = hit(index);
      found.score += bonus;
      found.words = true;
    });
  }
  // A tie (first by words against first by meaning) goes to meaning, the better ranking alone in vault-eval.mjs.
  return [...fused.values()].sort((a, b) => b.score - a.score || b.cosine - a.cosine || a.index - b.index);
}

/**
 * The vault's search index, kept in `file`.
 * @param {object} options
 * @param {() => ({root:string, listNotes:Function, read:Function}|null)} options.vault  the vault chosen (vault.js), or null
 * @param {string} options.file  where the index is kept: the app's folder, never the vault
 * @param {typeof fetch} [options.fetchImpl]
 * @param {string} [options.model]  an Ollama embedding model
 * @param {string} [options.ollama]
 * @param {(...parts:any[]) => void} [options.log]
 * @param {() => number} [options.now]
 * @param {typeof nodeFs} [options.fs]
 * @param {(status:object) => void} [options.onRefreshed]  after each refresh, whatever began it (the watcher too)
 */
export function createVaultIndex({
  vault,
  file,
  fetchImpl = globalThis.fetch,
  model = 'nomic-embed-text',
  ollama = 'http://127.0.0.1:11434',
  log = () => undefined,
  now = Date.now,
  fs = nodeFs,
  onRefreshed = () => undefined
}) {
  let state = { root: null, updatedAt: 0, notes: {} };
  let table = build({});
  let running = null;
  let again = false;
  let closed = false;
  /** The last scan: which vault, when. */
  let scanned = { root: undefined, at: -Infinity };
  /** Why the vault can't be read ('denied', or another reason), or null. */
  let blocked = null;
  /** Why meaning is off, in plain words, or ''. */
  let error = '';
  let failedAt = -Infinity;
  /** Ollama's off or hasn't the model: no use asking again for a while. A slow answer is worth another try. */
  let hard = false;
  /** Read again was asked for: the next scan asks Ollama first, however lately it failed. */
  let retrying = false;
  let watcher = null;
  let watched = '';
  let timer = null;
  const closing = new AbortController();
  const questions = new Map();

  /** The vault chosen now. Closed, there's none: it's off, and finds nothing. */
  const current = () => {
    if (closed) return null;
    try {
      return vault?.() || null;
    } catch {
      return null;
    }
  };

  function load() {
    if (!file) return;
    try {
      const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
      // Another version's pieces, or another model's vectors, are no use: built afresh.
      if (stored?.version !== VERSION || stored.model !== model || typeof stored.root !== 'string' || typeof stored.notes !== 'object') return;
      const notes = {};
      for (const [rel, note] of Object.entries(stored.notes || {})) {
        if (Array.isArray(note?.chunks)) notes[rel] = { ...note, chunks: note.chunks.map((chunk) => ({ ...chunk, vector: decode(chunk.vector) })) };
      }
      state = { root: stored.root, updatedAt: Number(stored.updatedAt) || 0, notes };
      table = build(notes);
    } catch {
      /* none yet, or not one of ours: built afresh */
    }
  }

  function save() {
    if (!file) return;
    try {
      const notes = {};
      for (const [rel, note] of Object.entries(state.notes)) {
        notes[rel] = { ...note, chunks: note.chunks.map((chunk) => ({ ...chunk, vector: chunk.vector ? encode(chunk.vector) : null })) };
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // Written beside it and swapped in: a crash never leaves half an index.
      const next = `${file}.tmp`;
      fs.writeFileSync(next, JSON.stringify({ version: VERSION, model, root: state.root, updatedAt: state.updatedAt, notes }), { mode: 0o600 });
      fs.renameSync(next, file);
    } catch (err) {
      log('vault index: couldn’t save:', err.message);
    }
  }

  function failed(err) {
    if (closed) return;
    const why =
      err?.name === 'TimeoutError'
        ? SLOW
        : err?.status === 404 || /not found/i.test(err?.message)
          ? `${model} isn’t in Ollama`
          : err?.status
            ? `Ollama couldn’t embed: ${err.message}`
            : err?.name === 'TypeError'
              ? NOT_RUNNING
              : `Ollama couldn’t embed: ${err?.message}`;
    if (why !== error) log('vault index: searching by words only:', why);
    error = why;
    hard = why !== SLOW;
    failedAt = now();
  }

  function succeeded() {
    if (error) log('vault index: searching by meaning again');
    error = '';
    hard = false;
    failedAt = -Infinity;
  }

  /** Vectors for `input`, at length 1. Throws as fetch does, or with the HTTP status. */
  async function embed(input, ms) {
    const response = await fetchImpl(`${ollama}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input, keep_alive: KEEP_ALIVE, truncate: true }),
      signal: AbortSignal.any([closing.signal, AbortSignal.timeout(ms)])
    });
    const reply = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(String(reply?.error || `HTTP ${response.status}`)), { status: response.status });
    const vectors = reply?.embeddings;
    if (!Array.isArray(vectors) || vectors.length !== input.length || !vectors.every((vector) => Array.isArray(vector) && vector.length)) {
      throw Object.assign(new Error('no embeddings came back'), { status: 500 });
    }
    return vectors.map(unit);
  }

  /** Whether Ollama embeds a word now, whenever it last failed. Loading the model is most of it. */
  async function reach() {
    try {
      await embed([`${QUERY}hello`], WARM_MS);
      succeeded();
      return true;
    } catch (err) {
      failed(err);
      return false;
    }
  }

  /** The question's vector, or null: Ollama's off, or slow. */
  async function questionVector(text) {
    if (questions.has(text)) {
      const vector = questions.get(text);
      questions.delete(text);
      questions.set(text, vector);
      return vector;
    }
    if (hard && now() - failedAt < RETRY_MS) return null;
    try {
      const [vector] = await embed([`${QUERY}${text}`], QUERY_MS);
      succeeded();
      questions.set(text, vector);
      if (questions.size > ASKED_KEPT) questions.delete(questions.keys().next().value);
      return vector;
    } catch (err) {
      failed(err);
      return null;
    }
  }

  function entry(rel, note, mtimeMs, size, known) {
    const data = note?.data || {};
    const title = String(note?.title ?? '').trim() || nameOf(rel);
    const type = typeof data.type === 'string' ? data.type.trim() : '';
    if (VIEWS.has(rel)) return { mtimeMs, size, title, type, chunks: [] };
    const chunks = chunkNote({ rel, title, data, body: note?.body }).map(({ id, heading, text, embedText }) => {
      const hash = digest(embedText);
      return { id, hash, heading, text, embedText, vector: known.get(hash) || null };
    });
    return { mtimeMs, size, title, type, labels: labelsOf(data), names: namesOf(rel, title, data), day: noteDay(rel, data), chunks };
  }

  /**
   * Embeds every piece without a vector, unless embedding failed under a minute ago. Says how many. Stops when
   * another vault is chosen, the scan that follows being for that one, or a refresh is asked for: a note just
   * written is then found by its words at once, and the embedding carries on after. What's done is saved every
   * SAVE_MS, so a long first embedding stopped midway starts again where it was.
   */
  async function embedMissing(notes) {
    const waiting = new Map();
    for (const note of Object.values(notes)) {
      for (const chunk of note.chunks) {
        if (chunk.vector) continue;
        if (!waiting.has(chunk.hash)) waiting.set(chunk.hash, []);
        waiting.get(chunk.hash).push(chunk);
      }
    }
    if (!waiting.size || now() - failedAt < RETRY_MS) return 0;
    const groups = [...waiting.values()];
    let done = 0;
    let savedAt = now();
    for (let at = 0; at < groups.length && !closed && !again && current()?.root === state.root; at += BATCH) {
      const batch = groups.slice(at, at + BATCH);
      try {
        const vectors = await embed(batch.map(([chunk]) => chunk.embedText), EMBED_MS);
        batch.forEach((group, i) => group.forEach((chunk) => (chunk.vector = vectors[i])));
        done += batch.length;
        succeeded();
        if (now() - savedAt >= SAVE_MS) {
          save();
          savedAt = now();
        }
      } catch (err) {
        failed(err);
        break;
      }
    }
    if (done) log(`vault index: embedded ${done} piece${done === 1 ? '' : 's'}`);
    return done;
  }

  async function scan() {
    const chosen = current();
    scanned = { root: chosen?.root ?? null, at: now() };
    if (!chosen) {
      blocked = null;
      return;
    }
    let listed;
    try {
      listed = await chosen.listNotes();
    } catch (err) {
      blocked = DENIED.has(err?.code) ? 'denied' : `can’t read the vault (${err?.code || err?.message})`;
      log('vault index: can’t read the vault:', err?.message);
      return;
    }
    blocked = null;
    const before = state.root === chosen.root ? state.notes : {};
    const known = new Map();
    for (const note of Object.values(before)) for (const chunk of note.chunks) if (chunk.vector) known.set(chunk.hash, chunk.vector);
    const notes = {};
    let changed = state.root !== chosen.root;
    for (const { rel, mtimeMs, size } of listed || []) {
      if (typeof rel !== 'string' || !/\.md$/i.test(rel) || hidden(rel)) continue;
      const was = before[rel];
      // One that couldn't be read is tried each time: an iCloud note comes back with its time and size as they were.
      if (was && !was.unreadable && was.mtimeMs === mtimeMs && was.size === size) {
        notes[rel] = was;
        continue;
      }
      if (size > MAX_NOTE_BYTES) {
        changed = true;
        log('vault index: left out', rel, `(${Math.round(size / 1e6)} MB)`);
        notes[rel] = { mtimeMs, size, title: nameOf(rel), type: '', chunks: [] };
        continue;
      }
      try {
        notes[rel] = entry(rel, await chosen.read(rel), mtimeMs, size, known);
        changed = true;
      } catch (err) {
        // Said, and the index rebuilt, once: not at every refresh while it stays unreadable.
        if (!was?.unreadable) {
          changed = true;
          log('vault index: couldn’t read', rel, err?.message);
        }
        notes[rel] = { mtimeMs, size, title: nameOf(rel), type: '', chunks: [], unreadable: true };
      }
    }
    if (Object.keys(before).some((rel) => !notes[rel])) changed = true;
    // Searchable by words straight away; by meaning as the vectors come.
    if (changed) {
      state = { root: chosen.root, updatedAt: state.updatedAt, notes };
      table = build(notes);
    }
    const embedded = await embedMissing(state.notes);
    state.updatedAt = now();
    if (changed || embedded) save();
  }

  /**
   * Brings the index up to date. One at a time: a call while one runs shares it, and it looks again once it's done.
   * With `retry` (Settings' Read again), Ollama is asked again now, not a minute after it last failed.
   * @param {{retry?:boolean}} [options]
   */
  function refresh(options) {
    if (closed) return Promise.resolve(status());
    if (options?.retry) retrying = true;
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          if (retrying) {
            retrying = false;
            // Asked even with nothing to embed, so what Settings says of it is what's so now.
            if (error && current()) await reach();
          }
          await scan();
        } while (again && !closed);
      } catch (err) {
        log('vault index: couldn’t refresh:', err.message);
      } finally {
        running = null;
      }
      const after = status();
      if (!closed) {
        try {
          onRefreshed(after);
        } catch (err) {
          log('vault index: after a refresh:', err.message);
        }
      }
      return after;
    })();
    return running;
  }

  /** A vault never scanned, or one behind (unreadable, or vectors missing) a minute after it last tried: a refresh, not waited for. */
  function catchUp() {
    const chosen = current();
    if (running || closed || !chosen) return;
    const behind = blocked !== null || state.root !== chosen.root || table.pieces.some((piece) => !piece.chunk.vector);
    const due = scanned.root !== chosen.root || (now() - scanned.at >= RETRY_MS && now() - failedAt >= RETRY_MS);
    if (behind && due) refresh();
  }

  function status() {
    const chosen = current();
    const notes = chosen && chosen.root === state.root ? Object.values(state.notes).filter((note) => note.chunks.length) : [];
    return {
      notes: notes.length,
      chunks: notes.reduce((sum, note) => sum + note.chunks.length, 0),
      mode: !chosen || blocked !== null ? 'off' : error ? 'words' : 'meaning',
      model,
      error: !chosen ? '' : (blocked ?? error),
      updatedAt: state.updatedAt || null
    };
  }

  function unwatch() {
    clearTimeout(timer);
    timer = null;
    watcher?.close();
    watcher = null;
    watched = '';
  }

  load();
  return {
    refresh,

    /**
     * The pieces that answer `query`, best first, from what's indexed now: never waits for a refresh.
     * `only` ('words' or 'meaning') and `tuning` are for vault-eval.mjs: one ranking alone, scored as it
     * scores (BM25, or the cosine), and other values for TUNING's.
     * @returns {Promise<{rel:string, title:string, type:string, heading:string, text:string, section:string, score:number, why:'meaning'|'words'|'both'}[]>}
     *   section: the whole section the piece is a part of (the piece, when it wasn't cut), one part of it at most
     */
    async search(query, { limit = 6, perNote = 2, only = '', tuning = {} } = {}) {
      const tune = { ...TUNING, ...tuning };
      const text = String(query ?? '').trim();
      catchUp();
      const chosen = current();
      if (!text || !chosen || chosen.root !== state.root || blocked !== null || !table.pieces.length) return [];
      // The index as it is now: a refresh may swap it while the question is embedded.
      const seen = table;
      const vector = only === 'words' ? null : await questionVector(text);
      if (vector) catchUp();
      const lists = [];
      // With no meaning to be had (Ollama off), the words are all there is, and a looser match is let in.
      if (only !== 'meaning') lists.push(['words', byWords(seen, text, vector || only ? tune.wordShare : tune.wordShareAlone)]);
      if (only !== 'words') lists.push(['meaning', vector ? byMeaning(seen, vector, tune.floor) : []]);
      const ranked = only ? lists[0][1].map(({ index, score }) => ({ index, score, [only]: true })) : fuse(seen, lists, text, now(), tune);
      const found = [];
      const taken = new Map();
      const sections = new Set();
      for (const { index, score, words, meaning } of ranked) {
        if (found.length >= limit) break;
        const piece = seen.pieces[index];
        if ((taken.get(piece.rel) || 0) >= perNote) continue;
        // Another part of a section already found is in its `section`: the room goes to something else.
        const { first, section } = sectionAt(seen, index);
        if (sections.has(first)) continue;
        sections.add(first);
        taken.set(piece.rel, (taken.get(piece.rel) || 0) + 1);
        found.push({
          rel: piece.rel,
          title: piece.title,
          type: piece.type,
          heading: piece.chunk.heading,
          text: piece.chunk.text,
          section,
          score: Math.round(score * 1e4) / 1e4,
          why: words && meaning ? 'both' : meaning ? 'meaning' : 'words'
        });
      }
      return found;
    },

    /** {notes, chunks, mode, model, error, updatedAt}: mode 'words' with Ollama or its model missing, 'off' with no vault or none readable. */
    status,

    /** Has Ollama load the model, so the first question isn't kept waiting for it. Never throws. */
    async warm() {
      if (closed) return;
      if (await reach()) catchUp();
    },

    /** Refreshes a moment after anything in the vault changes, but in hidden folders. Says whether it's watching. */
    watch() {
      const chosen = current();
      if (closed || !chosen) {
        unwatch();
        return false;
      }
      if (watcher && watched === chosen.root) return true;
      unwatch();
      try {
        watcher = fs.watch(chosen.root, { recursive: true }, (event, name) => {
          // Another vault chosen, or none, and watch() not asked again: this one isn't Jester's to follow any more.
          if (current()?.root !== watched) return unwatch();
          const changed = name ? String(name) : '';
          // .obsidian changes as the user clicks about; pictures and the like aren't notes.
          if (hidden(changed) || (/\.[a-z0-9]{1,8}$/i.test(changed) && !/\.md$/i.test(changed))) return;
          clearTimeout(timer);
          timer = setTimeout(() => {
            timer = null;
            refresh();
          }, WATCH_MS);
          timer.unref?.();
        });
        watcher.on?.('error', (err) => {
          log('vault index: stopped watching the vault:', err.message);
          unwatch();
        });
        watcher.unref?.();
        watched = chosen.root;
        return true;
      } catch (err) {
        log('vault index: can’t watch the vault:', err.message);
        watcher = null;
        return false;
      }
    },

    /**
     * Stops for good, for quitting: the watcher, and any embedding under way. Nothing works after it: refresh,
     * watch and warm do nothing, search finds nothing and status() says 'off'. Choosing another vault needs no
     * close(): refresh() and watch() follow whichever vault `vault()` gives.
     */
    close() {
      closed = true;
      unwatch();
      closing.abort();
    }
  };
}
