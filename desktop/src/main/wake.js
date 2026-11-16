/**
 * Whether something overheard was said to Jester. The recognizer has no
 * wake-word mode: it gives a transcript per utterance, and this reads it.
 *
 * The word lists come from 18,000 transcripts of the trigger words said by
 * twelve synthetic voices (see README): American voices get "Jester", but
 * British, Indian and Australian ones mostly get "Just a…" or "Just to…". So
 * "just" counts, though only with a request after it, which "Just kidding" and
 * "Just what I needed" don't have. Names people really have (Jess, Jay) need
 * the same, or a "hey" before them, or a comma after: "Jess and I went out" is
 * not for Jester, and no text can tell "Jess, pass the salt" from him.
 */

/** Sure enough to count by themselves, first in what's said. */
const NAME = new Set(['jester', 'jesters', "jester's", 'gester', 'gestor', 'jestor', 'jesper', 'jesser', 'jessa', 'jesso', 'jesa', 'jesker', 'dester', 'juster', 'jetster']);
/** What he's called for short: alone, these are enough. */
const SHORT = new Set(['j', 'jay', 'jes', 'jess']);
/** Real words and names the recognizer also writes for his: these want a sign that they're being called. */
const NEAR = new Set(['chester', 'gesture', 'gestures', 'jest', 'jesse', 'jessie', 'jessica', 'jace', 'jase', 'jazz', 'jaz']);
/** What may come before the name without changing who's meant. */
const OPENING = /^(?:(?:hey|hi|hello|okay|ok|yo|um|uh|so|oh|ah)\b[\s,.!?-]*)+/i;
/**
 * More of what people turn to him with: "Yeah Jester…", "Wait, Jester…", "Alright Jester…". Only before his own
 * name: before a word that's also a person's or an everyday one, they're just talk ("No, Jess, stop it", "No, just
 * stop").
 */
