/**
 * What's been said to Jester and what he said, as a JSON file on this computer.
 * It holds the conversation's context, and is emptied every hour; what's over
 * is kept word for word for a week as a chat (chat-archive.js), and as a
 * sentence for the model (recollections.js). Only what was said to him goes in:
 * not the room.
 *
 * Entries belong to numbered conversations, so what's over can be told from what's
 * still going on. A conversation is over once it's been quiet for `endAfterMs`
 * (conversation.js NEW_AFTER_MS), and goes to onEnded there and then: its memory
 * (recollections.js, and the vault's summary and facts) is written within minutes
 * of it going quiet, not when the hour comes round. Quiet while a task does what
 * it asked (`busy`) isn't its end, and nor is a line of his coming late: a task's
 * result belongs with what asked for it. Nor does the hour cut one in two: what's
 * over goes on the hour, and a conversation still going on waits for its end.
 * With no `endAfterMs`, the hour takes the conversation going on with it.
 *
 * Each conversation is a chat with an id, which its entries carry (`chat`). A chat
 * that was over can be carried on (`restore`): its lines come back marked `earlier`,
 * and it keeps its id, so when it's over again it takes the place of what was kept.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sourcesOf } from './research-sources.js';

export const EMPTIED_EVERY_MS = 60 * 60 * 1000;

function safeSources(entry) {
  const { sources, ...line } = entry;
  const kept = line.hidden ? [] : sourcesOf(sources);
  return { ...line, ...(kept.length ? { sources: kept } : {}) };
}

/**
 * @param {object} options
 * @param {string} options.file
 * @param {() => number} [options.now]
 * @param {number} [options.endAfterMs]  this long quiet, the conversation going on is over; by default only the hour ends one
 * @param {() => boolean} [options.busy]  a task is at work for the conversation (conversation.js acting): quiet doesn't
 *   end it meanwhile, for an hour at most, should one never finish
 * @param {(entries:object[]) => void} [options.onEnded]  a conversation that's over: gone quiet, or taken by the hour
 * @param {(entries:object[]) => void} [options.onEmptied]  onEnded's old name, still taken
 * @param {() => void} [options.onChange]  the conversation going on changed: a line, an end, a chat carried on.
 *   Called as it happens, so it shouldn't read the log back there and then.
 * @param {() => string} [options.newId]  a new chat's id
 * @returns {{add:Function, current:Function, entries:Function, chatId:Function, idleFor:Function, startNew:Function,
 *   restore:Function, justResumed:Function, expire:Function, clear:Function}}
 */
