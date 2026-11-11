/**
 * What's been said to Jester and what he said, as a JSON file on this computer.
 * It holds the conversation's context, and is emptied every hour, so what's said
 * doesn't last word for word. Only what was said to him goes in: not the room.
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
 */

import fs from 'node:fs';
import path from 'node:path';

export const EMPTIED_EVERY_MS = 60 * 60 * 1000;

/**
 * @param {object} options
 * @param {string} options.file
 * @param {() => number} [options.now]
 * @param {number} [options.endAfterMs]  this long quiet, the conversation going on is over; by default only the hour ends one
 * @param {() => boolean} [options.busy]  a task is at work for the conversation (conversation.js acting): quiet doesn't
 *   end it meanwhile, for an hour at most, should one never finish
 * @param {(entries:object[]) => void} [options.onEnded]  a conversation that's over: gone quiet, or taken by the hour
 * @param {(entries:object[]) => void} [options.onEmptied]  onEnded's old name, still taken
 * @returns {{add:Function, current:Function, idleFor:Function, startNew:Function, expire:Function, clear:Function}}
 */
export function createConversationLog({ file, now = Date.now, endAfterMs = Infinity, busy = () => false, onEnded, onEmptied }) {
  const ended = onEnded || onEmptied || (() => undefined);
  let data = { emptiedAt: now(), conversation: 1, entries: [] };

  function write() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Written beside it and swapped in: a crash never leaves half a file.
    const next = `${file}.tmp`;
    fs.writeFileSync(next, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(next, file);
  }

  try {
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Number.isFinite(stored?.emptiedAt) && Array.isArray(stored.entries)) data = { conversation: 1, ...stored };
  } catch {
    /* no file yet, or not one of ours: start empty */
  }

  const going = () => data.entries.filter((entry) => entry.conversation === data.conversation);

  /** How long since anything was said, or null with nothing going on. */
  function idleFor() {
    const last = going().at(-1);
    return last ? now() - Date.parse(last.at) : null;
  }

  /**
   * Ends the conversation going on, but for its last `keep` entries, which open the next.
   * @returns {object[]} what was ended
   */
  function startNew(keep = 0) {
    const entries = going();
    const over = entries.slice(0, entries.length - keep);
    data.conversation += 1;
    for (const entry of entries.slice(entries.length - keep)) entry.conversation = data.conversation;
    write();
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
    data = { emptiedAt: now(), conversation: data.conversation + 1, entries: [] };
    write();
    if (taken.length) ended(taken);
  }

  expire();
  return {
    /** What's gone quiet is over, and the hour empties the file: main.js checks once a minute. */
    expire: () => expire(),
    /** @param {'you'|'jester'} who */
    add(who, text) {
      expire(who === 'jester');
      data.entries.push({ at: new Date(now()).toISOString(), who, text: String(text), conversation: data.conversation });
      write();
    },
    /** The last few things said in the conversation going on, oldest first. */
    current(count) {
      expire();
      return going().slice(-count);
    },
    idleFor,
    startNew,
    /** Everything, now. */
    clear() {
      data = { emptiedAt: now(), conversation: data.conversation + 1, entries: [] };
      write();
    }
  };
}
