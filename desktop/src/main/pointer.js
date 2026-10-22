/**
 * The real cursor, steered by the engine: eyes or head aim it, an open palm
 * raises it, closing the hand clicks — the extension's page cursor, made the
 * computer's own.
 *
 * The engine sends about 20 frames a second; the cursor eases between them at
 * 60. While the hand closes the aim holds still, so the click lands where you
 * aimed. Moving the real mouse hands the cursor back to it for a moment.
 * A click looks around the aim point for the button you meant (the
 * extension's aim assist, through the accessibility tree), with the overlay
 * hidden while it looks: macOS can't see through it.
 */

import { screen } from 'electron';
import { toDipFrame, toOsPoint } from './driver.js';
import { chooseTarget, easeToward, frameHolds, isClosing, movedByHand, placeCursor, probePoints } from './pointer-math.js';

const TICK_MS = 16;
/** No frame for this long and the cursor is put down (the extension's POINTER_IDLE_MS). */
const IDLE_MS = 1200;
/** After the real mouse moves, Jester leaves the cursor alone this long. */
const HAND_PAUSE_MS = 1500;
/** Aim assist looks this far around the point, at most: further is a different target. */
const MAX_ASSIST_PX = 120;
const MIN_ASSIST_PX = 16;

/**
 * @param {object} deps
 * @param {{call: Function}} deps.driver
 * @param {object} deps.overlays  overlay.js
 * @param {() => Electron.Display} deps.display  the display the engine aims at
 * @param {(text:string, options?:object) => void} deps.toast
 * @param {(...parts:any[]) => void} [deps.log]
 * @param {boolean} [deps.dryRun]  the driver only describes input: the real cursor never moves
 */
export function createPointer({ driver, overlays, display, toast, log = () => undefined, dryRun = false }) {
  // With a dry-run driver the real cursor stays put, which would look like a hand on the mouse.
  const whereIsIt = () => (dryRun ? lastSet : screen.getCursorScreenPoint());
  let active = false;
  let target = null;
  let frozen = null;
  let lastSet = null;
  /** The position before lastSet: a move can still be on its way to the OS a tick later. */
  let prevSet = null;
  let pausedUntil = 0;
  let idleTimer = null;
  let ticker = null;
  let look = {};
  let clicking = false;
  let lastRefusal = '';

  function end() {
    active = false;
    clearInterval(ticker);
    clearTimeout(idleTimer);
    ticker = null;
    target = frozen = lastSet = prevSet = null;
    overlays.cursor(null);
  }

  /** 60 times a second while the cursor is up: ease towards the aim, unless a hand is on the mouse. */
  function tick() {
    if (!active || !target) return;
    const now = Date.now();
    const actual = whereIsIt();
    // Where Jester put it this tick or the last: anywhere else, a hand moved it.
    if (movedByHand(actual, lastSet) && (!prevSet || movedByHand(actual, prevSet))) {
      pausedUntil = now + HAND_PAUSE_MS;
      lastSet = prevSet = null;
    }
    if (now < pausedUntil) return overlays.cursor(null);
    const next = easeToward(lastSet || whereIsIt() || target, frozen || target);
    const moved = !lastSet || Math.hypot(next.x - lastSet.x, next.y - lastSet.y) >= 0.5;
    if (moved) prevSet = lastSet;
    lastSet = next;
    if (moved) driver.call('move', toOsPoint(screen, next)).catch(() => undefined);
    overlays.cursor({ ...next, ...look });
  }

  /** What the click was for: the pressable thing under the aim, or the nearest one around it. */
  async function aim(at, errorPx) {
    const radius = Math.min(MAX_ASSIST_PX, Math.max(MIN_ASSIST_PX, Number(errorPx) || 0));
    const frames = [];
    for (const [i, point] of probePoints(at.x, at.y, radius).entries()) {
      const os = toOsPoint(screen, point);
      const reply = await driver.call('elementAt', { x: os.x, y: os.y, wait: false }).catch(() => null);
      const frame = toDipFrame(screen, reply?.actionable?.frame);
      if (frame) frames.push(frame);
      // Already on something pressable: no need to look around.
      if (i === 0 && frameHolds(frame, at)) break;
    }
    return chooseTarget(frames, at, radius);
  }

  async function click(errorPx) {
    if (clicking) return;
    clicking = true;
    const at = frozen || lastSet || target;
    try {
      const choice = await overlays.whileHidden(() => aim(at, errorPx)).catch(() => null);
      const point = choice ? { x: choice.x, y: choice.y } : at;
      await driver.call('click', toOsPoint(screen, point));
      lastSet = point;
      overlays.ripple(point);
      if (choice && choice.x !== at.x) log('aim assist moved the click', Math.round(Math.hypot(choice.x - at.x, choice.y - at.y)), 'px');
    } catch (err) {
      toast('Not clicked', { tone: 'warn', detail: err.message });
    } finally {
      clicking = false;
    }
  }

  return {
    /** One `jester/cursor` frame from the engine. */
    frame(cursor) {
      // Hidden: a fist held on after its click is done with the cursor.
      if (!cursor?.active || cursor.hidden) return end();
      const where = placeCursor(cursor, display().bounds);
      if (where.refused) {
        if (where.refused !== lastRefusal) toast(where.refused, { tone: 'warn' });
        lastRefusal = where.refused;
        return end();
      }
      lastRefusal = '';
      clearTimeout(idleTimer);
      idleTimer = setTimeout(end, IDLE_MS);
      active = true;
      if (!ticker) ticker = setInterval(tick, TICK_MS);
      // A refused click is an event, said every time (no face, looking away).
      if (cursor.refused) toast(cursor.refused, { tone: 'warn' });

      const closing = isClosing(cursor);
      if (!closing) frozen = null;
      else if (!frozen) frozen = lastSet || { x: where.x, y: where.y };
      // Looking away, the cursor waits where it was.
      if (!where.away || !target) target = { x: where.x, y: where.y };
      look = { progress: Number(cursor.progress) || 0, down: !!cursor.down, head: cursor.mode === 'head', away: where.away };

      if (cursor.click) {
        if (where.away) toast('Not clicked — the cursor was off the screen', { tone: 'warn' });
        else click(cursor.errorPx);
      }
    },
    end
  };
}