const TURNING = /^(?:(?:hey|hi|hello|okay|ok|yo|um|uh|so|oh|ah|yeah|yes|no|well|and|but|now|wait|alright|all right|right|actually|sorry|hmm|hm)\b[\s,.!?-]*)+/i;
const CALLED = /^(?:(?:hey|hi|hello|okay|ok|yo)\b)/i;
/** The name last, as in "what time is it, Jester?": set off by a comma, ending a question, or after a request. */
const ENDING = /^(.+?)(?:,\s*|\s+)(jester|jesters|chester|gesture)\s*([.?!]*)$/i;
const FIRST_WORD = /^([a-z]+(?:'[a-z]+)?)(?=$|[^a-z'])/i;
/** A request's first words. Long enough to be something said to a computer, not a person. */
const REQUEST = /^(?:please\s+)?(?:(?:can|could|would|will|should|do)\s+(?:you|i|we)\b|what|what's|whats|when|where|who|why|how|open|close|quit|play|pause|stop|resume|mute|unmute|skip|next|previous|turn|set|start|show|hide|tell|say|read|write|type|search|google|look|find|go|take|make|create|put|move|send|reply|call|text|email|remind|lock|volume|louder|quieter|thanks|thank)\b/i;
/** After "just": people say "just take it", "just what I needed" and "just go" to each other. */
const JUST_REQUEST = /^(?:(?:a|to|the)\s+)?(?:please\s+)?(?:(?:open|close|quit|play|pause|stop|resume|mute|unmute|skip|turn|set|start|tell|write|type|search|google|remind|lock|volume|read|minimize|scroll|click|press)\b|(?:new|next)\s+(?:tab|window|song|track)\b|what\s+(?:time|is|are|do|does|did|was)\b|what's\b|how\s+(?:are|is|do|does)\b|how's\b|(?:can|could|would|will)\s+you\b|show\s+me\b)/i;
const MEANT = /^(?:(?:a|to|the)\s+)(?=\S)/i;

const tidy = (text) => text.replace(/^[\s,.:;!?-]+/, '').trim();
const said = (rest, word) => ({ woken: true, rest: tidy(rest), word });
const NOT_ADDRESSED = Object.freeze({ woken: false, rest: '', word: '' });

/**
 * @param {string} heard  a finished utterance
 * @returns {{woken:boolean, rest:string, word:string}} rest: what was said to him, without his name
 */
export function addressed(heard) {
  const text = String(heard ?? '').trim();
  const opening = text.match(OPENING)?.[0] || '';
  const body = text.slice(opening.length);
  const first = body.match(FIRST_WORD)?.[1];
  if (first) {
    const word = first.toLowerCase();
    const after = body.slice(first.length);
    const rest = tidy(after);
    if (NAME.has(word)) return said(after, word);
    const called = !!rest && (CALLED.test(opening) || /^\s*[,!?]/.test(after) || REQUEST.test(rest));
    if (SHORT.has(word) ? !rest || called : NEAR.has(word) && called) return said(after, word);
    if (word === 'just' && JUST_REQUEST.test(rest)) return said(rest.replace(MEANT, ''), word);
  }
  // A turning word, then his own name.
  const turned = text.match(TURNING)?.[0] || '';
  const named = turned.length > opening.length ? text.slice(turned.length).match(FIRST_WORD)?.[1] : '';
  if (named && NAME.has(named.toLowerCase())) return said(text.slice(turned.length + named.length), named.toLowerCase());
  // Further in: "Watch this. Jester, what's the weather?", "The bread's in, Jester, set a timer for forty minutes".
  // With people talking, what's said to him seldom starts the breath it's said in (2026-11-16: with a friend in the
  // room he took nothing that didn't begin with his name after a silence). Only his own name, never a word that's
  // also someone's, and only as a call: opening a later sentence with a comma or a request after it, or between
  // commas with a request after it. "I told Jester to play something", "Yesterday, Jester set a timer" and "My
  // assistant, Jester, is running" are about him. The first such call is the one: what follows is all his.
  for (const match of text.matchAll(/[a-z]+(?:'[a-z]+)?/gi)) {
    if (!match.index || !NAME.has(match[0].toLowerCase())) continue;
    const before = text.slice(0, match.index);
    const after = text.slice(match.index + match[0].length);
    const rest = tidy(after);
    if (!rest) continue;
    const comma = /^\s*,/.test(after);
    const asks = REQUEST.test(rest);
    // A new sentence, begun with his name or a turning word and his name.
    const opens = new RegExp(`[.!?]["”’')\\]]*\\s+(?:${TURNING.source.slice(1)})?$`, 'i').test(before);
    if ((opens && (comma || asks)) || (/,\s*$/.test(before) && comma && asks)) return said(after, match[0].toLowerCase());
  }
  const ending = text.match(ENDING);
  if (ending && (/,\s*\S+\s*[.?!]*$/.test(text) || ending[3].includes('?') || REQUEST.test(body))) return said(ending[1].slice(opening.length), ending[2].toLowerCase());
  return NOT_ADDRESSED;
}

/**
 * The start of an utterance still being said, from the recognizer: whether it
 * opens with his name, sure enough to show he's listening before it's over.
 * Only the name first counts, since the rest isn't there yet; and his short
 * names only with words after them, as "Jess" alone may be "Jess and I…".
 */
export function wakesEarly(partial) {
  const text = String(partial ?? '').trim();
  const { woken, word, rest } = addressed(text);
  const first = text.slice(text.match(OPENING)?.[0].length || 0).match(FIRST_WORD)?.[1]?.toLowerCase();
  return woken && first === word && (NAME.has(word) || !!rest);
}

/**
 * Where his name sits in something heard, for the log: how many words there were, and which of them was his name
 * (1 for the first; 0 when it isn't there). The words themselves are never logged.
 */
export function nameAt(heard) {
  const words = String(heard ?? '').toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) || [];
  return { words: words.length, at: words.findIndex((word) => NAME.has(word) || NEAR.has(word) || SHORT.has(word)) + 1 };
}
