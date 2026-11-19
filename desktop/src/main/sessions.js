/**
 * A chat per device (the user, 2026-11-18: "I want a chat per device", so the phone and the laptop can each be asked
 * something at once, and neither's turn cuts the other's off).
 *
 * A session is one conversation going on (conversation.js) and its log (conversation-log.js), made by main.js for a
 * key: a device's id on a server, 'local' in the app on its own, where there's only ever the one. Everything else is
 * shared between them: his memory, the user's tasks and notes, the chats that are over (one list, each marked with
 * the device it was on).
 *
 * `front` is the one the user's at: where he's being talked to, or was last typed to. What nobody asked for (a
 * reminder, a brief, a timer's ring) is said there.
 */

/** A key as a file's name: a device's id is letters, digits, - and _ already. */
export const sessionFile = (key) => (key === 'local' ? 'conversation.json' : `conversation-${String(key).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'x'}.json`);
/** The key a file was made for, or '' if it isn't one of these. */
export const sessionKeyOf = (file) => (file === 'conversation.json' ? 'local' : /^conversation-([A-Za-z0-9_-]{1,64})\.json$/.exec(file)?.[1] || '');

/**
 * @param {object} deps
 * @param {(key:string) => {conversation:object, log:object}} deps.make
 * @param {() => string} [deps.frontKey]  which is in front now, when something outside knows (the device being used)
 */
export function createSessions({ make, frontKey = () => '' }) {
  const all = new Map();
  let last = 'local';

  function get(key = 'local') {
    const name = String(key || 'local');
    if (!all.has(name)) all.set(name, { key: name, usedAt: 0, ...make(name) });
    return all.get(name);
  }

  return {
    get,
    has: (key) => all.has(String(key)),
    list: () => [...all.values()],
    /** The session a chat that's going on is in, or null. */
    ofChat: (id) => (id ? [...all.values()].find((session) => session.log.chatId() === id) || null : null),
    /** Used just now: it's in front until another is. */
    used(key, at = Date.now()) {
      const session = get(key);
      session.usedAt = at;
      last = session.key;
      return session;
    },
    front: () => get(frontKey() || last),
    get frontKey() {
      return frontKey() || last;
    }
  };
}

/** An object that is always the front session's: for what's said to whoever's there. */
export function following(pick) {
  return new Proxy(
    {},
    {
      get: (_target, name) => {
        const target = pick();
        const value = target?.[name];
        return typeof value === 'function' ? value.bind(target) : value;
      },
      has: (_target, name) => name in (pick() || {})
    }
  );
}
