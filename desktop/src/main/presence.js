/**
 * Whether the user is at the computer: here, near or away. It decides how
 * something is told to them (said aloud now, or kept until they're back; a
 * phone comes later), and it's how he knows the day's first sit-down, which
 * is when a morning brief belongs.
 *
 * What says they're there, none of it needing a permission: a key or the
 * mouse (the system's own count of seconds since either), the screen
 * unlocked, their voice, something typed to him, a hand in view while the
 * camera's already on for gestures, the watch steering. The camera is never
 * opened to look for them.
 *
 *   here   one of those in the last two minutes
 *   near   quiet for longer, but under ten minutes: reading, likely. Or quiet
 *          however long while something keeps the screen awake (a film, a
 *          call), up to three hours
 *   away   the screen locked, the computer asleep, or ten quiet minutes
 *
 * His own typing and clicking would count as theirs (the system can't tell
 * them apart), so main.js says when he's at it (own()), and a key or click in
 * that stretch isn't taken as the user's.
 *
 * A day starts at four in the morning, so working past midnight isn't a new
 * day's first sit-down. Each day's sittings are kept for a week, in the app's
 * own folder, and go nowhere: he's told about them only when asked how long
 * they've been at it (lines()).
 */

import nodeFs from 'node:fs';
import path from 'node:path';

export const HERE_MS = 2 * 60_000;
export const AWAY_MS = 10 * 60_000;
/** With the screen kept awake, quiet this long is still someone watching. */
export const HELD_MS = 3 * 60 * 60_000;
export const TICK_MS = 15_000;
/** The hour a day begins. */
export const DAY_STARTS = 4;
const KEPT_DAYS = 7;
const SAVE_MS = 60_000;
/** What keeps the screen awake is asked no oftener than this. */
const AWAKE_CHECK_MS = 60_000;
/** His own input, and a second or so either side of it, isn't the user's. */
const OWN_BEFORE_MS = 1000;
const OWN_AFTER_MS = 1500;
const OWN_GAP_MS = 2000;
const OWN_SPANS = 400;

const pad = (n) => String(n).padStart(2, '0');

/** The day `at` belongs to, "2026-11-15": the one before, until four in the morning. */
export function dayOf(at) {
  const date = new Date(at - DAY_STARTS * 3600_000);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** "40 minutes", "2 hours 10 minutes", "under a minute". */
export function lasting(ms) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const h = hours ? `${hours} hour${hours === 1 ? '' : 's'}` : '';
  const m = rest ? `${rest} minute${rest === 1 ? '' : 's'}` : '';
  return [h, m].filter(Boolean).join(' ');
}

const clock = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, ' ');

