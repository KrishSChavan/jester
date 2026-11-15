/**
 * Telling the user something nobody asked for just now: a line whose time has
 * come (a clock.js job of kind "say"). How depends on whether they're there
 * (presence.js):
 *
 *   here or near   he says it, once he's free to: not across his own sentence,
 *                  theirs, or a task at work (tried again in a few seconds)
 *   away           it's held, and said a moment after they're back, with when
 *                  it was for. A phone is where it goes instead, once there is
 *                  one (ntfy, to come).
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
const MOST_CHARS = 600;

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
 */
export function createTeller({ where, announce, release, held, settleMs = SETTLE_MS, busyMs = BUSY_MS, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now, log = () => undefined }) {
  let settling = null;

  return {
    /** The clock's handler for "say" jobs: {payload: {text, late?}}. */
    async say(job, { late = 0, meant = now() } = {}) {
      const text = String(job?.payload?.text ?? '').trim().slice(0, MOST_CHARS);
      // Nothing to say is done with, not tried again.
      if (!text) return undefined;
      if (where() === 'away') {
        if (!job.heldAt) log('telling: they’re away, so a line is held until they’re back');
        return { hold: true };
      }
      // Told late, it says when it was for: in the job's own words for that (payload.late), if it has them.
      const tardy = String(job.payload.late ?? '').trim().slice(0, MOST_CHARS);
      const said = announce(late >= LATE_MS ? tardy || lateLine(text, meant, now()) : text, job.payload.card || null, { untrusted: job.payload.untrusted === true });
      if (!said) return { retryIn: busyMs };
      // Cut off as the screen locked or the lid closed: nobody heard it out, so it's still to tell.
      if ((await said) === false) {
        log('telling: a line was cut off as listening ended, so it’s still to tell');
        return { retryIn: busyMs };
      }
      log(`telling: a line${late >= LATE_MS ? `, ${Math.round(late / 60000)} min late` : ''}`);
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
