/**
 * Telling the user something nobody asked for just now: a line whose time has
 * come (a clock.js job of kind "say"). How depends on whether they're there
 * (presence.js):
 *
 *   here           he says it, once he's free to: not across his own sentence,
 *                  theirs, or a task at work (tried again in a few seconds)
 *   near           said the same, and sent to their phone as well (phone.js):
 *                  quiet for a few minutes, they may have stepped out
 *   watching       near only because a film or a call is keeping the screen
 *                  awake: sent to their phone and shown on the screen, and
 *                  not said across it. With no phone to take it, it's said
 *   away           sent to their phone, and that's it told. With no phone set
 *                  up, or the send failing, it's held, and said a moment after
 *                  they're back, with when it was for
 *
 * Held lines are the clock's to keep, so they outlast a restart. What's told
 * goes in the conversation like anything he says, so "thanks" or "what was
 * that?" has something to follow. The log says that a line was told and how
 * late, never what it said.
 */

/** Back at the computer, they get this long before he speaks. */
export const SETTLE_MS = 8000;
/** Mid-sentence, or theirs: asked again after this. */
export const BUSY_MS = 5000;
/** Later than this, a line says when it was for. */
export const LATE_MS = 2 * 60_000;
/** A send the server refused or that never reached it is tried again after this, this many times, before the line's held. */
export const PHONE_RETRY_MS = 30_000;
export const PHONE_TRIES = 3;
const MOST_CHARS = 900;

const clock = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, ' ');
const dayStart = (ms) => {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
};

/** A line told late says when it was for: "This was for 3:05 PM: …", "This was for yesterday at 3:05 PM: …". */
export function lateLine(text, meant, at) {
  const days = Math.round((dayStart(at) - dayStart(meant)) / 864e5);
  const when = days <= 0 ? clock(meant) : days === 1 ? `yesterday at ${clock(meant)}` : `${new Date(meant).toLocaleDateString('en-US', { weekday: 'long' })} at ${clock(meant)}`;
  return `This was for ${when}: ${text}`;
}

/**
 * @param {object} deps
 * @param {() => 'here'|'near'|'away'} deps.where
 * @param {(text:string, card:object|null, more:{untrusted:boolean}) => Promise<boolean|void>|null} deps.announce  says it
 *   (with the job's `payload.card`, for his window to show, and whether it holds other people's words, `payload.untrusted`),
 *   and answers false when it was cut off with
 *   nobody listening; null when now isn't the moment
 * @param {() => Promise<void>} deps.release  what's held is tried again (clock.js)
 * @param {() => number} deps.held  how many are
 * @param {(message:{title:string, text:string, priority:number}) => Promise<boolean|{went:boolean, again:boolean}>} [deps.phone]
 *   to their phone: whether it went, and if not whether trying again is safe (phone.js; not set up, neither)
 * @param {() => boolean} [deps.watching]  something's playing that he shouldn't speak across (presence.js)
 * @param {(text:string, title:string, card:object|null, more:{untrusted:boolean}) => void} [deps.show]  on the screen,
 *   for when it isn't said
 */
export function createTeller({ where, announce, release, held, phone = async () => false, watching = () => false, show = () => undefined, settleMs = SETTLE_MS, busyMs = BUSY_MS, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now, log = () => undefined }) {
  let settling = null;
  /** Sends that didn't reach the phone, by job: tried again a few times before the line's held. */
  const tries = new Map();

  return {
    /** The clock's handler for "say" jobs: {payload: {text, late?}}. */
    async say(job, { late = 0, meant = now() } = {}) {
      const text = String(job?.payload?.text ?? '').trim().slice(0, MOST_CHARS);
      // Nothing to say is done with, not tried again.
      if (!text) return undefined;
      // Told late, it says when it was for: in the job's own words for that (payload.late), if it has them.
      const tardy = String(job.payload.late ?? '').trim().slice(0, MOST_CHARS);
      const line = late >= LATE_MS ? tardy || lateLine(text, meant, now()) : text;
      // What goes to a phone: `payload.phone` false keeps a line off it (the morning's brief is for sitting down to).
      const message = { title: String(job.payload.title || 'Jester').slice(0, 80), text: line, priority: Number(job.payload.priority) || 3 };
      const off = { went: false, again: false };
      const phoned = async () => {
        if (job.payload.phone === false) return off;
        const out = await Promise.resolve(phone(message)).catch(() => off);
        return out === true ? { went: true, again: false } : out && typeof out === 'object' ? out : off;
      };
      const place = where();
      if (place === 'away') {
        const sent = await phoned();
        if (sent.went) {
          tries.delete(job.id);
          log('telling: a line, to their phone');
          return undefined;
        }
        // Refused, or the server not reached (the network not up yet, just after waking): tried again, a few times.
        const tried = (tries.get(job.id) || 0) + 1;
        if (sent.again && tried < PHONE_TRIES) {
          tries.set(job.id, tried);
          return { retryIn: PHONE_RETRY_MS };
        }
        tries.delete(job.id);
        if (!job.heldAt) log('telling: they’re away, so a line is held until they’re back');
        return { hold: true };
      }
      // A film or a call: if their phone takes it, it's shown here too and never said across what's playing. With
      // no phone to take it, it's said all the same: a timer missed is worse than a film interrupted.
      if (watching() && (await phoned()).went) {
        show(line, message.title, job.payload.card || null, { untrusted: job.payload.untrusted === true });
        log('telling: a line, shown and not said: something’s playing');
        return undefined;
      }
      const said = announce(line, job.payload.card || null, { untrusted: job.payload.untrusted === true });
      if (!said) return { retryIn: busyMs };
      // Cut off as the screen locked or the lid closed: nobody heard it out, so it's still to tell.
      if ((await said) === false) {
        log('telling: a line was cut off as listening ended, so it’s still to tell');
        return { retryIn: busyMs };
      }
      log(`telling: a line${late >= LATE_MS ? `, ${Math.round(late / 60000)} min late` : ''}`);
      // Quiet for a few minutes, and still so now it's said, they may not be in the room: to their phone as well.
      if (place === 'near' && where() === 'near' && !watching()) phoned();
      return undefined;
    },
    /** Where they are has changed: back, what was held is told once they've had a moment. */
    moved(next) {
      if (next === 'away') {
        if (settling !== null) clearTimer(settling);
        settling = null;
        return;
      }
      if (next !== 'here' || settling !== null || !held()) return;
      settling = setTimer(() => {
        settling = null;
        if (where() !== 'away') release().catch((err) => log('telling: couldn’t tell what was held:', err.message));
      }, settleMs);
    }
  };
}