export function createConversationLog({ file, now = Date.now, endAfterMs = Infinity, busy = () => false, onEnded, onEmptied, onChange = () => undefined, newId = randomUUID }) {
  const ended = onEnded || onEmptied || (() => undefined);
  let data = { emptiedAt: now(), conversation: 1, chat: newId(), entries: [] };

  function write() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Written beside it and swapped in: a crash never leaves half a file.
    const next = `${file}.tmp`;
    data.entries = data.entries.map(safeSources);
    fs.writeFileSync(next, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(next, file);
  }

  function changed() {
    try {
      onChange();
    } catch {
      /* the window's business, not the log's */
    }
  }

  try {
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Number.isFinite(stored?.emptiedAt) && Array.isArray(stored.entries)) data = { conversation: 1, ...stored, entries: stored.entries.map(safeSources) };
  } catch {
    /* no file yet, or not one of ours: start empty */
  }

  const going = () => data.entries.filter((entry) => entry.conversation === data.conversation);

  // A log from before chats were kept: what's going on is a chat from now.
  if (!data.chat) data.chat = newId();
  for (const entry of going()) entry.chat ??= data.chat;

  /** How long since anything was said, or since a chat was carried on; null with nothing going on. */
  function idleFor() {
    const last = going().at(-1);
    if (!last) return null;
    return now() - Math.max(Date.parse(last.at), data.resumedAt || 0);
  }

  /** The next conversation, a new chat; `id` carries one on. */
  function begin(id = newId()) {
    data.conversation += 1;
    data.chat = id;
    delete data.resumedAt;
  }

  /**
   * Ends the conversation going on, but for its last `keep` entries, which open the next.
   * @returns {object[]} what was ended
   */
  function startNew(keep = 0) {
    const entries = going();
    const over = entries.slice(0, entries.length - keep);
    begin();
    for (const entry of entries.slice(entries.length - keep)) {
      entry.conversation = data.conversation;
      entry.chat = data.chat;
      delete entry.earlier;
    }
    write();
    changed();
    return over;
  }

  /**
   * A conversation gone quiet is over now, but not while a task is at work for it,
   * nor as a line of his comes: that's its task's result, or its question. The file
   * is emptied once its hour is up (also after a sleep, or a time Jester wasn't
   * running), but never mid-conversation.
   * @param {boolean} [his]  a line of his is being added
   */
  function expire(his = false) {
    const idle = idleFor();
    // A task's result is said once it's stopped working, so busy() can't keep that line: being his does. A task
    // that never finishes holds the conversation an hour at most, so what's said still goes within about the hour.
    if (idle !== null && idle >= endAfterMs && !his && !(idle < EMPTIED_EVERY_MS && busy())) {
      const over = startNew();
      if (over.length) ended(over);
    }
    if (now() - data.emptiedAt < EMPTIED_EVERY_MS) return;
    const taken = going();
    // A conversation still here was talked in under endAfterMs ago, or has a task at work: the hour waits for
    // its end, and empties the file then. What's over doesn't wait with it.
    if (Number.isFinite(endAfterMs) && taken.length) {
      if (taken.length < data.entries.length) {
        data.entries = taken;
        write();
      }
      return;
    }
    data = { emptiedAt: now(), conversation: data.conversation + 1, chat: newId(), entries: [] };
    write();
    if (taken.length) {
      changed();
      ended(taken);
    }
  }

  expire();
  return {
    /** What's gone quiet is over, and the hour empties the file: main.js checks once a minute. */
    expire: () => expire(),
    /**
     * @param {'you'|'jester'} who
     * @param {{card?:object, sources?:object[], untrusted?:boolean}} [more]  card: what the line is about, for his window to show with it
     *   (cards.js); untrusted: it holds someone else's words (a calendar's titles), so what's asked after it is
     *   treated as carefully as if they'd been read out
     */
    add(who, text, { card = null, sources = null, untrusted = false } = {}) {
      expire(who === 'jester');
      data.entries.push(safeSources({ at: new Date(now()).toISOString(), who, text: String(text), conversation: data.conversation, chat: data.chat, ...(card ? { card } : {}), sources, ...(untrusted ? { untrusted: true } : {}) }));
      write();
      changed();
    },
    /** The last few things said in the conversation going on, oldest first. */
    current(count) {
      expire();
      return going().slice(-count);
    },
    /** All of the conversation going on, as it is: nothing's ended by asking. */
    entries: () => going().map(safeSources),
    /** The id of the chat going on. */
    chatId: () => data.chat,
    idleFor,
    startNew,
    /**
     * A chat that was over, carried on: what's going on ends, and is handed back to be kept as any other; the
     * chat's lines, marked `earlier`, are the conversation going on, as if it had never stopped. Its quiet is
     * counted from now, so it isn't over again before anything's said.
     * @param {{who:string, text:string, at:string}[]} entries
     * @param {string} id  the chat's
     * @returns {object[]} what was ended
     */
    restore(entries, id) {
      const over = going();
      begin(String(id));
      data.resumedAt = now();
      for (const entry of entries) {
        const who = entry?.who === 'jester' ? 'jester' : 'you';
        // A line kept as only that it held a secret stays so: it's a placeholder, not the user's words.
        const hidden = entry?.hidden ? { hidden: true } : {};
        // What a line was about, and whether it held someone else's words, come back with it.
        const more = { ...(entry?.card && typeof entry.card === 'object' ? { card: entry.card } : {}), ...(entry?.untrusted ? { untrusted: true } : {}) };
        data.entries.push(safeSources({ at: String(entry?.at ?? new Date(now()).toISOString()), who, text: String(entry?.text ?? ''), conversation: data.conversation, chat: data.chat, earlier: true, ...hidden, ...more, sources: entry?.sources }));
      }
      write();
      changed();
      return over;
    },
    /** A chat was just carried on, and the user's said at most one thing since: it's still the chat they picked. */
    justResumed: () => !!data.resumedAt && going().filter((entry) => !entry.earlier && entry.who === 'you').length <= 1,
    /** Everything, now. */
    clear() {
      data = { emptiedAt: now(), conversation: data.conversation + 1, chat: newId(), entries: [] };
      write();
      changed();
    }
  };
}
