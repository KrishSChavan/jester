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
 *
 * The Apple Watch steers it too (watch.js): it says how far rather than where,
 * and while it does, the engine's frames wait. It moves over every display, as
 * a mouse does, and it can press: thumb and finger meeting, or a finger on its
 * button, is the mouse button down, and parting or lifting is the mouse button
 * up. So a quick press clicks, and a hold drags. A second quick one at the same
 * spot double-clicks, or if the hand then moves, picks up what's there until the
 * next one puts it down. A hold with all fingers carries the whole window
 * instead, outlined, leaving the mouse button out of it.
 */

import { screen } from 'electron';
import { toDipFrame, toOsPoint } from './driver.js';
import { chooseTarget, easeToward, frameHolds, isClosing, moveAcross, movedByHand, placeCursor, probePoints, whereAimed, whereAt } from './pointer-math.js';

const TICK_MS = 16;
/** No frame for this long and the cursor is put down (the extension's POINTER_IDLE_MS). */
const IDLE_MS = 1200;
/** After the real mouse moves, Jester leaves the cursor alone this long. */
const HAND_PAUSE_MS = 1500;
/** Aim assist looks this far around the point, at most: further is a different target. */
const MAX_ASSIST_PX = 120;
const MIN_ASSIST_PX = 16;
/** Positions remembered, about 400 ms of them. */
const TRAIL_LENGTH = 24;
/** Letting go is felt the moment it happens, so a drop only makes up for the radio. */
const DROP_LOOKBACK_MS = 40;
/** A pinch jolts the hand, so a watch click lands where the cursor just was (`whereAimed`), and the cursor waits that out. */
const PINCH_SETTLE_MS = 120;
/** Moving this far in one report is the arm at work, not a tremor. For this long after, it's still the arm that moved. */
const AIMING_PX = 1;
const AIMING_MS = 800;
/** The watch aims well: this only catches a near miss, not a button it wasn't pointed at. */
const WATCH_ASSIST_PX = MIN_ASSIST_PX;
/** A second pinch this soon, this close to the first, makes a pair. */
const PAIR_MS = 650;
const PAIR_PX = 16;
/** After a pair: moving this far within this long makes it a drag, otherwise it's a double-click. */
const GRAB_WAIT_MS = 300;
const GRAB_MOVE_PX = 5;
/** Pressed this long with no letting go is held: time for the watch to feel a quick pinch's fingers part. */
const HOLD_MS = 300;

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
  /** Where Jester put it lately: a move can still be on its way to the OS some ticks later. */
  let trail = [];
  /** The watch has the cursor. */
  let steered = false;
  /** The watch's last click, for a second pinch to pair with. */
  let clicked = null;
  /** A pair of pinches, or the button held, until it's clear what it means. */
  let waiting = null;
  /** The watch's button is under a finger. */
  let pressing = false;
  /** The mouse button is down: moving now drags. */
  let grabbed = false;
  /** When the pinch that will put it down began: 0 for a hold, which only has to be let go. */
  let puttingDownAt = 0;
  /** Motion from the watch until then is a pinch's jolt. */
  let settledAt = 0;
  /** When the watch's arm last moved. */
  let movedAt = 0;
  /** The press going on is all fingers: a hold carries the window. */
  let whole = false;
  /** The window being carried: {from, frame} once it's found, and whether a move is on its way. */
  let carrying = null;
  let pausedUntil = 0;
  /** Where a hand last left it: the watch waits for as long as that keeps changing. */
  let handAt = null;
  let idleTimer = null;
  let ticker = null;
  let look = {};
  let clicking = false;
  let lastRefusal = '';

  /** Up goes the mouse button, at `at` or wherever the cursor is. Never left down: the OS would stay mid-drag. */
  function letGo(at) {
    if (!grabbed) return;
    grabbed = false;
    puttingDownAt = 0;
    driver.call('button', { ...(at && toOsPoint(screen, at)), down: false }).catch(() => undefined);
  }

  /** Puts down the window being carried, where it is: nothing else needs saying. */
  function putDown() {
    if (!carrying) return;
    carrying = null;
    look = { ...look, down: false };
    overlays.outline?.(null);
  }

  function end() {
    letGo();
    putDown();
    active = steered = pressing = false;
    clearInterval(ticker);
    clearTimeout(idleTimer);
    ticker = null;
    target = frozen = lastSet = clicked = waiting = null;
    settledAt = 0;
    trail = [];
    overlays.cursor(null);
  }

  /** Keep the cursor moving between frames, and put it down if they stop. */
  function keepUp() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(end, IDLE_MS);
    active = true;
    if (!ticker) ticker = setInterval(tick, TICK_MS);
  }

  function remember(point, at) {
    trail = [...trail.slice(1 - TRAIL_LENGTH), { x: point.x, y: point.y, at }];
  }

  /** 60 times a second while the cursor is up: ease towards the aim, unless a hand is on the mouse. */
  function tick() {
    if (!active || !target) return;
    const now = Date.now();
    const actual = whereIsIt();
    // Where Jester put it just now: anywhere else, a hand moved it.
    if (trail.length && trail.every((point) => movedByHand(actual, point))) {
      pausedUntil = now + HAND_PAUSE_MS;
      handAt = actual;
      lastSet = null;
      trail = [];
      // The watch's moves add to where the cursor is, which isn't there any more.
      if (steered) {
        letGo();
        putDown();
        target = frozen = clicked = waiting = null;
      }
    }
    if (now < pausedUntil) return overlays.cursor(null);
    if (waiting && now >= waiting.until && !clicking) decide();
    // Where it starts from counts too, for as long as the first move takes to land.
    if (!lastSet && actual) remember(actual, now);
    const next = easeToward(lastSet || actual || target, frozen || target);
    const moved = !lastSet || Math.hypot(next.x - lastSet.x, next.y - lastSet.y) >= 0.5;
    lastSet = next;
    if (moved) {
      remember(next, now);
      driver.call('move', toOsPoint(screen, next)).catch(() => undefined);
      carry(next);
    }
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
      remember(point, Date.now());
      overlays.ripple(point);
      if (choice && choice.x !== at.x) log('aim assist moved the click', Math.round(Math.hypot(choice.x - at.x, choice.y - at.y)), 'px');
    } catch (err) {
      toast('Not clicked', { tone: 'warn', detail: err.message });
    } finally {
      clicking = false;
    }
  }

  /** Where the hand was aiming, before what it just felt jolted it. */
  const aimedAt = (now) => whereAimed(trail, now) || lastSet || target;

  /** How far the cursor had got from `at`: what a press took back. Asked at the press, as it's held there after. */
  const joltFrom = (at) => (lastSet ? Math.round(Math.hypot(lastSet.x - at.x, lastSet.y - at.y)) : 0);

  /** A click from the watch: aim held at `at`, then steering goes on from where it landed. */
  async function clickHere(at, now, jolt) {
    clicked = { point: at, at: now };
    frozen = at;
    await click(WATCH_ASSIST_PX);
    log('watch click: the pinch had moved it', jolt, 'px');
    if (!steered) return;
    if (clicked) clicked.point = lastSet || at;
    if (!waiting) frozen = null;
    target = lastSet || target;
  }

  /** A quick press from the watch. */
  function pinched(now, at = aimedAt(now), jolt = joltFrom(at)) {
    settledAt = now + PINCH_SETTLE_MS;
    if (grabbed) {
      letGo(at);
      log('watch drop: taken back', jolt, 'px');
      target = at;
      return;
    }
    if (waiting) return;
    if (clicked && now - clicked.at < PAIR_MS && Math.hypot(at.x - clicked.point.x, at.y - clicked.point.y) <= PAIR_PX) {
      frozen = clicked.point;
      waiting = { point: clicked.point, until: settledAt + GRAB_WAIT_MS, travel: 0 };
      clicked = null;
      return;
    }
    clickHere(at, now, jolt);
  }

  /** The window under `point` is picked up, by way of the driver, which keeps hold of it. */
  async function takeWindow(point) {
    const taken = {};
    carrying = taken;
    look = { ...look, down: true };
    try {
      const reply = await overlays.whileHidden(() => driver.call('windowAt', toOsPoint(screen, point)));
      const frame = toDipFrame(screen, reply?.frame);
      if (!frame) throw new Error('there\'s no window here');
      if (carrying !== taken) return;
      taken.from = point;
      taken.frame = frame;
      overlays.outline?.(frame);
      log('watch carrying window', reply.title || '');
    } catch (err) {
      if (carrying === taken) putDown();
      toast('No window to move', { tone: 'warn', detail: err.message });
    }
  }

  /** The carried window goes where the cursor has. One move at a time, the latest: an app can be slow. */
  function carry(at) {
    if (!carrying?.frame) return;
    const taken = carrying;
    const frame = { ...taken.frame, x: taken.frame.x + at.x - taken.from.x, y: taken.frame.y + at.y - taken.from.y };
    overlays.outline?.(frame);
    taken.next = frame;
    if (taken.moving) return;
    taken.moving = true;
    const send = () => {
      const place = taken.next;
      taken.next = null;
      driver.call('moveWindow', toOsPoint(screen, place))
        .catch((err) => log('watch window move:', err.message))
        .finally(() => {
          if (taken.next) send();
          else taken.moving = false;
        });
    };
    send();
  }

  /** Fingers meet, or one comes down on the watch's button. */
  function pressed(now) {
    if (grabbed) puttingDownAt = now;
    if (grabbed || waiting || carrying) return;
    const point = aimedAt(now);
    frozen = point;
    settledAt = now + PINCH_SETTLE_MS;
    waiting = { point, until: now + HOLD_MS, travel: 0, held: true, jolt: joltFrom(point) };
  }

  /** …and part: the end of a drag, or else it was only quick. */
  function released(now) {
    if (carrying) return putDown();
    if (grabbed) return pinched(now, puttingDownAt ? aimedAt(puttingDownAt) : whereAt(trail, now - DROP_LOOKBACK_MS) || lastSet || target);
    if (!waiting?.held) return undefined;
    const { point, jolt } = waiting;
    waiting = null;
    frozen = null;
    return pinched(now, point, jolt);
  }

  /** The mouse button goes down where it was aimed. */
  function grab() {
    const { point, jolt = 0 } = waiting;
    waiting = frozen = clicked = null;
    grabbed = true;
    target = point;
    look = { ...look, down: true };
    log('watch drag: the pinch had moved it', jolt, 'px');
    driver.call('button', { ...toOsPoint(screen, point), down: true }).catch((err) => {
      grabbed = false;
      toast('Not clicked', { tone: 'warn', detail: err.message });
    });
  }

  /** The other half of a double-click: its first click has already landed. */
  async function clickAgain(point) {
    clicking = true;
    const at = toOsPoint(screen, point);
    try {
      await driver.call('button', { ...at, down: true, count: 2 });
      await driver.call('button', { ...at, down: false, count: 2 });
      overlays.ripple(point);
    } catch (err) {
      toast('Not clicked', { tone: 'warn', detail: err.message });
    } finally {
      clicking = false;
    }
  }

  /** The wait is over with no move: held is held, and a pair is a double-click. */
  function decide() {
    const { point, held } = waiting;
    if (held && whole) {
      waiting = frozen = clicked = null;
      target = point;
      return takeWindow(point);
    }
    if (held) return grab();
    waiting = frozen = null;
    target = point;
    return clickAgain(point);
  }

  return {
    /** One `jester/cursor` frame from the engine. */
    frame(cursor) {
      if (steered) return undefined;
      // Hidden: a fist held on after its click is done with the cursor.
      if (!cursor?.active || cursor.hidden) return end();
      const where = placeCursor(cursor, display().bounds);
      if (where.refused) {
        if (where.refused !== lastRefusal) toast(where.refused, { tone: 'warn' });
        lastRefusal = where.refused;
        return end();
      }
      lastRefusal = '';
      keepUp();
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
    /** One report from the watch, as pixels (`steerBy`). A hand on the mouse outranks it, clicks included. */
    nudge({ dx = 0, dy = 0, click: pinch = false, held = false, whole: allFingers = false, steering = true }) {
      if (!steering) return steered ? end() : undefined;
      steered = true;
      keepUp();
      const now = Date.now();
      if (Math.hypot(dx, dy) >= AIMING_PX) movedAt = now;
      if (now < pausedUntil) {
        const actual = whereIsIt();
        if (movedByHand(actual, handAt, 0)) pausedUntil = now + HAND_PAUSE_MS;
        handAt = actual;
        return undefined;
      }
      look = { progress: 0, down: grabbed || !!carrying, head: true, away: false };
      whole = allFingers;
      const { bounds } = display();
      target ||= whereIsIt() || { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      if (pinch) pinched(now);
      if (held !== pressing) {
        pressing = held;
        if (held) pressed(now);
        else released(now);
      }
      if (clicking || now < settledAt || waiting?.held) return undefined;
      if (waiting) {
        waiting.travel += Math.hypot(dx, dy);
        if (waiting.travel < GRAB_MOVE_PX) return undefined;
        grab();
      }
      target = moveAcross(target, dx, dy, screen.getAllDisplays().map((each) => each.bounds));
      return undefined;
    },
    /** The watch's arm is moving, or only just stopped: what the camera sees of it now is aiming. */
    aiming: () => Date.now() - movedAt < AIMING_MS,
    end
  };
}
