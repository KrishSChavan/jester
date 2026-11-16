/**
 * Chats: every conversation that's over, word for word, kept a week on this
 * computer for the window's Chats panel, where one can be read again or carried
 * on (conversation-log.js restore). recollections.js keeps what the model is
 * told of them, a sentence each, which becomes each chat's title here once the
 * model has written it. A line holding what looks like a password, a card
 * number or a key is kept as only that it did.
 *
 * A chat is known by the id its lines carry (conversation-log.js `chat`): one
 * carried on and over again replaces what was kept of it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { secretIn } from './vault-memory.js';

export const CHATS_KEPT_MS = 7 * 24 * 60 * 60 * 1000;
/** At most this many chats, and lines in each: a week of talking is far fewer. */
const MOST = 300;
const MOST_LINES = 600;
const MOST_CHARS = 4000;
const TITLE_CHARS = 300;
/** Before a chat has its sentence, its title is how it opened. */
const OPENING_CHARS = 120;

const said = (entry) => String(entry?.text ?? '').trim();
const yours = (entry) => entry?.who === 'you';
/**
 * A secret given across two lines: a line that names one and stops, then the user's next short line. The user's
 * line hands it over ("my PIN is", "wifi password:"); his asks for it ("What's the wifi password?"). A question of
 * the user's ("how do I reset my password?") gives nothing, nor does a secret's name in passing ("my car keys").
 */
const ANSWER_WORDS = 4;
const SECRETS = [
  [String.raw`(?:pass(?:word|code|phrase)|passwd|pwd?)s?`, 'a password'],
  [String.raw`pins?(?:\s+(?:number|code))?`, 'a PIN'],
  [String.raw`(?:security|access|door|gate|alarm|lock|promo|verification|login)?\s*codes?`, 'a code'],
  [String.raw`(?:api|secret|license|licence|product)?\s*keys?`, 'a key']
];
const HANDS_OVER = SECRETS.map(([name, kind]) => [new RegExp(String.raw`\b${name}\s*(?:is|are|was|:|=)\s*$`, 'i'), kind]);
const ASKS_FOR = SECRETS.map(([name, kind]) => [new RegExp(String.raw`\b${name}\W*$`, 'i'), kind]);
const QUESTION = /\?\s*$|^\W*(?:what|who|whose|when|where|why|how|which|do|does|did|can|could|would|will|should|is|are)\b/i;

/** A line as it's kept: one that looks like a secret, only that it was there; one kept so already, as it is. */
function keptLine(entry, fallbackAt, { follows = '' } = {}) {
  const text = said(entry).slice(0, MOST_CHARS);
  const ms = Date.parse(entry?.at);
  const at = new Date(Number.isFinite(ms) ? ms : fallbackAt).toISOString();
  const who = entry?.who === 'jester' ? 'jester' : 'you';
  if (entry?.hidden) return { who, text, at, hidden: true };
  const short = text.split(/\s+/).filter(Boolean).length <= ANSWER_WORDS;
  const secret = secretIn(text) || (who === 'you' && short ? follows : '');
  // Kept too: that it held someone else's words (a calendar's titles), so a chat picked up again is as careful.
  return { who, text: secret ? `Left out: this held ${secret}.` : text, at, ...(secret ? { hidden: true } : {}), ...(!secret && cardOf(entry?.card) ? { card: cardOf(entry.card) } : {}), ...(entry?.untrusted ? { untrusted: true } : {}) };
}

/** A line's card as it's kept: what it's of and where to find it, each a short string, and nothing else. */
export function cardOf(card) {
  if (!card || typeof card !== 'object' || !['task', 'note', 'remembered', 'brief', 'mail'].includes(card.kind)) return null;
  const short = (value, most) => (typeof value === 'string' && value ? value.slice(0, most) : undefined);
  const kept = { kind: card.kind, id: short(card.id, 40), type: short(card.type, 12), text: short(card.text, 200), title: short(card.title, 120), rel: short(card.rel, 300), snippet: short(card.snippet, 160) };
  // A brief's card is its facts, a line each.
  const lines = (card.kind === 'brief' || card.kind === 'mail') && Array.isArray(card.lines) ? card.lines.filter((line) => typeof line === 'string' && line).slice(0, 8).map((line) => line.slice(0, 160)) : [];
  return { ...Object.fromEntries(Object.entries(kept).filter(([, value]) => value !== undefined)), ...(lines.length ? { lines } : {}) };
}

/** The secret a line leaves the user's next line to give: '' for none. */
function leavesToGive(entry) {
  const text = String(entry?.text ?? '').trim();
  if (entry?.hidden) return '';
  if (entry?.who === 'jester') return ASKS_FOR.find(([pattern]) => pattern.test(text))?.[1] || '';
  if (QUESTION.test(text)) return '';
  return HANDS_OVER.find(([pattern]) => pattern.test(text))?.[1] || '';
}

