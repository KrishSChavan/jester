/**
 * Jester's memory, kept in the user's Obsidian vault (vault.js), and the rules
 * for what goes in. A conversation that's over is kept as a sentence in the
 * day's note, and the lasting things it showed about the user (who they are,
 * their people, likes and plans) as facts in About me, which they can read,
 * change or delete. Word for word, only what they ask him to remember. Before
 * he answers, what the vault holds that bears on what was just said
 * (vault-index.js) goes in front of their words, so he knows it.
 *
 * The vault is plain text files, and may be synced: nothing that looks like a
 * password, card number or key is ever written to it, nor given to the model
 * from it when the user keeps one there themselves.
 */

import { PATHS, SECTIONS } from './vault.js';

/** The most of the vault the model is given with what's said; of that, the most About me may take whole. */
export const RECALL_CHARS = 1800;
const ABOUT_CHARS = 1200;
/** One note's line of it, at most, and the least worth giving. */
const ITEM_CHARS = 420;
const ITEM_LEAST = 80;
/** Said in fewer words than this, it's searched with the user's line before: "and on Friday?". */
const SHORT_WORDS = 5;
const SEARCHED = 6;
/** Facts one conversation may add to About me, at most, and take away. */
export const MOST_FACTS = 8;
const FACT_CHARS = 200;
const SUMMARY_CHARS = 300;
const ENDED_TOKENS = 700;
/** How much of what's known, and of the conversation, the model reads to sum one up. */
const KNOWN_CHARS = 3000;
const SAID_CHARS = 8000;
const ABOUT_ME = PATHS.aboutMe;
/** Jester's own views of the vault, told by where they are: a note of the user's may have any type. */
const VIEWS = [PATHS.routines, PATHS.index, PATHS.readme];
const HEAD = 'From your memory and the user’s Obsidian notes, in case it helps:';

/** What he says when he won't keep something, or can't. */
const WHY = Object.freeze({
  secret: 'I don’t keep passwords or card numbers in your notes: they’re plain text files.',
  noVault: 'I can’t get to your Obsidian vault. Choose it, or let Jester into it, in Jester’s Settings › Memory.',
  notFound: 'I couldn’t find those exact words to keep.',
  // Asked with nothing to keep, the words are coming: conversation.js keeps the user's next line.
  what: 'Sure. What should I remember?',
  unwritten: 'I couldn’t write to your Obsidian vault.'
});

/** What the model gives back for a conversation that's over. */
export const ENDED_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    topics: { type: 'array', items: { type: 'string' } },
    people: { type: 'array', items: { type: 'string' } },
    facts: {
      type: 'object',
      properties: {
        add: {
          type: 'array',
          items: {
            type: 'object',
            properties: { section: { type: 'string', enum: [...SECTIONS] }, fact: { type: 'string' } },
            required: ['section', 'fact'],
            additionalProperties: false
          }
        },
        remove: { type: 'array', items: { type: 'string' } }
      },
      required: ['add', 'remove'],
      additionalProperties: false
    }
  },
  required: ['title', 'summary', 'topics', 'people', 'facts'],
  additionalProperties: false
});

const yours = (entry) => entry?.who === 'you' || entry?.who === 'user';
const listOf = (value) => (Array.isArray(value) ? value : []);
/** One line of text, without the comments About me hides its dates in. */
const plain = (text) => String(text ?? '').replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim();
/** A note's name, from its path. */
const nameOf = (rel) => String(rel).split('/').pop().replace(/\.md$/i, '');
const unique = (items) => items.filter((item, index) => items.findIndex((other) => other.toLowerCase() === item.toLowerCase()) === index);

/** `text` no longer than `most`, cut at a word. */
function cut(text, most) {
  if (text.length <= most) return text;
  const part = text.slice(0, most - 1);
  const space = part.lastIndexOf(' ');
  return `${space > most * 0.6 ? part.slice(0, space) : part}…`;
}

// ——— Secrets ———

/**
 * Secrets by name, and what each is called in the log. Only with what they are
 * after them ("my PIN is 4821", "password: hunter2", "my bank PIN, 4821"):
 * "change my password tomorrow" holds none. "PIN" counts in capitals, "pin"
 * only with digits: it's a verb too ("pin this tab").
 */