/** Asked how long they've been at it, or away, or when they started: then he's told (lines()). */
export const PRESENCE_WORDS =
  /\b(?:how long (?:have|was|were|did) (?:i|we)\b[^.?!]*\b(?:here|been|working|at (?:it|this|my)|on (?:this|my|the)|gone|away|out|sit|sat|start)|how long i(?:'|’)?ve been|when did i (?:start|sit down|get (?:here|on|in|back)|log (?:on|in)|come back)|what time did i (?:start|sit down|get (?:here|on|in|back)|log (?:on|in))|(?:been|sitting) (?:at|on) (?:this|the|my) (?:laptop|computer|mac|desk|screen)|screen ?time|time (?:at|on) (?:the|this|my) (?:laptop|computer|mac|screen)|(?:take|need|due for|time for) a break|how long (?:since|till|until) (?:my|a) (?:last )?break|was i (?:gone|away)|been (?:gone|away))\b/i;

/**
 * @param {object} deps
 * @param {() => number} deps.idleSeconds  seconds since a key or the mouse, by the system's count
 * @param {() => Promise<boolean|null>} [deps.keptAwake]  whether something's keeping the screen awake; null: can't say
 * @param {string} [deps.file]  presence.json, in the app's own folder; none: nothing's kept
 * @param {(arrival:{at:number, by:string, first:boolean, awayMs:number|null}) => void} [deps.onArrive]
 * @param {(left:{at:number, why:string}) => void} [deps.onLeave]
 * @param {(where:'here'|'near'|'away') => void} [deps.onChange]
 */
export function createPresence({ idleSeconds, keptAwake = async () => null, file = '', fs = nodeFs, now = Date.now, log = () => undefined, onArrive = () => undefined, onLeave = () => undefined, onChange = () => undefined, tickMs = TICK_MS }) {
  /** @type {Record<string, {firstAt:number, sittings:[number, number|null][]}>} */
  let days = {};
  let where = 'away';
  /** The last moment anything said they were there; 0: never seen. */
  let lastSeenAt = 0;
  /** When this sitting began; 0 while away. */
  let sittingSince = 0;
  /** The absence before this sitting: {from, to}. */
  let lastAway = null;
  const shut = new Set();
  /** When the screen was last unlocked or the computer woke: a key from before that isn't them coming back. */
  let openedAt = 0;
  /** The last moment something was seen keeping the screen awake with them near: a film they were at. */
  let watchedAt = 0;
  /**
   * Stretches of his own typing and clicking, the latest last: all of them for as long as one could be mistaken
   * for the user (a read of the screen between two clicks mustn't uncover the first).
   * @type {{from:number, to:number}[]}
   */
  let owns = [];
  /** Things of his own under way right now. */
  let owning = 0;
  /** Quiet, with something keeping the screen awake: a film or a call they're at, as far as can be told. */
  let watching = false;
  let awake = { at: 0, kept: null };
  let savedAt = 0;
  let timer = null;

  function write() {
    if (!file) return;
    savedAt = now();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const next = `${file}.tmp`;
      fs.writeFileSync(next, `${JSON.stringify({ version: 1, lastSeenAt, sittingSince, lastAway, days }, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(next, file);
    } catch (err) {
      log('presence: couldn’t keep the day:', err.message);
    }
  }

  function prune() {
    const keys = Object.keys(days).sort();
    for (const key of keys.slice(0, Math.max(0, keys.length - KEPT_DAYS))) delete days[key];
  }

  /** The sitting going on, in its day's list. */
  const openSitting = () => {
    for (const key of Object.keys(days).sort().reverse()) {
      const open = days[key].sittings.find((sitting) => sitting[1] === null);
      if (open) return open;
    }
    return null;
  };

  function set(next) {
    if (next === where) return;
    where = next;
    onChange(where);
  }

  function arrive(by, at) {
    const key = dayOf(at);
    const first = !days[key];
    // Never before they were last seen: a sitting can't begin inside the one before it.
    at = Math.max(at, lastSeenAt);
    const awayMs = lastSeenAt ? Math.max(0, at - lastSeenAt) : null;
    lastAway = lastSeenAt ? { from: lastSeenAt, to: at } : null;
    days[key] ??= { firstAt: at, sittings: [] };
    days[key].sittings.push([at, null]);
    prune();
    sittingSince = at;
    lastSeenAt = at;
    set('here');
    write();
    log(`presence: here (${by})${first ? ', the day’s first sit-down' : ''}${awayMs === null ? '' : `, after ${lasting(awayMs)} away`}`);
    onArrive({ at, by, first, awayMs });
  }

  /** Gone: the sitting ended when they were last seen, not when it was noticed. */
  function leave(why) {
    if (where === 'away') return;
    watching = false;
    // Quiet through a film, they were at it until it ended, not until they last touched something.
    lastSeenAt = Math.max(lastSeenAt, Math.min(watchedAt, now()));
    const open = openSitting();
    if (open) open[1] = Math.max(open[0], lastSeenAt);
    sittingSince = 0;
    set('away');
    write();
    log(`presence: away (${why})`);
    onLeave({ at: lastSeenAt, why });
  }

  /** Something says they're there. */
  function seen(by, at = now()) {
    // Behind a locked screen or a closed lid, only its opening says so.
    if (shut.size) return;
    watching = false;
    if (where === 'away') return arrive(by, at);
    lastSeenAt = Math.max(lastSeenAt, at);
    set('here');
    if (now() - savedAt >= SAVE_MS) write();
    return undefined;
  }

  /** A key or the mouse, by the system's count, unless it was his own doing. */
  function sample() {
    if (shut.size) return;
    const idle = Number(idleSeconds());
    if (!Number.isFinite(idle) || idle < 0) return;
    const inputAt = now() - idle * 1000;
    // The count is in whole seconds: nothing newer than what's known by less than that is news.
    if (inputAt <= lastSeenAt + 1000 && where !== 'away') return;
    if (owns.some((span, i) => inputAt >= span.from - OWN_BEFORE_MS && inputAt <= (owning > 0 && i === owns.length - 1 ? now() : span.to) + OWN_AFTER_MS)) return;
    // Away, only a key since they were last seen, and since the screen opened, brings them back: the count may go
    // on from before the lid closed, or stand still while it's shut.
    if (where === 'away' && (now() - inputAt >= HERE_MS || inputAt <= lastSeenAt || inputAt <= openedAt)) return;
    seen('keys or mouse', Math.min(now(), inputAt));
  }

  async function screenKeptAwake() {
    if (now() - awake.at < AWAKE_CHECK_MS) return awake.kept;
    awake = { at: now(), kept: await keptAwake().catch(() => null) };
    return awake.kept;
  }

  async function tick() {
    // The computer's clock set back: what was seen isn't in the future.
    if (lastSeenAt > now()) lastSeenAt = now();
    if (watchedAt > now()) watchedAt = 0;
    sample();
    if (where === 'away') return where;
    if (shut.size) {
      leave([...shut][0]);
      return where;
    }
    const quiet = now() - lastSeenAt;
    if (quiet < HERE_MS || quiet < AWAY_MS) watching = false;
    if (quiet < HERE_MS) set('here');
    else if (quiet < AWAY_MS) set('near');
    else if (quiet < HELD_MS && (await screenKeptAwake())) {
      // Someone may have touched it, or the lid closed, while that was asked.
      if (where !== 'away') {
        watchedAt = now();
        if (now() - lastSeenAt >= HERE_MS) {
          watching = true;
          set('near');
        }
      }
    } else if (now() - lastSeenAt >= AWAY_MS) leave(`quiet for ${lasting(quiet)}`);
    return where;
  }

  // Where things stood when he last ran: a sitting carried on if they've been seen since ten minutes ago (he was
  // only restarted), or ended when they were last seen.
  if (file) {
    try {
      const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (stored?.version === 1 && stored.days && typeof stored.days === 'object') {
        for (const [key, day] of Object.entries(stored.days)) {
          if (!/^\d{4}-\d\d-\d\d$/.test(key) || !Number.isFinite(day?.firstAt) || !Array.isArray(day.sittings)) continue;
          days[key] = { firstAt: day.firstAt, sittings: day.sittings.filter((sitting) => Array.isArray(sitting) && Number.isFinite(sitting[0])).map(([from, to]) => [from, Number.isFinite(to) ? to : null]) };
        }
        lastSeenAt = Number.isFinite(stored.lastSeenAt) && stored.lastSeenAt <= now() ? stored.lastSeenAt : 0;
        lastAway = Number.isFinite(stored.lastAway?.from) && Number.isFinite(stored.lastAway?.to) ? { from: stored.lastAway.from, to: stored.lastAway.to } : null;
        const open = openSitting();
        if (open && lastSeenAt && now() - lastSeenAt < AWAY_MS) {
          sittingSince = open[0];
          where = now() - lastSeenAt < HERE_MS ? 'here' : 'near';
        } else if (open) {
          open[1] = Math.max(open[0], lastSeenAt);
        }
        // More than one left open (a crash mid-write) is one too many.
        for (const day of Object.values(days)) for (const sitting of day.sittings) if (sitting[1] === null && sitting !== open) sitting[1] = sitting[0];
        prune();
      }
    } catch {
      /* none yet, or not his: he starts knowing nothing */
    }
  }

  /** How long they've sat on `key`'s day, to `at`. */
  function satOn(key, at) {
    return (days[key]?.sittings || []).reduce((sum, [from, to]) => sum + Math.max(0, (to ?? Math.max(from, Math.min(at, lastSeenAt || at))) - from), 0);
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => tick().catch((err) => log('presence:', err.message)), tickMs);
      timer.unref?.();
      tick().catch((err) => log('presence:', err.message));
    },
    stop() {
      clearInterval(timer);
      timer = null;
      const open = openSitting();
      if (open || lastSeenAt) write();
    },
    /** Something says they're there: 'voice', 'typed', 'camera', 'watch', 'gesture'. */
    seen,
    /** The screen locked or the computer asleep (`shut` true), or neither any more. Unlocking is them, there. */
    screen(reason, isShut) {
      if (isShut) {
        // What they did up to now counts, before the lid's shut on it.
        sample();
        shut.add(reason);
        leave(reason);
      } else {
        const was = shut.delete(reason);
        if (was && !shut.size) openedAt = now();
        if (was && !shut.size && reason === 'locked') seen('unlocked');
      }
    },
    /** He's typing or clicking himself, from now until `done` is called: none of that is the user. */
    own() {
      const at = now();
      const last = owns.at(-1);
      if (last && (owning || at - last.to <= OWN_GAP_MS)) last.to = Math.max(last.to, at);
      else owns.push({ from: at, to: at });
      // Kept as long as a quiet screen can still be someone's: beyond that nothing could be taken for them.
      owns = owns.filter((span) => at - span.to < HELD_MS + AWAY_MS).slice(-OWN_SPANS);
      owning += 1;
      let over = false;
      return () => {
        if (over) return;
        over = true;
        owning -= 1;
        const span = owns.at(-1);
        if (span) span.to = Math.max(span.to, now());
      };
    },
    tick,
    get where() {
      return where;
    },
    /**
     * Near only because something's keeping the screen awake: a film or a call, with nothing touched for ten
     * minutes. Not the moment to speak across it.
     */
    get watching() {
      return where === 'near' && watching;
    },
    /** Where things stand: `quietMs` since they were last seen; `sittingSince` 0 while away. */
    state() {
      const key = dayOf(now());
      return { where, lastSeenAt, quietMs: lastSeenAt ? now() - lastSeenAt : null, sittingSince, firstToday: days[key]?.firstAt || 0, satToday: satOn(key, now()), lastAway: lastAway && { ...lastAway } };
    },
    /** Each kept day: {day, firstAt, sat}. For an evening's look back. */
    days: () => Object.keys(days).sort().map((key) => ({ day: key, firstAt: days[key].firstAt, sat: satOn(key, now()), sittings: days[key].sittings.map((sitting) => [...sitting]) })),
    /**
     * What he's told when asked how long they've been at it: a few lines, saying what it's counted from.
     * @returns {string} '' when nothing's known
     */
    lines() {
      const at = now();
      if (!sittingSince) return '';
      const key = dayOf(at);
      const today = days[key];
      const nights = Math.round((new Date(at).setHours(0, 0, 0, 0) - new Date(sittingSince).setHours(0, 0, 0, 0)) / 864e5);
      const when = `${clock(sittingSince)}${nights === 1 ? ' yesterday' : nights > 1 ? ` ${nights} days ago` : ''}`;
      // Each answer stated outright, a line apiece: a small model given them in one sentence does sums of its own.
      const out = ['How long the user has been at this computer (give these figures as they are, and work out no others):', `- This sitting: since ${when}, which is ${lasting(at - sittingSince)}.`];
      if (lastAway && lastAway.to === sittingSince) out.push(`- Before this sitting they were away from it for ${lasting(lastAway.to - lastAway.from)}.`);
      if (today && today.sittings.length > 1) out.push(`- Today in all: ${lasting(satOn(key, at))}, over ${today.sittings.length} sittings, the first begun at ${clock(today.firstAt)}.`);
      else if (today) out.push('- That is all of today: this is their first sitting.');
      out.push('(Counted from keys, the mouse, unlocking and their voice. Ten minutes with none of them counts as away, unless something was playing.)');
      return out.join('\n');
    }
  };
}

/**
 * Whether something's keeping this Mac's screen awake (a film, a call): `pmset`'s count of what asks for that.
 * @param {(file:string, args:string[]) => Promise<string>} run
 * @returns {Promise<boolean|null>} null where it can't be told (not a Mac, or pmset wouldn't say)
 */
export async function macScreenKeptAwake(run) {
  try {
    const match = /^\s*PreventUserIdleDisplaySleep\s+(\d+)\s*$/m.exec(String(await run('pmset', ['-g', 'assertions'])));
    return match ? Number(match[1]) > 0 : null;
  } catch {
    return null;
  }
}