function opening(lines) {
  const first = lines.find((line) => yours(line) && !line.hidden) || lines.find((line) => !line.hidden);
  const text = first ? first.text.replace(/\s+/g, ' ') : 'A chat';
  return text.length > OPENING_CHARS ? `${text.slice(0, OPENING_CHARS - 1).trimEnd()}…` : text;
}

/**
 * @param {object} options
 * @param {string} options.file
 * @param {() => number} [options.now]
 * @param {() => string} [options.newId]  for a chat whose lines carry none (a log from before chats were kept)
 * @param {(...parts:any[]) => void} [options.log]
 */
export function createChatArchive({ file, now = Date.now, newId = randomUUID, log = () => undefined }) {
  /** Oldest first: {id, startedAt, endedAt, title, lines:{who, text, at, hidden?}[]} */
  let chats = [];

  function write() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Written beside it and swapped in: a crash never leaves half a file.
    const next = `${file}.tmp`;
    fs.writeFileSync(next, `${JSON.stringify({ chats }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(next, file);
  }

  try {
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(stored?.chats)) chats = stored.chats.filter((chat) => chat?.id && Array.isArray(chat.lines));
  } catch {
    /* none yet, or not ours: start with nothing */
  }

  /** What's older than a week goes. @returns {boolean} whether anything went */
  function fresh() {
    const limit = now() - CHATS_KEPT_MS;
    const before = chats.length;
    chats = chats.filter((chat) => chat.endedAt >= limit).slice(-MOST);
    return chats.length !== before;
  }

  if (fresh()) write();

  const lastOf = (chat) => Date.parse(chat.lines.at(-1)?.at) || chat.endedAt;
  const summary = ({ id, startedAt, endedAt, title, lines }) => ({
    id,
    startedAt,
    endedAt,
    // When the last thing was said: what the list goes by.
    lastAt: Date.parse(lines.at(-1)?.at) || endedAt,
    title: title || opening(lines),
    lines: lines.length
  });

  return {
    /**
     * A conversation that's over, kept; one carried on replaces what was kept of it, title and all until the model
     * sums it up again. Nothing the user said, nothing kept.
     * @param {{who:string, text:string, at:string, chat?:string}[]} entries
     * @returns {string} the chat's id, or '' when nothing was kept
     */
    keep(entries) {
      const list = (Array.isArray(entries) ? entries : []).filter(said);
      if (!list.some(yours)) return '';
      const id = String(list.find((entry) => entry.chat)?.chat || newId());
      const at = now();
      // A secret given across two lines: its name, then (after his "Go on", perhaps) the user's next short line.
      // The user's own line settles it either way; one of his that asks for nothing leaves it as it was.
      let follows = '';
      const lines = list.slice(-MOST_LINES).map((entry) => {
        const line = keptLine(entry, at, { follows });
        if (line.who === 'you') follows = leavesToGive(entry);
        else follows = leavesToGive(entry) || follows;
        return line;
      });
      const old = chats.find((chat) => chat.id === id);
      fresh();
      chats = chats.filter((chat) => chat.id !== id);
      chats.push({ id, startedAt: Date.parse(lines[0].at), endedAt: at, title: old?.title || '', lines });
      try {
        write();
      } catch (err) {
        log('couldn’t keep a chat:', err.message);
      }
      return id;
    },
    /** Its sentence, from recollections.js, once the model has written it. */
    titled(id, title) {
      const chat = chats.find((item) => item.id === id);
      const text = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, TITLE_CHARS);
      if (!chat || !text || chat.title === text) return;
      chat.title = text;
      write();
    },
    /** Newest first by when the last thing was said in each, as the Chats screen dates them; without their lines. */
    list() {
      if (fresh()) write();
      return [...chats].sort((a, b) => lastOf(b) - lastOf(a)).map(summary);
    },
    /** Whether a chat's still kept: not deleted, forgotten, or a week old. */
    has(id) {
      const chat = chats.find((item) => item.id === id);
      return !!chat && chat.endedAt >= now() - CHATS_KEPT_MS;
    },
    /** What's a week old goes now, rather than when next read. @returns {boolean} whether anything went */
    sweep() {
      if (!fresh()) return false;
      try {
        write();
      } catch (err) {
        log('couldn’t drop old chats:', err.message);
      }
      return true;
    },
    /** One chat, lines and all, or null once it's gone. */
    get(id) {
      if (fresh()) write();
      const chat = chats.find((item) => item.id === id);
      return chat ? { ...summary(chat), lines: chat.lines.map((line) => ({ ...line })) } : null;
    },
    /** @returns {boolean} whether there was one */
    remove(id) {
      const before = chats.length;
      chats = chats.filter((chat) => chat.id !== id);
      if (chats.length === before) return false;
      write();
      return true;
    },
    clear() {
      chats = [];
      write();
    }
  };
}
