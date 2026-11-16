/**
 * A timer's ringing. When a timer ends with the user there to hear it, he says
 * so once, and then it rings until it's turned off: by saying so ("stop",
 * "turn it off", "okay", with his name or without), by a gesture, or by a
 * click, on the small pill that rings (ring-page.js), on the timer's card in
 * his window, or in his menu. Left alone, it stops by itself after a minute:
 * they were told, and a room that's empty isn't rung at for good.
 *
 * Only timers ring. A reminder is said, and waits to be ticked off.
 *
 * Pure: what rings and shows is `page` (show, hide), so this runs in a test.
 */

/** How long it rings with nobody turning it off. */
export const RING_MS = 60_000;

const THING = '(?:it|that|this|the (?:timer|alarm|ringing|ring|beeping|beep|noise|sound))';
/**
 * Words that turn it off, said as all of what was said, once or over again: "stop", "okay, turn it off", "stop,
 * stop!", "thanks", "I'm up". Nothing here does anything else, so a voice that only may be theirs is taken at its
 * word.
 */
const WORD =
  `(?:stop(?: ${THING}| ringing| beeping)?|(?:turn|shut|switch) ${THING} off|(?:turn|shut|switch) off(?: ${THING})?|silence(?: ${THING})?|` +
  `dismiss(?: ${THING})?|cancel(?: ${THING})?|shut up|be quiet|quiet|enough|that(?:'?s| is) enough|never ?mind|(?:i )?got it|thanks?(?: you)?|` +
  `ok(?:ay)?|alright|all right|i(?:'?m| am) (?:up|coming|here|awake)|done)`;
export const RING_STOP = new RegExp(`^\\W*(?:(?:hey|jester|please|yes|yeah|yep)\\W+)*${WORD}(?:\\W+(?:${WORD}|please|now|already|jester))*\\W*$`, 'i');

/** Whether what was said, in whole, turns a ringing timer off. */
export const ringStopAsked = (text) => RING_STOP.test(String(text ?? '').replace(/[’‘]/g, "'").trim());

/**
 * @param {object} deps
 * @param {{show:(label:string) => void, hide:() => void}} deps.page  what rings and can be clicked (ring-page.js)
 * @param {number} [deps.ringMs]
 * @param {() => void} [deps.onChange]  it began or ended: his window's cards and his menu follow
 */
export function createRing({ page, ringMs = RING_MS, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, log = () => undefined, onChange = () => undefined }) {
  /** @type {{id:string, label:string, since:number, timer:any}|null} */
  let ringing = null;

  /** @param {string} [by]  who or what turned it off, for the log  @returns {boolean} whether it was ringing */
  function stop(by = '') {
    if (!ringing) return false;
    clearTimer(ringing.timer);
    const rang = now() - ringing.since;
    ringing = null;
    page.hide();
    log(`ring: stopped${by ? ` by ${by}` : ''}, after ${Math.round(rang / 1000)} s`);
    onChange();
    return true;
  }

  return {
    /** A timer's up, and said: it rings. One ringing already gives way to it. */
    start({ id, label }) {
      if (ringing) clearTimer(ringing.timer);
      const again = !!ringing;
      ringing = { id: String(id ?? ''), label: String(label || 'Timer').slice(0, 60), since: now(), timer: setTimer(() => stop('itself, unanswered'), ringMs) };
      page.show(ringing.label);
      if (!again) log('ring: a timer is ringing');
      onChange();
    },
    stop,
    /** What's ringing, for his window and his menu; null when nothing is. */
    get ringing() {
      return ringing ? { id: ringing.id, label: ringing.label, since: ringing.since } : null;
    }
  };
}
