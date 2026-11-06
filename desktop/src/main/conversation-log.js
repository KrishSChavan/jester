/**
 * What's been said to Jester and what he said, as a JSON file on this computer.
 * It holds the conversation's context, and is emptied every hour, so nothing
 * said lasts longer word for word. Only what was said to him goes in: not the room.
 *
 * Entries belong to numbered conversations, so what's over can be told from what's
 * still going on. A conversation ending goes to recollections.js, in a sentence.
 */

import fs from 'node:fs';
import path from 'node:path';

export const EMPTIED_EVERY_MS = 60 * 60 * 1000;

/**
 * @param {object} options
 * @param {string} options.file
 * @param {() => number} [options.now]
 * @param {(entries:object[]) => void} [options.onEmptied]  what the hour took, of the conversation going on
 * @returns {{add:Function, current:Function, idleFor:Function, startNew:Function, expire:Function, clear:Function}}
 */
export function createConversationLog({ file, now = Date.now, onEmptied = () => undefined }) {
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

  /** Empties the file once its hour is up: also after a sleep, or a time Jester wasn't running. */
  function expire() {
    if (now() - data.emptiedAt < EMPTIED_EVERY_MS) return;
    const taken = going();
    data = { emptiedAt: now(), conversation: data.conversation + 1, entries: [] };
    write();
    if (taken.length) onEmptied(taken);
  }

  expire();
  return {
    expire,
    /** @param {'you'|'jester'} who */
    add(who, text) {
      expire();
      data.entries.push({ at: new Date(now()).toISOString(), who, text: String(text), conversation: data.conversation });
      write();
    },
    /** The last few things said in the conversation going on, oldest first. */
    current(count) {
      expire();
      return going().slice(-count);
    },
    /** How long since anything was said, or null with nothing going on. */
    idleFor() {
      const last = going().at(-1);
      return last ? now() - Date.parse(last.at) : null;
    },
    /**
     * Ends the conversation going on, but for its last `keep` entries, which open the next.
     * @returns {object[]} what was ended
     */
    startNew(keep = 0) {
      const entries = going();
      const ended = entries.slice(0, entries.length - keep);
      data.conversation += 1;
      for (const entry of entries.slice(entries.length - keep)) entry.conversation = data.conversation;
      write();
      return ended;
    },
    /** Everything, now. */
    clear() {
      data = { emptiedAt: now(), conversation: data.conversation + 1, entries: [] };
      write();
    }
  };
}
