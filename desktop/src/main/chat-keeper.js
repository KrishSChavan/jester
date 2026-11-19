/**
 * What becomes of a conversation once it's over, and of the chats kept: main.js's part between the conversation
 * log, the Chats archive (chat-archive.js) and the sentences he remembers them by (recollections.js), kept here so
 * it can be tested.
 *
 * A chat is in Chats the moment it's over. Its sentence, which is also its title, follows once the model has
 * written it, which can take a while (Ollama loading, or answering first), and isn't kept at all if the chat's been
 * deleted or forgotten meanwhile: the archive saying it still has the chat is what says it's still wanted. A chat
 * picked up again and left without a word keeps its place and its week.
 */

const idOf = (entries) => entries?.find?.((entry) => entry?.chat)?.chat || '';
/** Nothing's been said in it since it was picked up: what's kept of it is already right. */
const untouched = (entries) => entries.every((entry) => entry?.earlier);
/** Something the user's said in it that's new: there's a sentence to write. */
const saidAnew = (entries) => entries.some((entry) => entry?.who === 'you' && !entry.earlier && String(entry.text ?? '').trim());

/**
 * @param {object} options
 * @param {ReturnType<import('./chat-archive.js').createChatArchive>} options.chats
 * @param {{keep:Function, remove:Function, forget:Function}} options.recollections
 * @param {() => string} [options.live]  the chat going on, which the Chats screen leaves out
 * @param {() => void} [options.onChats]  what's kept changed: the Chats screen lists them again
 * @param {(...parts:any[]) => void} [options.log]
 */
export function createChatKeeper({ chats, recollections, live = () => '', onChats = () => undefined, log = () => undefined }) {
  /** Into Chats now. @returns {string} its id, or '' when nothing was kept */
  function keep(entries, more = {}) {
    if (!entries?.length) return '';
    if (untouched(entries)) {
      // Left out of the list while it was going on: it's listed again where it was.
      onChats();
      return '';
    }
    const id = chats.keep(entries, more);
    onChats();
    return id;
  }

  /** A chat's still wanted: kept, and neither deleted nor forgotten since. One with no id has nothing to check. */
  const wanted = (entries, id = idOf(entries)) => !id || chats.has(id);

  /**
   * Its sentence, for him, and its title: after he's answered. Deleted or forgotten while the model wrote it, it's
   * forgotten again. @returns {Promise<string>} the sentence, or '' when none was kept
   */
  async function sumUp(entries, id = idOf(entries)) {
    if (!entries?.length || !saidAnew(entries) || !wanted(entries, id)) return '';
    try {
      const summary = await recollections.keep(entries);
      if (!wanted(entries, id)) {
        if (id) recollections.remove(id);
        return '';
      }
      if (id && summary) {
        chats.titled(id, summary);
        onChats();
      }
      return summary || '';
    } catch (err) {
      log('couldn’t keep a conversation:', err.message);
      return '';
    }
  }

  return {
    keep,
    sumUp,
    /** Over by itself (quiet, or the hour): in Chats now, and summed up. */
    over(entries, more = {}) {
      const id = keep(entries, more);
      return sumUp(entries, id || idOf(entries));
    },
    /** For a summary on its way to the vault: is this conversation still kept? */
    wanted: (entries) => wanted(entries),
    /** Deleted from Chats: its words and its sentence. @returns {boolean} whether it was there */
    remove(id) {
      recollections.remove(id);
      const gone = chats.remove(id);
      onChats();
      return gone;
    },
    /** Forget it all: every chat and every sentence. */
    forgetAll() {
      recollections.forget();
      chats.clear();
      onChats();
    },
    /** What's a week old goes now, rather than when next read. */
    sweep() {
      if (chats.sweep()) onChats();
    },
    /** For the Chats screen: all but the one going on. */
    list() {
      // A chat per device (sessions.js): every one going on, on any of them.
      const going = [live()].flat();
      return chats.list().filter((chat) => !going.includes(chat.id));
    },
    get: (id) => chats.get(id)
  };
}