const CODES_FOR = String.raw`security|verification|confirmation|access|login|sign[- ]?in|auth(?:entication)?|one[- ]time|two[- ]factor|2fa|mfa|backup|recovery|reset`;
const SECRET_NAMES = [
  [/\b(?:pass(?:word|code|phrase|key)|passwd)s?\b/gi, 'a password'],
  [/\b(?:pw|pwd)\b/gi, 'a password'],
  // "pass: Blue-Moon", "pass = …": a bare "pass" is one only labelling a value, as a gym or bus pass isn't.
  [/\bpass\b(?=\s*[:=])/gi, 'a password'],
  [/\bPINs?\b/g, 'a PIN'],
  [/\bpin (?:number|code)s?\b/gi, 'a PIN'],
  [new RegExp(String.raw`\b(?:(?:${CODES_FOR})\s+(?:code|pin|key|answer)s?|cvv2?|cvc|otp)\b`, 'gi'), 'a security code'],
  [/\b(?:social security(?: number)?|ssn)s?\b/gi, 'a Social Security number'],
  [/\b(?:(?:api|secret|private|access|auth|bearer)\s+(?:key|token)|(?:seed|recovery|mnemonic)\s+phrase)s?\b/gi, 'a key']
];
/** After a secret's name, in the same sentence: "is", ":", "'s" and something; or a word with a digit in it. */
const VALUE_AFTER = /^[^.!?\n]{0,40}?(?:[:=#]|['’]s\b|\b(?:is|was|are|were)\b|\bends? (?:in|with)\b|\b(?:starts?|begins?) with\b)\s*\S/i;
const DIGITS_AFTER = /^\s+["“'‘]?[^\s"”’]*\d/;
/** Set off from its name on the same line: by a comma, a bracket, a question mark, or a dash that's no hyphen ("password-protected"). */
const SET_OFF = String.raw`(?:[^\S\n]*[,(—–?]|[^\S\n]+-)[^\S\n]*`;
/** …a word with a digit in it, set off ("my bank PIN, 4821, …", "Wifi password — hunter2"), as people say them and models write them. */
const DIGITS_SET_OFF = new RegExp(String.raw`^${SET_OFF}["“'‘]?[^\s"”’,)]*\d`);
/** …or in the sentence after: "my Netflix password? It’s tacos123." */
const NEXT_SENTENCE = /^[^\S\n]*[?.!…]?[^\S\n]*it(?:['’]s| is)[^\S\n]+\S/i;
const GIVEN = [VALUE_AFTER, DIGITS_AFTER, DIGITS_SET_OFF, NEXT_SENTENCE];
const PIN_GIVEN = /\bpin\b(?:\s+(?:is|was|number|code)|\s*[:=#,(—–-]|['’]s|\s*[?.!]?\s*it(?:['’]s| is))?\s*\d{3,}/i;
/** …or its digits one by one, soon after it: "pin is 4 8 2 1". */
const PIN_SPELT = /\bpin\b[^.!?\n]{0,20}?\d(?:[\s,-]+\d){3,}/i;
/**
 * A password needn't have a digit in it: a word set off on its own ("their Netflix password, tacos, …"), or what's in
 * quotes or brackets after its name. Not a word that carries the sentence on ("reset my password, again"), nor the
 * clause a comma most often starts ("…their password, and Jester…"): a summary of a password reset isn't a secret.
 */
const WORD_ALONE = /^(?:[^\S\n]*[,—–]|[^\S\n]+-)[^\S\n]*([^\s"“”‘’'(),;:.!?]+)[^\S\n]*(?:[,;:)—–.!?\n]|[^\S\n]-|$)/;
const IN_BRACKETS = /^[^\S\n]*\(([^()\n]{1,60})\)/;
const IN_QUOTES = /^(?:[^\S\n]*[,:(—–]|[^\S\n]+-?)[^\S\n]*["“][^"“”\n]{1,60}["”]/;
const GOES_ON = new Set(
  ('a an the it its this that these those and but or so then which who because since while though if when please thanks too also again now ' +
    'today tonight tomorrow yesterday later soon first finally already instead anyway jester ok okay yes no etc optional required once twice ' +
    'monday tuesday wednesday thursday friday saturday sunday weekend asap ' +
    'i you he she we they my your his her our their pin pins code codes key keys card cards username usernames').split(' ')
);
/** What it was set to: "changed my Netflix password to tacos", "set the bank password to Tacos123". */
const SET_TO = /^[^\S\n]+(?:to|as|into)[^\S\n]+(?:["“'‘]?[^\s"”’]*\d|["“][^"”\n]{1,60}["”]|([^\s"“”‘’'(),;:.!?]+)[^\S\n]*(?:[,;:.!?\n]|$))/i;
/** …but for what it's set to that's no password: "change my password to something", "reset it to default". */
const NOT_SET = new Set('something anything default blank expire be them him me us'.split(' '));
/** The one word after it, ending what's said: "join Lakehouse with password lakehouse". */
const LAST_WORD = /^[^\S\n]+([^\s"“”‘’'(),;:.!?]+)[^\S\n]*(?:[,;:.!?\n]|$)/;
/** …but for a word about passwords: "uses a password manager", "my Canvas password expired". */
const ABOUT_ONE = new Set(
  ('manager managers reset resets field fields box prompt prompts protected protection change changes changed changing expired expires expire ' +
    'expiring hint hints recovery requirement requirements rule rules policy page screen form entry generator app vault strength sharing autofill ' +
    'issue issues problem problems help update updates updated sign signin login logins log support settings for of').split(' ')
);

/** A word, when there is one and it's none of GOES_ON or `not`. */
function aWord(word, not) {
  const first = String(word ?? '').toLowerCase().match(/[\p{L}\p{N}]+/u)?.[0];
  return !!first && !GOES_ON.has(first) && !not?.has(first);
}

/** Whether what's after a password's name gives one GIVEN misses: a word on its own, what it was set to, or the last word. */
function wordGiven(after) {
  if (IN_QUOTES.test(after) || aWord((IN_BRACKETS.exec(after) || WORD_ALONE.exec(after))?.[1])) return true;
  const set = SET_TO.exec(after);
  if (set) return set[1] === undefined || aWord(set[1], NOT_SET);
  return aWord(LAST_WORD.exec(after)?.[1], ABOUT_ONE);
}

/** US Social Security numbers, with dashes or spaces. */
const SSN = /(?<![\d-])\d{3}([- ])\d{2}\1\d{4}(?![\d-])/;
/** Keys by their makers' prefixes (OpenAI, Groq, Google, GitHub, Slack, AWS), and signed tokens. */
const KEY_SHAPES = [
  /\bsk-[\w-]{16,}/,
  /\bgsk_[A-Za-z0-9]{16,}/,
  /\bAIza[\w-]{30,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_\w{30,}/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/
];

/** Luhn's check, which every card number passes and nine in ten other numbers fail. */
function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2) digit = digit * 2 > 9 ? digit * 2 - 9 : digit * 2;
    sum += digit;
  }
  return sum % 10 === 0;
}

const cardLike = (digits) => digits.length >= 13 && digits.length <= 19 && !/^(\d)\1+$/.test(digits) && luhn(digits);
/** Between a number's groups: spaces, or a dash or a dot with spaces round it or none; never a line's end. */
const JOIN = String.raw`(?:[^\S\n]*[-–—.][^\S\n]*|[^\S\n]+)`;
const NUMBERS = new RegExp(String.raw`(?<![\d+])\d+(?:${JOIN}\d+)*`, 'g');

/**
 * A card number: 13–19 digits passing Luhn's check, in one run or in groups of
 * 4–6 as cards print them ("4111 1111 1111 1111", Amex's "3782 822463 10005").
 * A phone number's three-digit groups, a date's two, and a run after "+" never make one.
 */
function cardIn(text) {
  for (const [run] of text.matchAll(NUMBERS)) {
    const groups = run.split(/\D+/);
    for (let start = 0; start < groups.length; start++) {
      let digits = groups[start];
      if (cardLike(digits)) return true;
      for (let end = start + 1; end < groups.length && /^\d{4,6}$/.test(groups[end - 1]) && groups[end].length <= 6 && digits.length < 19; end++) {
        digits += groups[end];
        if (cardLike(digits)) return true;
      }
    }
  }
  return false;
}

/** A card named as one, then its number however it's grouped: "my card number is 4 1 1 1 …", "41 11 11 …". */
const CARD_NAME = /\b(?:(?:master)?cards?|visa|amex)\b/gi;
const NAMED_NUMBER = new RegExp(String.raw`^[^\d\n]{0,40}?(\d(?:${JOIN}?\d){12,40})`);

function namedCardIn(text) {
  for (const match of text.matchAll(CARD_NAME)) {
    const from = match.index + match[0].length;
    const run = NAMED_NUMBER.exec(text.slice(from, from + 200))?.[1];
    let digits = '';
    for (const group of run ? run.split(/\D+/) : []) {
      digits += group;
      if (digits.length > 19) break;
      if (cardLike(digits)) return true;
    }
  }
  return false;
}

/** A key: a maker's prefix, or 32 or more letters and digits mixed (hex, base64), between a path's slashes or a slug's dashes. */
const keyIn = (text) =>
  KEY_SHAPES.some((shape) => shape.test(text)) || (text.match(/[A-Za-z0-9+_=]{32,}/g) || []).some((run) => /\d/.test(run) && /[A-Za-z]/.test(run));

function named(text) {
  for (const [name, kind] of SECRET_NAMES) {
    for (const match of text.matchAll(name)) {
      const after = text.slice(match.index + match[0].length);
      if (GIVEN.some((given) => given.test(after)) || (kind === 'a password' && wordGiven(after))) return kind;
    }
  }
  return PIN_GIVEN.test(text) || PIN_SPELT.test(text) ? 'a PIN' : '';
}

/**
 * Whether `text` holds what must never go in a plain-text note.
 * @returns {string} '' or what it holds: 'a card number', 'a password'…
 */
export function secretIn(text) {
  const said = String(text ?? '');
  if (!said.trim()) return '';
  if (cardIn(said) || namedCardIn(said)) return 'a card number';
  if (SSN.test(said)) return 'a Social Security number';
  if (keyIn(said)) return 'an API key';
  return named(said);
}

// ——— Word for word ———

/** Characters that read the same: curly quotes and straight, dashes and hyphens. */
const SAME_AS = {
  ...Object.fromEntries([...'‘’‚‛′`´'].map((quote) => [quote, "'"])),
  ...Object.fromEntries([...'“”„‟″'].map((quote) => [quote, '"'])),
  ...Object.fromEntries([...'‐‑‒–—―'].map((dash) => [dash, '-'])),
  '…': '...'
};
/** What may stand round the words without being part of them. */
const ROUND = new Set('"\'“”‘’.,;:!?()[]{}<>«»*_~…–—-');
const WORDY = /[\p{L}\p{N}]/u;
/** The asking says "this": "remember this", "keep this in mind". */
const THIS = /\bthis\b/i;
/**
 * A question, asked with or without its question mark (speech has none): a wh-word; "is", "are", "am", "does" or
 * "can" first, which little that's said starts with ("is Pluto a planet"); or another verb before who it's asked of.
 * "May is my new lab partner", "Will lands at 6:40" and "Have to pick up Sam" are things said.
 */
const QUESTION = new RegExp(
  String.raw`\?["'”’)\s]*$|^(?:(?:hey|ok|okay|so|and|um|uh|jester)[\s,]+)*(?:(?:what|who|whom|whose|when|where|why|how|which)\b|` +
    String.raw`(?:is|are|am|does|can)\s+\w|(?:was|were|do|did|could|will|would|should|may|might|has|have|had)\s+` +
    String.raw`(?:i|you|we|they|he|she|it|there|my|your|our|their|his|her|the|this|that|these|those|anyone|anything|someone|somebody)\b)`,
  'i'
);
/** A word of a name or a fact, with the + and # that make C++ and C# other than C. */
const NAME_WORD = /[\p{L}\p{N}][\p{L}\p{N}+#]*/gu;
/** Asking him to remember, and what may come round it. Not "save this": "save this page as a PDF" asks no such thing. */
const ASK = String.raw`(?:remember|memori[sz]e|don['’]?t forget|do not forget|never forget|keep (?:(?:this|that|it) )?in mind)`;
const LEAD_IN = String.raw`(?:hey|ok|okay|so|and|also|oh|jester|please|just|(?:can|could|would|will) you|i (?:want|need) you to|make sure(?: you| to)?)`;
const TAIL = String.raw`(?:please|jester|okay|ok|for me|thanks|thank you)`;
/** Their "yes", or his "Got it.": neither is anything to keep. Never "ok", which LEAD_IN has: two ways to read one word is slow. */
const AGREE = String.raw`sure(?: thing)?|got it|on it|done|alright|all right|cool|nice|great|perfect|awesome|noted|will do|yes|yeah|yep|yup|right|of course|sounds good`;
/**
 * Their "no" to what he offered, or a word that turns from it: "No, just remember that" asks for what came before.
 * "No thanks" is "no", then "thanks": one word, one way to read it.
 */
const DECLINE = String.raw`no|nope|nah|not now|actually|instead`;
const ASKING = new RegExp(ASK, 'gi');
/** "Jester, remember that …", "yes, remember that …", "don’t forget …", "remember this: …". */
const ASKED_FIRST = new RegExp(String.raw`^\W*(?:(?:${LEAD_IN}|${AGREE}|${DECLINE}|thanks|thank you)\W+)*${ASK}(?:\s+(?:that|this))?(?:\s*[:,-]|\b)\s*`, 'i');
/** "…, remember that.", "…, don’t forget it, please." */
const ASKED_LAST = new RegExp(String.raw`[\s,;:.!-]*\b(?:${LEAD_IN}\W+)*${ASK}(?:\s+(?:that|this|it))?(?:\W+${TAIL})*\W*$`, 'i');
const TAILING = new RegExp(String.raw`(?:[\s,]+${TAIL})+\W*$`, 'i');
/** What holds nothing to keep: their "yes", "no" or "ok, just", a lone "it", his "Got it, I’ll remember that." */
const NOTHING = new RegExp(
  String.raw`^\W*(?:(?:ok(?:ay)?|${AGREE}|${DECLINE}|please|jester|for me|thanks|thank you|just|it|this|that|hm+|um+|uh+|i(?:['’]ll| will) remember)\W*)*$`,
  'i'
);
/** His question, or his offer to remember, at the end of what he said: "Want me to remember that?" */
const OFFER = /\?\W*$|\b(?:remember|forget)\b|\bkeep (?:that|this|it) in mind\b/i;

/**
 * `text` without the spaces and punctuation round it, but for a quote its words
 * open or close: “Sam’s birthday” is Sam’s birthday; ünïcödé "TEST" keeps both.
 */
function trimmed(text) {
  const round = (char) => ROUND.has(char) || /\s/u.test(char);
  let start = 0;
  let end = text.length;
  while (start < end && round(text[start])) start += 1;
  while (end > start && round(text[end - 1])) end -= 1;
  if ((text.slice(start, end).match(/["“”]/g) || []).length % 2) {
    if (/["”]/.test(text[end] ?? '')) end += 1;
    else if (/["“]/.test(text[start - 1] ?? '')) start -= 1;
  }
  return text.slice(start, end);
}

/**
 * `pattern`, which ends at the end, run on the end of `text` from a little before
 * `near`: tried all along a long line, it takes seconds.
 */
function cutAtEnd(text, pattern, near = text.length) {
  const space = near > 80 ? text.lastIndexOf(' ', near - 80) : 0;
  const from = space > 0 ? space : Math.max(0, near - 80);
  return text.slice(0, from) + text.slice(from).replace(pattern, '');
}

/**
 * `text` as compared: case, quotes, dashes and runs of spaces don't count.
 * from[i] and to[i]: where folded character i came from in `text`.
 */
function folded(text) {
  let out = '';
  const from = [];
  const to = [];
  let at = 0;
  for (const char of String(text)) {
    const next = at + char.length;
    const piece = /\s/u.test(char) ? (out && !out.endsWith(' ') ? ' ' : '') : (SAME_AS[char] ?? char).toLowerCase();
    for (let i = 0; i < piece.length; i++) {
      from.push(at);
      to.push(next);
    }
    out += piece;
    at = next;
  }
  if (out.endsWith(' ')) {
    out = out.slice(0, -1);
    from.pop();
    to.pop();
  }
  return { out, from, to };
}

/** Where `needle` is in `hay` as whole words ("locker combo" isn't in "locker combination"), or -1. */
function wordsAt(hay, needle) {
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
    const cutBefore = WORDY.test(needle[0]) && WORDY.test(hay[at - 1] ?? '');
    const cutAfter = WORDY.test(needle.at(-1)) && WORDY.test(hay[at + needle.length] ?? '');
    if (!cutBefore && !cutAfter) return at;
  }
  return -1;
}

/** A line without asking to remember it: whether it asked, and the rest. */
function unasked(line) {
  const first = line.replace(ASKED_FIRST, '');
  // Only the last "remember" can be the one at the end.
  const asks = [...first.matchAll(ASKING)];
  const last = asks.length ? cutAtEnd(first, ASKED_LAST, asks.at(-1).index) : first;
  const asked = last !== line;
  const rest = trimmed(asked ? cutAtEnd(last, TAILING) : last);
  return { asked, rest: NOTHING.test(rest) ? '' : rest };
}

/** What he said, without the question or offer he ended on: "It’s Canberra. Want me to remember that?" is "It’s Canberra." */
function answerOf(text) {
  const sentences = String(text).match(/[^.!?…]+(?:[.!?…]+|$)/g) || [];
  while (sentences.length && OFFER.test(sentences.at(-1))) sentences.pop();
  return sentences.join('').trim();
}

/**
 * What a line before a bare "remember that" has to keep: the user's words, but for a "yes" or an asking with
 * nothing in it; his answer, but for a "Got it." and whatever he asked or offered after it.
 */
function keepable(line) {
  if (yours(line)) {
    const { asked, rest } = unasked(line.text);
    return asked ? rest : NOTHING.test(line.text) ? '' : line.text.trim();
  }
  const answer = answerOf(line.text);
  return NOTHING.test(answer) ? '' : answer;
}

/**
 * The words to keep, exactly as said. The model's copy of them, `text`, found
 * in one line of the conversation (case, spacing, curly or straight quotes and
 * the punctuation round it aside), as that line has them; failing that, the
 * user's latest line without its "remember that"; when that's all it was, the
 * line before it, past any "yes" of theirs and any "Got it." or "Want me to
 * remember that?" of his. '' when none of that holds: the model's own wording,
 * a "yes" and his question are never kept as the user's.
 * @param {string} text  the model's copy
 * @param {{who:'you'|'jester', text:string}[]} transcript  oldest first, the user's latest line last
 * @returns {string}
 */
export function verbatim(text, transcript) {
  const lines = listOf(transcript).filter((line) => typeof line?.text === 'string' && line.text.trim());
  const latest = lines.findLastIndex(yours);
  const needle = trimmed(folded(text ?? '').out);
  if (WORDY.test(needle) && unasked(needle).rest && !/^(?:this|that|it)$/.test(needle)) {
    // The user's latest line first, then theirs before it, then his: his answers, not what he asked.
    const rank = (index) => (index === latest ? 2 : yours(lines[index]) ? 1 : 0);
    const order = lines.map((line, index) => index).reverse().sort((a, b) => rank(b) - rank(a));
    // A bare "remember this" isn't his answer, whatever the model copied (below).
    const ahead = latest >= 0 && THIS.test(lines[latest].text) && !unasked(lines[latest].text).rest;
    for (const index of order) {
      if (ahead && !yours(lines[index])) continue;
      const line = yours(lines[index]) ? lines[index].text : answerOf(lines[index].text);
      const hay = folded(line);
      const at = wordsAt(hay.out, needle);
      if (at < 0) continue;
      const found = unasked(line.slice(hay.from[at], hay.to[at + needle.length - 1])).rest;
      if (found) return found;
    }
  }
  if (latest < 0) return '';
  const { asked, rest } = unasked(lines[latest].text);
  if (!asked) return '';
  if (rest) return rest;
  const before = lines.slice(0, latest).reverse();
  // "Remember this" points back only to what they said: after his answer, it's what they're about to say (measured:
  // after "and when do I have to pay it", "remember this" kept his rent answer, and the spare key said next was lost).
  const his = THIS.test(lines[latest].text) ? () => '' : (words) => words;
  for (const [at, line] of before.entries()) {
    const words = keepable(line);
    if (!words) continue;
    if (yours(line)) return words;
    // His reply to what they told him ("Good to know: March 3rd.") isn't "that": what they told him is. His answer to
    // their question is.
    for (const earlier of before.slice(at + 1)) {
      if (!yours(earlier)) continue;
      const theirs = keepable(earlier);
      if (!theirs) continue;
      return QUESTION.test(theirs) ? his(words) : theirs;
    }
    return his(words);
  }
  return '';
}

/** Whether the user's latest line only asks him to remember, with nothing in it to keep: "remember this". */
function onlyAsked(transcript) {
  const latest = listOf(transcript).findLast((line) => yours(line) && typeof line.text === 'string' && line.text.trim());
  if (!latest) return false;
  const { asked, rest } = unasked(latest.text);
  return asked && !rest;
}

// ——— Recall ———

/** Said of what was just talked about: "and when do I have to pay it", "what room is that in again". */
const POINTS_BACK = /^(?:and|so|what about|how about)\b|\b(?:it|that|this|there|them|him|her|those|these|one)\b/i;

/**
 * What's searched for: what was said, with the user's line before when it's short ("and on Friday?") or points
 * back to it. What he read for that line isn't in the conversation, so it's found again. The days it names
 * ("yesterday") are vault-index.js's to work out.
 */
function queryFor(said, history) {
  if (said.split(' ').length >= SHORT_WORDS && !POINTS_BACK.test(said)) return said;
  const theirs = listOf(history).filter((entry) => yours(entry) && String(entry.text ?? '').trim());
  // Given with what's being said already at its end, that's not the line before.
  if (theirs.length && theirs.at(-1) === listOf(history).at(-1) && plain(theirs.at(-1).text) === said) theirs.pop();
  return theirs.length ? `${plain(theirs.at(-1).text)} ${said}` : said;
}

/** A note's day, from the date its name starts with: "Monday, November 9". */
function dayOf(rel, date, weekday) {
  const match = /(\d{4})-(\d{2})-(\d{2})/.exec(nameOf(rel));
  if (!match) return '';
  const day = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const year = day.getFullYear() === date.getFullYear() ? {} : { year: 'numeric' };
  return day.toLocaleDateString('en-US', { ...(weekday ? { weekday: 'long' } : {}), month: 'long', day: 'numeric', ...year });
}

/** A part of a note as one line: no headings, and its lines run together ("- eggs - milk"). */
const flat = (text) => plain(String(text ?? '').replace(/^#{1,6}\s.*$/gm, ''));
/** The facts in a part of About me: its bullets. */
const bullets = (text) =>
  String(text ?? '')
    .split('\n')
    .map((line) => plain(/^\s*[-*]\s+(.+)$/.exec(line)?.[1]).replace(/\.$/, ''))
    .filter(Boolean);

/** Something found, by kind, told by where it is: what it is ("- Note “Grocery list” (Notes)") and what it says, as one line. */
function itemParts(hit, date) {
  const rel = String(hit.rel);
  if (rel.startsWith(`${PATHS.conversations}/`)) {
    const summary = flat(/^\s*Summary:\s*(.+)$/im.exec(hit.text ?? '')?.[1] ?? hit.text);
    const time = /\d{1,2}:\d{2}\s*[AP]M/i.exec(hit.heading ?? '')?.[0].replace(/\s+/, ' ');
    const day = dayOf(rel, date, true);
    return { label: `- Conversation${day ? ` on ${day}` : ''}${time ? ` at ${time}` : ''}`, says: summary };
  }
  if (rel.startsWith(`${PATHS.remembered}/`)) {
    // The words as they were said are the quote; the line after it only says when.
    const lines = String(hit.text ?? '').split('\n');
    const quoted = lines.filter((line) => /^\s*>/.test(line)).map((line) => line.replace(/^\s*>\s?/, '').trim()).filter(Boolean);
    const words = quoted.length ? quoted.join(' / ') : flat(lines.filter((line) => !/^Said to Jester on /i.test(line)).join('\n'));
    const day = dayOf(rel, date, false);
    return { label: `- Remembered word for word${day ? ` on ${day}` : ''}`, says: words && `“${words}”` };
  }
  const title = plain(hit.title) || nameOf(rel);
  const heading = plain(hit.heading).split(' › ').filter((part) => part && part !== title).join(' › ');
  // Its folder, which may be all that tells School/PHYS 212/Syllabus from School/STAT 318/Syllabus.
  const folder = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  return { label: `- Note “${title}”${folder ? ` (${folder})` : ''}${heading ? ` › ${heading}` : ''}`, says: flat(hit.text), theirs: true };
}

/** A secret's name ending a line, for the line after it to give: "Debit PIN", then "4821"; "wifi password", then "sunflower". */
const NAME_ENDS = [
  [/\b(?:pass(?:word|code|phrase)|passwd|pw|pwd)s?\W*$/i, 'a password'],
  [/\bpins?\W*$/i, 'a PIN'],
  [/\bcodes?\W*$/i, 'a security code']
];
/** The line of dashes under a table's first row. */
const DIVIDER = /^(?=.*\|)[\s|:-]*-[\s|:-]*$/;
/** A table's column for secrets, by a name SECRET_NAMES knows ("Password", "PIN") or a short one. */
const COLUMNS = [
  [/^pass$/i, 'a password'],
  [/^pins?$/i, 'a PIN'],
  [/^(?:secrets?|tokens?)$/i, 'a key']
];

/** The secret a line names, given or not: "Change the wifi password" names one. */
const namedIn = (line) => SECRET_NAMES.find(([name]) => line.search(name) >= 0)?.[1] || '';

/** What a table's first row says a column of it holds: '' or 'a password'… */
function columnsHold(row) {
  for (const cell of row.split('|').map((each) => plain(each).replace(/[*_`]/g, ''))) {
    const kind = namedIn(cell) || COLUMNS.find(([name]) => name.test(cell))?.[1];
    if (kind) return kind;
  }
  return '';
}

/** What any table in a note holds, by its first row: '' or 'a password'… */
function tablesHold(text) {
  const lines = String(text ?? '').split('\n');
  for (const [at, line] of lines.entries()) {
    const kind = line.includes('|') && !DIVIDER.test(line) && DIVIDER.test(lines[at + 1] ?? '') ? columnsHold(line) : '';
    if (kind) return kind;
  }
  return '';
}

/**
 * A note of the user's, line by line, without what holds a secret or names one: such a line ("pw: hunter2", "Change
 * the wifi password"), the line a name ends for ("Debit PIN", then "4821"), and every row of a table with a column
 * for one. What's left goes to the model, which may be a cloud's: a line lost is cheap.
 * @param {() => string} [whole]  the whole note, for a piece of it that starts partway down a table
 * @returns {{lines:string[], kind:string}}  the lines kept, and what the first left out held ('' for none)
 */
function unsecret(text, whole = () => '') {
  const lines = String(text ?? '').split('\n');
  const kept = [];
  let kind = '';
  // vault-index.js cuts a long table between its rows, so a piece may start with rows and no first row to tell what
  // they hold: the note's tables tell. It joins a short last part on after a blank line, so only words end a table.
  let table = lines[0].includes('|') && !DIVIDER.test(lines[1] ?? '') ? tablesHold(whole()) : '';
  let next = '';
  for (const [at, line] of lines.entries()) {
    if (line.trim() && !line.includes('|')) table = '';
    else if (!table && line.includes('|') && DIVIDER.test(lines[at + 1] ?? '') && !DIVIDER.test(line)) table = columnsHold(line);
    const held = table || secretIn(line) || namedIn(line) || (line.trim() ? next : '');
    if (line.trim()) next = NAME_ENDS.find(([name]) => name.test(line))?.[1] || '';
    if (held) kind ||= held;
    else kept.push(line);
  }
  return { lines: kept, kind };
}

/** Words any question has, which say nothing of what it's about. */
const ASKING_WORDS = new Set(
  ('what when where who whom whose why how which are was were does did can could would should will have has had the and for from with about ' +
    'you your yours mine our their them this that these those there here its tell know need want get got just please jester hey okay any some').split(' ')
);

/** The words a line may share with what was asked: none of ASKING_WORDS, and plurals made single. */
const wordsOf = (text) =>
  new Set(
    (plain(text).toLowerCase().replace(/['’]/g, '').match(/[\p{L}\p{N}]+/gu) || [])
      .filter((word) => (word.length > 2 || /\d/.test(word)) && !ASKING_WORDS.has(word))
      .map(singular)
  );

/**
 * A note's lines as one, in `room`. When they don't all fit, the lines that share the most of `asked`'s words go, in
 * their order, with "…" where lines are skipped: a long schedule is found by its Thursday, and its first characters
 * may stop at Wednesday.
 */
function linesFor(lines, room, asked) {
  const all = flat(lines.join('\n'));
  if (all.length <= room || !asked.size) return cut(all, room);
  const scored = lines
    .map(flat)
    .filter(Boolean)
    .map((line, at) => ({ at, line, shares: [...wordsOf(line)].filter((word) => asked.has(word)).length }));
  if (!scored.some(({ shares }) => shares)) return cut(all, room);
  const taken = [];
  let length = 0;
  for (const each of [...scored].sort((a, b) => b.shares - a.shares || a.at - b.at)) {
    if (taken.length && length + each.line.length + 3 > room) continue;
    taken.push(each);
    length += each.line.length + 3;
  }
  taken.sort((a, b) => a.at - b.at);
  return cut(taken.map(({ at, line }, i) => (at > (i ? taken[i - 1].at + 1 : 0) ? `… ${line}` : line)).join(' '), room);
}

/**
 * Something found, as a line of what he's given, at most `fits` long: each kind in its own words. A password, PIN
 * or card number the user keeps in a note goes no further than the vault (the model may be a cloud's, and he talks
 * out loud): the note's lines that hold or name one are left out, or all of it is. `leftOut(rel, kind)` hears of it.
 * @param {Set<string>} asked  the words of what was asked (wordsOf), which a long note's lines are chosen by
 * @param {(rel:string) => string} textOf  a note's whole text, '' when it can't be read
 */
function itemLine(hit, date, fits, asked, leftOut, textOf) {
  const { label, says, theirs } = itemParts(hit, date);
  if (!says) return '';
  if (!theirs) {
    const secret = secretIn(`${label}: ${says}`);
    if (!secret) return cut(`${label}: ${says}`, fits);
    leftOut(String(hit.rel), secret);
    return secretIn(label) ? '' : cut(`${label}: (left out, as it may hold ${secret})`, fits);
  }
  // The whole section the piece was cut from (vault-index.js), so the lines that answer are there to choose.
  const { lines, kind } = unsecret(hit.section || hit.text, () => textOf(String(hit.rel)));
  const head = kind ? `${label} (${kind} left out)` : label;
  // What's given is looked at whole, with its name: "Bank PIN", then "4821" alone, is a PIN.
  const body = linesFor(lines, Math.max(fits - head.length - 2, ITEM_LEAST / 2), asked);
  const hidden = body && secretIn(`${label}: ${body}`);
  const secret = hidden || kind;
  if (secret) leftOut(String(hit.rel), secret);
  if (body && !hidden) return cut(`${head}: ${body}`, fits);
  return !secret || secretIn(label) ? '' : cut(`${label}: (left out, as it may hold ${secret})`, fits);
}

/**
 * About me, then what was found, in brackets and kept to RECALL_CHARS; nothing secret, which `leftOut(rel, kind)`
 * hears of. About me and Jester's views of the vault are told by where they are, never by a note's type.
 */
function recalled(facts, hits, date, asked, leftOut = () => undefined, textOf = () => '') {
  const told = (rel) => (fact) => {
    const secret = secretIn(fact);
    if (secret) leftOut(rel, secret);
    return !secret;
  };
  const known = facts.filter(told(ABOUT_ME));
  const used = [];
  const whole = known.length > 0 && known.join('; ').length <= ABOUT_CHARS;
  const about = whole ? [...known] : [];
  if (whole) used.push({ rel: ABOUT_ME, heading: 'About me' });
  const found = [];
  for (const hit of listOf(hits)) {
    if (!hit?.rel || VIEWS.includes(hit.rel)) continue;
    if (hit.rel !== ABOUT_ME) found.push(hit);
    else if (!whole) {
      // Too much of About me to give it all: the parts of it that came back.
      const more = bullets(hit.text).filter(told(hit.rel));
      if (more.length) used.push({ rel: hit.rel, heading: hit.heading ?? '' });
      about.push(...more);
    }
  }
  const lines = about.length ? [cut(`About the user: ${unique(about).join('; ')}`, ABOUT_CHARS + 16)] : [];
  let room = RECALL_CHARS - HEAD.length - 2 - lines.reduce((sum, line) => sum + line.length + 1, 0);
  for (const hit of found) {
    const fits = Math.min(ITEM_CHARS, room - 1);
    if (fits < ITEM_LEAST) break;
    const line = itemLine(hit, date, fits, asked, leftOut, textOf);
    if (!line) continue;
    lines.push(line);
    used.push({ rel: hit.rel, heading: hit.heading ?? '' });
    room -= line.length + 1;
  }
  return lines.length ? { block: `[${HEAD}\n${lines.join('\n')}]`, used } : { block: '', used: [] };
}

// ——— A conversation that's over ———

const NOT_PEOPLE = new Set(['jester', 'user', 'the user', 'me', 'myself', 'you', 'i', 'none', 'nobody', 'no one', 'assistant', 'the assistant']);
/** What Jester did, or a one-off request, which About me isn't for. */
const NOT_A_FACT = /^(?:jester|the assistant|asked|requested|wanted (?:jester|you) to)\b/i;
const LEADING = /^(?:(?:so|and|also|oh|ok|okay|well|um|uh|that)\b[\s,]*)+/i;
const SMALL = new Set(['a', 'an', 'and', 'are', 'at', 'by', 'for', 'from', 'in', 'is', 'my', 'of', 'on', 'or', 'our', 'the', 'to', 'was', 'were', 'with']);
const NOT_SUBJECT = /^(?:it|this|that|there|here|he|she|they|we|i|you|which|what)$/i;

/** A title for words: their subject ("my locker combination is …" is "Locker combination"), or their first few words. */
function titleFor(words) {
  const line = trimmed(plain(String(words ?? '').split('\n')[0]).replace(LEADING, ''));
  const subject = (/^(?:(?:my|our|the)\s+)?(.+?)\s+(?:is|are|was|were)\s+\S/i.exec(line) || /^(?:(?:my|our|the)\s+)?(.+?)['’]s\s+\S/i.exec(line))?.[1];
  const taken = (subject && !NOT_SUBJECT.test(subject) && subject.split(' ').length <= 5 ? subject : line).split(' ').slice(0, 6);
  while (taken.length > 1 && SMALL.has(taken.at(-1).toLowerCase())) taken.pop();
  const title = trimmed(taken.join(' ').slice(0, 60));
  return title ? title[0].toUpperCase() + title.slice(1) : '';
}

const topicsOf = (title) => unique((title.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).filter((word) => !SMALL.has(word))).slice(0, 3);
/** Facts compared as About me compares them: case, spacing and punctuation don't count, but + and # do (C, C++, C#). */
const factKey = (text) => (plain(text).toLowerCase().match(NAME_WORD) || []).join(' ');
const sectionOf = (name) => SECTIONS.find((section) => section.toLowerCase() === plain(name).toLowerCase()) || 'Other';

/** A fact as About me keeps it: one line, without "The user" or a full stop. */
function factOf(text) {
  const fact = plain(text).replace(/^[-*•]\s*/, '').replace(/^(?:the )?user(?:['’]s)?\s+/i, '').replace(/\.$/, '');
  return fact ? fact[0].toUpperCase() + fact.slice(1) : '';
}

/** A fact named for removal as the model may copy it: with a bullet, or its section in front. */
function withoutSection(text) {
  let fact = plain(text).replace(/^[-*•]\s*/, '').replace(/^\[[^\]]*\]\s*/, '');
  const section = SECTIONS.find((name) => fact.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  if (section) fact = fact.slice(section.length + 1);
  return fact;
}

/** At most six words and 60 characters, as a title is. */
const headline = (text) => trimmed(trimmed(plain(text)).split(' ').slice(0, 6).join(' ').slice(0, 60));
const strings = (value) => listOf(value).filter((item) => typeof item === 'string');

/** The model's account of a conversation, checked: anything not as asked, too long, or secret is left out. */
function checked(json, known, entries, log) {
  const summary = typeof json?.summary === 'string' ? cut(plain(json.summary), SUMMARY_CHARS) : '';
  if (!summary) throw new Error('The model didn’t sum up the conversation.');
  let title = (typeof json.title === 'string' && headline(json.title)) || titleFor(entries.find(yours)?.text) || 'A conversation';
  if (secretIn(title)) title = 'A conversation';
  const secret = secretIn(summary);
  if (secret) log('memory: left a summary out, as it held', secret);
  const topics = strings(json.topics)
    .map((topic) => trimmed(plain(topic).toLowerCase().replace(/^#+/, '')))
    .filter((topic) => topic && topic.length <= 40 && !secretIn(topic));
  const people = strings(json.people)
    .map((name) => trimmed(plain(name)))
    .filter((name) => name && name.length <= 60 && WORDY.test(name) && !NOT_PEOPLE.has(name.toLowerCase()) && !secretIn(name));

  const keys = new Set(known.map((item) => factKey(item.fact)));
  const add = [];
  for (const item of listOf(json.facts?.add)) {
    if (add.length >= MOST_FACTS) break;
    const fact = typeof item?.fact === 'string' ? factOf(item.fact) : '';
    const key = factKey(fact);
    const hidden = secretIn(fact);
    if (hidden) log('memory: left a fact out, as it held', hidden);
    if (!key || hidden || fact.length > FACT_CHARS || keys.has(key) || NOT_A_FACT.test(fact)) continue;
    keys.add(key);
    add.push({ section: sectionOf(item.section), fact });
  }
  // Only facts About me has, as it has them; never one the model also wants kept.
  const byKey = new Map(known.map((item) => [factKey(item.fact), item.fact]));
  const wanted = new Set(listOf(json.facts?.add).map((item) => factKey(typeof item?.fact === 'string' ? factOf(item.fact) : '')));
  const remove = [];
  for (const item of strings(json.facts?.remove)) {
    const fact = byKey.get(factKey(withoutSection(item)));
    if (fact && !remove.includes(fact) && !wanted.has(factKey(fact)) && remove.length < MOST_FACTS) remove.push(fact);
  }
  return {
    title,
    summary: secret ? `${title}. The details are left out, as they held ${secret}.` : summary,
    topics: unique(topics).slice(0, 6),
    people: unique(people).slice(0, 8),
    add,
    remove
  };
}

const longDate = (date) => date.toLocaleDateString('en-US', { dateStyle: 'full' });
/** 1:05 PM, spelled out as vault.js does: the space Intl puts before "PM" differs between versions. */
const clock = (date) => `${date.getHours() % 12 || 12}:${String(date.getMinutes()).padStart(2, '0')} ${date.getHours() < 12 ? 'AM' : 'PM'}`;

/** What the model's told, to sum up a conversation: its day, and what Jester knows already. */
function endedPrompt(date, known) {
  const day = longDate(date);
  const friday = new Date(date);
  friday.setDate(date.getDate() + ((12 - date.getDay()) % 7 || 7));
  const bySection = new Map();
  for (const { section, fact } of known) bySection.set(section, [...(bySection.get(section) || []), plain(fact)]);
  const listed = cut([...bySection].map(([section, facts]) => `${section}:\n${facts.map((fact) => `- ${fact}`).join('\n')}`).join('\n'), KNOWN_CHARS);
  return [
    `You keep the memory of Jester, a voice assistant. The conversation below, between the user and Jester, is over. It began on ${day} at ${clock(date)}.`,
    'Reply with JSON: {"title":"…","summary":"…","topics":["…"],"people":["…"],"facts":{"add":[{"section":"…","fact":"…"}],"remove":["…"]}}',
    '"title": what it was about, in at most 6 words, like "Opening PSU Canvas".',
    '"summary": one sentence of at most 30 words. Keep names, plans and decisions, but never a password, PIN, code, card number or key. ' +
      'Call the user "the user" or "they": never "he" or "she".',
    '"topics": one to four lowercase words or short phrases, like "canvas" or "school".',
    '"people": the names of the people the user talked about. Never Jester or the user.',
    '"facts" "add": only lasting things the user said about themselves, the people in their life, their preferences, routines and plans. ' +
      'Each is one short sentence that leaves out "the user", like "Takes CMPSC 465 at Penn State" or "Roommate is Sam Lee".',
    `Make dates absolute: "Friday", said on ${day}, is ${longDate(friday)}.`,
    'Never what Jester did, never a one-off request ("asked to open Canvas" is not a fact), never what was so only that day ' +
      '("parked on level 3" is not a fact: what they asked to be remembered is kept elsewhere), never a guess, never a password, PIN, code, card number or key.',
    `"section" is one of: ${SECTIONS.join(', ')}. Most conversations have no new facts: then "add" is [].`,
    '"facts" "remove": facts listed below, copied exactly, that this conversation shows are wrong or out of date. Usually [].',
    `What Jester knows about the user already (never add these again):\n${listed || 'Nothing yet.'}`
  ].join('\n');
}

/** The conversation as the model reads it: the latest of it, when it's long. */
function transcriptOf(entries) {
  const lines = entries.map((entry) => `${yours(entry) ? 'User' : 'Jester'}: ${cut(plain(entry.text), 1500)}`);
  const kept = [];
  let total = 0;
  for (const line of lines.reverse()) {
    if (kept.length && total + line.length > SAID_CHARS) break;
    kept.unshift(line);
    total += line.length + 1;
  }
  return [...(kept.length < lines.length ? ['(Earlier lines left out.)'] : []), ...kept].join('\n');
}

/** When it began: its first line's time. */
function startOf(entries, now) {
  const at = entries[0]?.at;
  const ms = typeof at === 'number' ? at : Date.parse(at);
  return Number.isFinite(ms) ? ms : now();
}

// ——— Notes ———

const NAME_FILLER = new Set(['my', 'the', 'a', 'an', 'note', 'notes', 'list', 'lists']);

function singular(word) {
  if (word.length > 3 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  return word.length > 3 && /[^s]s$/.test(word) ? word.slice(0, -1) : word;
}

/** A note's name as asked for: "my groceries" and "Grocery list" ask for the same one, "C++ notes" and "C notes" don't. */
function nameKey(name) {
  const words = (String(name).toLowerCase().match(NAME_WORD) || []).filter((word) => !NAME_FILLER.has(word));
  return [...new Set(words.map(singular))].sort().join(' ');
}

/**
 * @param {object} deps
 * @param {() => object|null} deps.vault  the vault chosen in Settings (vault.js), or null
 * @param {{search:Function, refresh:Function}} [deps.index]  vault-index.js
 * @param {(request:{system:string, prompt:string, schema:object, maxOutputTokens:number}) => Promise<{json:any}>} deps.request  the talking job (model-jobs.js)
 * @param {() => number} [deps.now]
 * @param {(...parts:any[]) => void} [deps.log]
 * @param {(url:string) => Promise<void>} [deps.openExternal]  Electron's shell.openExternal
 * @param {() => boolean} [deps.keepConversations]  Settings: conversations kept in the vault
 */
export function createVaultMemory({
  vault: chosen,
  index,
  request,
  now = Date.now,
  log = () => undefined,
  openExternal = async () => undefined,
  keepConversations = () => true
}) {
  function current() {
    try {
      return chosen?.() || null;
    } catch (err) {
      log('memory: no vault:', err.message);
      return null;
    }
  }

  /** What recall leaves out as secret, logged once a note and kind: it's left out each time it's found. */
  const warned = new Set();
  function leftOut(rel, kind) {
    if (warned.has(`${rel}\n${kind}`)) return;
    warned.add(`${rel}\n${kind}`);
    log('memory: kept from the model, as it holds', `${kind}:`, rel);
  }

  /** What's written is found next time: the index catches up, while he gets on. */
  function refreshSoon() {
    try {
      Promise.resolve(index?.refresh?.()).catch((err) => log('memory: couldn’t refresh the index:', err.message));
    } catch (err) {
      log('memory: couldn’t refresh the index:', err.message);
    }
  }

  /** The one note whose name has the same words ("groceries", "Grocery list"), or null: two that do is none. */
  function lookalike(vault, title, where = () => true) {
    const key = nameKey(title);
    if (!key) return null;
    try {
      const same = listOf(vault.listNotes()).filter((note) => where(note.rel) && nameKey(nameOf(note.rel)) === key);
      return same.length === 1 ? same[0].rel : null;
    } catch (err) {
      log('memory: couldn’t list the notes:', err.message);
      return null;
    }
  }

  /** A note's title as the vault has it. */
  function titleOf(vault, rel) {
    try {
      return plain(vault.read(rel)?.title) || nameOf(rel);
    } catch {
      return nameOf(rel);
    }
  }

  /** A name that finds the note at `rel` again, as addToNote() looks it up: its title may be another note's file name. '' for none. */
  async function nameFor(vault, rel) {
    for (const name of unique([nameOf(rel), titleOf(vault, rel)])) {
      try {
        if ((await vault.findNote(name))?.rel === rel) return name;
      } catch (err) {
        log('memory: couldn’t look for a note:', err.message);
      }
    }
    return '';
  }

  async function opened(vault, rel) {
    try {
      await openExternal(vault.openUrl(rel));
      return { ok: true, text: `Opening ${nameOf(rel)}.` };
    } catch (err) {
      log('memory: couldn’t open a note:', err.message);
      return { ok: false, text: 'I couldn’t open Obsidian.' };
    }
  }

  return {
    /**
     * What the vault holds that bears on what's being said, for the model, in
     * square brackets: About me whole when it's short, and what's found.
     * @param {string} text  what the user just said
     * @param {{history?:{who:string, text:string}[]}|object[]} [options]  the conversation before it
     * @returns {Promise<{block:string, used:{rel:string, heading:string}[]}>}  block '' when there's nothing
     */
    async recall(text, options = {}) {
      const history = Array.isArray(options) ? options : listOf(options?.history);
      const said = plain(text);
      const vault = current();
      if (!vault || !said) return { block: '', used: [] };
      const date = new Date(now());
      let facts = [];
      try {
        facts = listOf(vault.aboutMe()?.facts).map((item) => plain(item?.fact).replace(/\.$/, '')).filter(Boolean);
      } catch (err) {
        log('memory: couldn’t read About me:', err.message);
      }
      const query = queryFor(said, history);
      let hits = [];
      try {
        hits = (await index?.search?.(query, { limit: SEARCHED, perNote: 2 })) || [];
      } catch (err) {
        log('memory: couldn’t search the vault:', err.message);
      }
      // A note as it is, read only for a piece cut partway down a table.
      const textOf = (rel) => {
        try {
          return String(vault.read(rel)?.body ?? '');
        } catch {
          return '';
        }
      };
      return recalled(facts, hits, date, wordsOf(query), leftOut, textOf);
    },

    /**
     * A conversation that's over, summed up by one model call: kept in the
     * day's note, with what it showed about the user in About me, when there's
     * a vault and conversations are kept. Rejects when the model call fails.
     * @param {{who:string, text:string, at?:string|number}[]} entries
     * @returns {Promise<{summary:string, title?:string}>}  the summary, for recollections.js
     */
    async ended(entries) {
      const lines = listOf(entries).filter((entry) => plain(entry?.text));
      if (!lines.some(yours)) return { summary: '' };
      const at = startOf(lines, now);
      let known = [];
      try {
        known = listOf(current()?.aboutMe()?.facts).filter((item) => plain(item?.fact));
      } catch (err) {
        log('memory: couldn’t read About me:', err.message);
      }
      const { json } = await request({
        system: endedPrompt(new Date(at), known),
        prompt: transcriptOf(lines),
        schema: ENDED_SCHEMA,
        maxOutputTokens: ENDED_TOKENS
      });
      const kept = checked(json, known, lines, log);
      const vault = current();
      let keep = false;
      try {
        keep = !!vault && !!(await keepConversations());
      } catch (err) {
        log('memory: couldn’t tell whether conversations are kept:', err.message);
      }
      if (!keep) return { summary: kept.summary, title: kept.title };
      let wrote = false;
      try {
        const { title, summary, topics, people } = kept;
        log('memory: kept the conversation in', await vault.addConversation({ at, title, summary, topics, people }));
        wrote = true;
      } catch (err) {
        log('memory: couldn’t keep the conversation:', err.message);
      }
      if (kept.add.length || kept.remove.length) {
        try {
          log('memory: About me:', await vault.updateAboutMe({ add: kept.add, remove: kept.remove }, at));
          wrote = true;
        } catch (err) {
          log('memory: couldn’t change About me:', err.message);
        }
      }
      if (wrote) refreshSoon();
      return { summary: kept.summary, title: kept.title };
    },

    /**
     * Keeps what the user asked him to remember, word for word, in a note of its own.
     * @param {{text:string, transcript:{who:string, text:string}[]}} what  the model's copy of the words, and the conversation
     * @returns {Promise<{ok:true, title:string, rel:string}|{ok:false, why:string}>}  why: a sentence he can say
     */
    async remember({ text, transcript } = {}) {
      const words = verbatim(text, transcript);
      const secret = secretIn(words) || secretIn(text);
      if (secret) {
        log('memory: wouldn’t keep words holding', secret);
        return { ok: false, why: WHY.secret };
      }
      const vault = current();
      if (!vault) return { ok: false, why: WHY.noVault };
      // "Remember this", with nothing before it to keep: the words are what they say next.
      if (!words) return { ok: false, why: onlyAsked(transcript) ? WHY.what : WHY.notFound };
      const title = titleFor(words) || 'Remembered';
      try {
        const rel = await vault.remember({ at: now(), title, text: words, topics: topicsOf(title) });
        refreshSoon();
        return { ok: true, title, rel };
      } catch (err) {
        log('memory: couldn’t keep words:', err.message);
        return { ok: false, why: WHY.unwritten };
      }
    },

    /**
     * Adds to a note in Notes/ (making it if there's none), or opens any note in Obsidian.
     * @param {{title:string, add?:string, open?:boolean}} what
     * @returns {Promise<{ok:boolean, text:string}>}  text: what he says
     */
    async note({ title, add, open } = {}) {
      const asked = trimmed(plain(title));
      const adding = typeof add === 'string' ? add.trim() : '';
      if (adding && (secretIn(adding) || secretIn(`${asked}: ${adding}`))) return { ok: false, text: WHY.secret };
      const vault = current();
      if (!vault) return { ok: false, text: WHY.noVault };
      if (!asked) return { ok: false, text: 'I didn’t catch which note.' };
      let found = null;
      try {
        found = await vault.findNote(asked);
      } catch (err) {
        log('memory: couldn’t look for a note:', err.message);
      }
      if (adding) {
        // None by that name: one in Notes by much the same name, rather than a second list. addToNote() looks the note
        // up again by name: the name that just found it, or one that finds that very note, never merely its title.
        const near = found ? null : lookalike(vault, asked, (rel) => rel.startsWith('Notes/'));
        const into = found || !near ? asked : await nameFor(vault, near);
        if (!into) return { ok: false, text: `I couldn’t tell which note “${asked}” is.` };
        try {
          const { rel, created } = await vault.addToNote({ title: into, text: adding, at: now() });
          refreshSoon();
          if (open) await opened(vault, rel);
          const what = adding.length <= 60 && !adding.includes('\n') ? `“${adding}”` : 'that';
          return { ok: true, text: created ? `Made a note called ${nameOf(rel)}, with ${what} in it.` : `Added ${what} to ${nameOf(rel)}.` };
        } catch (err) {
          const name = err?.rel ? nameOf(err.rel) : found ? nameOf(found.rel) : asked;
          if (err?.code === 'read_only' && err.linked) return { ok: false, text: `“${name}” is a link to a file elsewhere, so I won’t change it.` };
          if (err?.code === 'read_only') return { ok: false, text: `“${name}” isn’t in your Notes folder, so I can’t change it.` };
          log('memory: couldn’t add to a note:', err.message);
          return { ok: false, text: `I couldn’t change “${name}”.` };
        }
      }
      const rel = found?.rel || lookalike(vault, asked);
      if (!rel) return { ok: false, text: open ? `There’s no note called “${asked}”.` : `What should I put in “${asked}”?` };
      return opened(vault, rel);
    }
  };
}
