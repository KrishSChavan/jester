/**
 * Jester's clock: things to do at a time, kept on disk, so what was due while
 * the computer slept (or while he wasn't running) is done when it wakes, once,
 * and told how late it is. Reminders, the morning brief and anything else that
 * happens by the hour are jobs here; what a job does is its kind's handler,
 * given by whoever knows (main.js).
 *
 * A job is due once (`at`), every day at a time by this computer's clock
 * (`daily`, on `days` of the week if given), or every so often (`everyMs`). A
 * repeating job that was missed several times over runs once, not once for
 * each. `keepFor` says how late it's still worth doing: a daily brief missed
 * by six hours isn't said at three in the afternoon.
 *
 * A handler can answer {hold: true}: not now, and not until release() (the
 * user's away, say, and it's something to tell them: main.js releases what's
 * held when they come back), or {retryIn: ms}: not this moment (he's
 * mid-sentence). One that throws is tried again after a minute, five, then
 * fifteen, and after that given up on.
 *
 * Timers stop while a computer sleeps and fire late after, and its clock can
 * be set or change zone: so nothing is trusted to one long timer. He looks at
 * the time at least every half minute, and when told the computer's awake
 * (wake()), and a daily job's next time is worked out from the wall clock each
 * time it's asked for, never stored.
 */

import nodeFs from 'node:fs';
import path from 'node:path';

/** The longest he goes without looking at the time. */
export const TICK_MS = 30_000;
/** After a handler throws: tried again after these, then given up on. */
export const RETRY_MS = [60_000, 5 * 60_000, 15 * 60_000];
const MOST_JOBS = 500;
/** A handler that hasn't answered in this long never will: the clock goes on without it. */
export const HANDLER_MS = 10 * 60_000;

const dateKey = (ms) => {
  const date = new Date(ms);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
};

/**
 * A daily job's first time after it last ran. Never on the date it last ran for: moved a time zone west, or with
 * the clock set back, this morning's time comes round a second time.
 */
function dailyAfter(job) {
  const first = nextDaily(job.daily, job.last ?? job.made, job.days);
  return job.lastDay && Number.isFinite(first) && dateKey(first) === job.lastDay ? nextDaily(job.daily, first, job.days) : first;
}

const hhmm = (text) => {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(text ?? '').trim());
  return match ? { hour: Number(match[1]), minute: Number(match[2]) } : null;
};

/**
 * The first moment after `after` that's `daily` ("07:30") by this computer's clock, on one of `days` (0 Sunday
 * to 6 Saturday) when given. A time an hour's change skips lands where the clock does (2:30 becomes 3:30).
 * @returns {number} ms, or NaN for a time that isn't one
 */
export function nextDaily(daily, after, days = null) {
  const time = hhmm(daily);
  if (!time || !Number.isFinite(after)) return NaN;
  const on = Array.isArray(days) && days.length ? new Set(days.map(Number)) : null;
  const from = new Date(after);
  for (let ahead = 0; ahead <= 8; ahead++) {
    const then = new Date(from.getFullYear(), from.getMonth(), from.getDate() + ahead, time.hour, time.minute);
    if (then.getTime() > after && (!on || on.has(then.getDay()))) return then.getTime();
  }
  return NaN;
}

/** When a job is next due: its retry, if it's waiting on one. */
export function dueAt(job) {
  if (Number.isFinite(job.retryAt)) return job.retryAt;
  if (job.daily) return dailyAfter(job);
  if (job.everyMs) return (job.last ?? job.made) + job.everyMs;
  return job.at;
}

/**
 * When a job due now was meant for. One that repeats and was missed more than once is meant for the latest of
 * those times: back after two days away, it's this morning's brief that's two hours late, not Thursday's.
 */
export function meantAt(job, at) {
  if (job.daily) {
    const first = dailyAfter(job);
    let meant = first;
    // No further back than a week: `days` leaves at most six out.
    for (let back = 0; back <= 8; back++) {
      const day = new Date(at);
      const then = nextDaily(job.daily, new Date(day.getFullYear(), day.getMonth(), day.getDate() - back).getTime() - 1, job.days);
      if (Number.isFinite(then) && then <= at && then >= first) {
        meant = then;
        break;
      }
    }
    return meant;
  }
  if (job.everyMs) {
    const from = job.last ?? job.made;
    return from + job.everyMs * Math.max(1, Math.floor((at - from) / job.everyMs));
  }
  return job.at;
}

