/**
 * What Jester remembers of conversations that are over: one sentence each, kept
 * for a week. The conversation log, word for word, is still emptied hourly; this
 * is what lets him be asked "what did we say about Boston?" after that, without
 * every new conversation starting out in the shadow of the last.
 */

import fs from 'node:fs';
import path from 'node:path';

export const KEPT_MS = 7 * 24 * 60 * 60 * 1000;
const MOST = 60;
/** How many reach the model at once. */
const AT_ONCE = 6;
const COMMON = new Set(['about', 'after', 'again', 'also', 'been', 'could', 'from', 'have', 'just', 'like', 'more', 'said', 'should', 'some', 'that', 'them', 'then', 'there', 'they', 'this', 'user', 'want', 'were', 'what', 'when', 'where', 'which', 'will', 'with', 'would', 'your']);

const wordsIn = (text) => new Set((String(text).toLowerCase().match(/[a-z0-9']{4,}/g) || []).filter((word) => !COMMON.has(word)));

/**
 * @param {object} options
 * @param {string} options.file
 * @param {(entries:{who:string, text:string}[]) => Promise<string>} options.summarize  in a sentence
 * @param {() => number} [options.now]
 */
export function createRecollections({ file, summarize, now = Date.now, log = () => undefined }) {
  let kept = [];

  function write() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const next = `${file}.tmp`;
    fs.writeFileSync(next, `${JSON.stringify({ conversations: kept }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(next, file);
  }

  try {
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(stored?.conversations)) kept = stored.conversations;
  } catch {
    /* none yet, or not ours: start with nothing */
  }

  function fresh() {
    const limit = now() - KEPT_MS;
    kept = kept.filter((item) => item.at >= limit).slice(-MOST);
  }

  return {
    /** A conversation that's over, in a sentence. With no model to hand, its opening stands for it. */
    async keep(entries) {
      const said = entries.filter((entry) => entry.who === 'you');
      if (!said.length) return;
      const summary = await summarize(entries).catch((err) => {
        log('couldn’t sum up a conversation:', err.message);
        return `The user said: ${said[0].text}`;
      });
      fresh();
      kept.push({ at: now(), summary: String(summary).slice(0, 300) });
      write();
    },
    /** The ones that share words with what's being said, then the latest, oldest first. */
    relevant(text) {
      fresh();
      const words = wordsIn(text);
      const shared = (item) => [...wordsIn(item.summary)].filter((word) => words.has(word)).length;
      return kept
        .map((item, index) => ({ item, index, score: shared(item) }))
        .sort((a, b) => b.score - a.score || b.index - a.index)
        .slice(0, AT_ONCE)
        .sort((a, b) => a.index - b.index)
        .map(({ item }) => item);
    },
    /** All of them, newest first. */
    all() {
      fresh();
      return [...kept].reverse();
    },
    forget() {
      kept = [];
      write();
    }
  };
}