/** A job as kept, or null for one that can't be: no kind, or no time it could ever be due. */
function sound(job) {
  if (!job || typeof job !== 'object' || typeof job.id !== 'string' || !job.id || typeof job.kind !== 'string' || !job.kind) return null;
  if (!Number.isFinite(job.made)) return null;
  const repeats = job.daily ? !!hhmm(job.daily) : Number.isFinite(job.everyMs) && job.everyMs >= 1000;
  if (!repeats && !Number.isFinite(job.at)) return null;
  return job;
}

/**
 * @param {object} deps
 * @param {string} deps.file  jobs.json, in the app's own folder
 * @param {() => number} [deps.now]
 * @param {(fn:Function, ms:number) => any} [deps.setTimer]
 * @param {(timer:any) => void} [deps.clearTimer]
 * @param {number} [deps.tickMs]
 */
export function createClock({ file, fs = nodeFs, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, tickMs = TICK_MS, handlerMs = HANDLER_MS, log = () => undefined }) {
  /** @type {Map<string, object>} */
  const jobs = new Map();
  /** @type {Map<string, Function>} */
  const handlers = new Map();
  const running = new Set();
  const unhandled = new Set();
  let timer = null;
  let started = false;
  let ticking = null;
  let again = false;
  let serial = 0;

  function write() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const next = `${file}.tmp`;
      fs.writeFileSync(next, `${JSON.stringify({ version: 1, jobs: [...jobs.values()] }, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(next, file);
    } catch (err) {
      log('clock: couldn’t keep its jobs:', err.message);
    }
  }

  function read() {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    try {
      const stored = JSON.parse(text);
      for (const job of Array.isArray(stored?.jobs) ? stored.jobs : []) if (sound(job)) jobs.set(job.id, job);
    } catch {
      // Not what he wrote: set aside rather than written over, and he starts with none.
      try {
        fs.renameSync(file, `${file}.unreadable`);
      } catch {
        /* nothing to be done */
      }
      log('clock: its jobs couldn’t be read, so it starts with none');
    }
  }

  const waiting = () => [...jobs.values()].filter((job) => !job.held && !running.has(job.id) && handlers.has(job.kind));

  function arm() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (!started) return;
    const next = Math.min(...waiting().map(dueAt).filter(Number.isFinite));
    if (!Number.isFinite(next)) return;
    timer = setTimer(() => {
      timer = null;
      tick();
    }, Math.max(0, Math.min(next - now(), tickMs)));
  }

  /** Done with, this time round: gone if it was due once, and counted from now if it repeats. */
  function settle(job, meant = NaN) {
    delete job.retryAt;
    delete job.tries;
    delete job.held;
    delete job.heldAt;
    if (job.daily && Number.isFinite(meant)) job.lastDay = dateKey(meant);
    if (job.daily || job.everyMs) job.last = now();
    else jobs.delete(job.id);
  }

  /** The handler's answer, or a throw once it's had longer than any handler should need. */
  function answered(handler, job, info) {
    let limit;
    const late = new Promise((_resolve, reject) => {
      limit = setTimeout(() => reject(new Error(`no answer in ${Math.round(handlerMs / 60000)} min`)), handlerMs);
      limit.unref?.();
    });
    return Promise.race([Promise.resolve().then(() => handler({ ...job }, info)), late]).finally(() => clearTimeout(limit));
  }

  async function run(job) {
    const handler = handlers.get(job.kind);
    // When it was meant for, whatever it's been waiting on since.
    const meant = meantAt(job, now());
    const late = Math.max(0, now() - meant);
    if (Number.isFinite(job.keepFor) && late > job.keepFor) {
      log(`clock: ${job.kind} ${job.id} was due ${Math.round(late / 60000)} min ago, too late to be worth it: skipped`);
      settle(job, meant);
      return;
    }
    running.add(job.id);
    try {
      const answer = await answered(handler, job, { late, held: !!job.heldAt, meant });
      // Taken off the clock while it ran: it stays off.
      if (jobs.get(job.id) !== job) return;
      if (answer?.hold) {
        job.held = true;
        job.heldAt ??= now();
        delete job.retryAt;
      } else if (Number.isFinite(answer?.retryIn) && answer.retryIn > 0) {
        job.retryAt = now() + answer.retryIn;
      } else {
        settle(job, meant);
      }
    } catch (err) {
      if (jobs.get(job.id) !== job) return;
      const tries = (job.tries || 0) + 1;
      if (tries > RETRY_MS.length) {
        log(`clock: ${job.kind} ${job.id} failed ${tries} times (${err.message}): given up on`);
        settle(job, meant);
      } else {
        log(`clock: ${job.kind} ${job.id} failed (${err.message}): again in ${RETRY_MS[tries - 1] / 60000} min`);
        job.tries = tries;
        job.retryAt = now() + RETRY_MS[tries - 1];
      }
    } finally {
      running.delete(job.id);
    }
  }

  /** Everything due is done, the earliest first, one at a time. */
  function tick() {
    if (ticking) {
      again = true;
      return ticking;
    }
    ticking = (async () => {
      // Not before `ticking` is this: with nothing due there'd be no other pause, and it would never be cleared.
      await null;
      try {
        do {
          again = false;
          for (;;) {
            const at = now();
            const due = waiting()
              .filter((job) => dueAt(job) <= at)
              .sort((a, b) => dueAt(a) - dueAt(b))[0];
            if (!due) break;
            await run(due);
            write();
          }
        } while (again);
      } finally {
        ticking = null;
        arm();
      }
    })();
    return ticking;
  }

  read();

  return {
    /** What a kind of job does: `handler(job, {late, held, meant})`, which may answer {hold:true} or {retryIn}. */
    on(kind, handler) {
      handlers.set(kind, handler);
      if (started) tick();
    },
    /** Begins keeping time: what's overdue is done now. */
    start() {
      if (started) return;
      started = true;
      for (const job of jobs.values()) if (!handlers.has(job.kind) && !unhandled.has(job.kind)) (unhandled.add(job.kind), log(`clock: nothing here does “${job.kind}” jobs: kept, not run`));
      const held = [...jobs.values()].filter((job) => job.held).length;
      log(`clock: ${jobs.size} job${jobs.size === 1 ? '' : 's'}${held ? `, ${held} held` : ''}`);
      tick();
    },
    stop() {
      started = false;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
    /**
     * A job: `at` (ms) or `inMs` from now for once; `daily` "HH:MM" (and `days`) or `everyMs` to repeat. One with
     * the `id` of a job there already takes its place.
     * @returns {object|null} the job as kept; null when it has no kind or no time
     */
    add({ id, kind, at, inMs, daily, days, everyMs, keepFor, payload } = {}) {
      const made = now();
      const job = sound({
        id: id ? String(id) : `${kind}-${made.toString(36)}-${(serial++).toString(36)}`,
        kind,
        made,
        ...(daily ? { daily: String(daily), ...(Array.isArray(days) && days.length ? { days: days.map(Number) } : {}) } : Number.isFinite(everyMs) ? { everyMs } : { at: Number.isFinite(at) ? at : Number.isFinite(inMs) ? made + inMs : NaN }),
        ...(Number.isFinite(keepFor) ? { keepFor } : {}),
        ...(payload === undefined ? {} : { payload })
      });
      if (!job || (job.daily && !Number.isFinite(nextDaily(job.daily, made, job.days)))) return null;
      if (!jobs.has(job.id) && jobs.size >= MOST_JOBS) {
        log('clock: full, so that isn’t kept');
        return null;
      }
      jobs.set(job.id, job);
      write();
      if (started) tick();
      return { ...job };
    },
    /** @returns {boolean} whether there was one */
    remove(id) {
      const had = jobs.delete(String(id));
      if (had) {
        write();
        arm();
      }
      return had;
    },
    /** Every job, the soonest first, each with when it's next `due` (NaN while held). */
    list() {
      return [...jobs.values()].map((job) => ({ ...job, due: job.held ? NaN : dueAt(job) })).sort((a, b) => (Number.isFinite(a.due) ? a.due : Infinity) - (Number.isFinite(b.due) ? b.due : Infinity));
    },
    /**
     * What was held is tried again (the user's back), and so is what a handler asked to wait a moment over (a send
     * to their phone being tried again): now, not when its moment's up. Not one that threw: that keeps its time.
     */
    release() {
      let any = false;
      for (const job of jobs.values()) {
        const asked = Number.isFinite(job.retryAt) && !job.tries;
        if (!job.held && !asked) continue;
        delete job.held;
        if (asked) delete job.retryAt;
        any = true;
      }
      if (!any) return Promise.resolve();
      write();
      return started ? tick() : Promise.resolve();
    },
    /** The computer's awake again, or the time may have changed: look now. */
    wake: () => (started ? tick() : Promise.resolve()),
    tick,
    get held() {
      return [...jobs.values()].filter((job) => job.held).length;
    },
    /** How many are waiting a moment at a handler's asking: release() tries those now too. */
    get waiting() {
      return [...jobs.values()].filter((job) => Number.isFinite(job.retryAt) && !job.tries).length;
    }
  };
}
