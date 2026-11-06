/**
 * The cursor's arithmetic: where an engine frame puts it on a display, when
 * the aim holds still, how it eases between frames, when the real mouse has
 * taken over, and what a click was meant for. Pure, so it is tested without
 * Electron; pointer.js does the moving and clicking.
 */

/** How far closed the hand is before the aim holds still (the extension's CLOSING_FROM). */
export const CLOSING_FROM = 0.25;
/** Looking, or steering, this far past the display is looking away. */
export const AWAY_MARGIN = 40;
/** The mouse this far from where Jester last put it: someone moved it by hand. */
export const MOUSE_SLACK = 6;
/** Easing per 16 ms tick: about 90% of the way across one 50 ms engine frame. */
export const EASE = 0.52;

/** A watch report's angles are in these: ten-thousandths of a radian. */
export const WATCH_UNITS = 10000;
/** Turning slower than this (rad/s), steadied, the hand is holding still. */
export const WATCH_DEAD = 0.012;
/** From here a turn counts in full; below, gradually less, so the slowest aim has no step in it. */
export const WATCH_SURE = 0.035;
/** Below the first speed a turn is precise; above the second it crosses the screen. */
export const WATCH_SLOW = 0.15;
export const WATCH_FAST = 1.6;
/** Pixels per radian at each end: a degree is about 6 px slowly, 45 px quickly. */
export const WATCH_SLOW_GAIN = 340;
export const WATCH_FAST_GAIN = 2600;
/** Steadying: where the filter sits at rest (Hz), well below a hand's tremor of 8 to 12 Hz… */
export const WATCH_CALM_HZ = 1.5;
/** …how fast it opens up with speed (Hz per rad/s)… */
export const WATCH_OPENS_HZ = 30;
/** …how smoothed that speed is (Hz), so that a tremor's back and forth hardly counts as any… */
export const WATCH_PACE_HZ = 4;
/** …and how long it takes to fall (s). It rises at once, so a quick turn doesn't lag, and falling this slowly the filter holds steady through a tremor: following each shake would turn them into a drift. */
export const WATCH_PACE_FALL = 0.3;
/** How long before it's reported a pinch starts moving the cursor, and how far it takes it, at most. */
export const PINCH_LOOKBACK_MS = 180;
export const PINCH_REACH_PX = 40;
/** A pinch's jolt alone, for a hand that didn't stop for it. */
export const JOLT_LOOKBACK_MS = 90;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
/** 0 to 1, with no corners at either end. */
const glide = (t) => t * t * (3 - 2 * t);

/**
 * Where an engine frame puts the cursor on `display` ({x, y, width, height},
 * in Electron's DIPs). An eye-aimed frame describes the screen it was
 * calibrated on; a head-steered one is fractions of whichever screen.
 */
export function placeCursor(cursor, display) {
  const engineScreen = cursor?.display;
  if (cursor?.mode !== 'head' && engineScreen?.w > 0 && (Math.abs(engineScreen.w - display.width) > 1 || Math.abs(engineScreen.h - display.height) > 1)) {
    return { refused: 'Calibrated on a different screen — recalibrate on this one' };
  }
  const x = display.x + Number(cursor.x) * display.width;
  const y = display.y + Number(cursor.y) * display.height;
  const away =
    !!cursor.offscreen ||
    x < display.x - AWAY_MARGIN ||
    y < display.y - AWAY_MARGIN ||
    x > display.x + display.width + AWAY_MARGIN ||
    y > display.y + display.height + AWAY_MARGIN;
  return {
    x: clamp(x, display.x, display.x + display.width - 1),
    y: clamp(y, display.y, display.y + display.height - 1),
    away
  };
}

/**
 * Steadies the watch's reports, with a 1€ filter (Casiez et al., 2012): heavy
 * while the hand is almost still, which takes out its tremor, and out of the
 * way as it speeds up, so a quick turn doesn't lag. It smooths rates rather
 * than places, so a turn still adds up to the same angle, just slightly later.
 */
export function createSteady() {
  let pace = { yaw: 0, pitch: 0 };
  let rate = { yaw: 0, pitch: 0 };
  let speed = 0;
  const towards = (from, to, hz, seconds) => from + (to - from) / (1 + 1 / (2 * Math.PI * hz * seconds));
  return (report) => {
    if (!report?.steering) {
      pace = rate = { yaw: 0, pitch: 0 };
      speed = 0;
      return report;
    }
    const seconds = Math.max(1, Number(report.ms) || 0) / 1000;
    const raw = { yaw: (Number(report.yaw) || 0) / seconds, pitch: (Number(report.pitch) || 0) / seconds };
    pace = { yaw: towards(pace.yaw, raw.yaw, WATCH_PACE_HZ, seconds), pitch: towards(pace.pitch, raw.pitch, WATCH_PACE_HZ, seconds) };
    const smooth = Math.hypot(pace.yaw, pace.pitch) / WATCH_UNITS;
    speed = Math.max(smooth, speed * Math.exp(-seconds / WATCH_PACE_FALL));
    const hz = WATCH_CALM_HZ + WATCH_OPENS_HZ * speed;
    rate = { yaw: towards(rate.yaw, raw.yaw, hz, seconds), pitch: towards(rate.pitch, raw.pitch, hz, seconds) };
    return { ...report, yaw: rate.yaw * seconds, pitch: rate.pitch * seconds, pace: smooth, moving: speed };
  };
}

/**
 * How far a report from the watch moves the cursor. Like a mouse, speed sets
 * the gain: slow turns aim, quick ones travel. While you type, the wrist's
 * movements are the typing's. A steadied report says how fast the hand is
 * really going (`pace`, `moving`): the gain has to follow that, because
 * following each frame's own speed would treat a tremor's two halves
 * differently, and they would stop cancelling out and creep.
 */
export function steerBy(report, { speed = 1, invertY = false } = {}) {
  const yaw = (Number(report?.yaw) || 0) / WATCH_UNITS;
  const pitch = (Number(report?.pitch) || 0) / WATCH_UNITS;
  const rate = Math.hypot(yaw, pitch) / (Math.max(1, Number(report?.ms) || 0) / 1000);
  const pace = report?.pace ?? rate;
  const moving = report?.moving ?? rate;
  if (report?.typing || moving < WATCH_DEAD) return { dx: 0, dy: 0 };
  const sure = glide(clamp((moving - WATCH_DEAD) / (WATCH_SURE - WATCH_DEAD), 0, 1));
  const quick = glide(clamp((pace - WATCH_SLOW) / (WATCH_FAST - WATCH_SLOW), 0, 1));
  const gain = (WATCH_SLOW_GAIN + (WATCH_FAST_GAIN - WATCH_SLOW_GAIN) * quick) * sure * clamp(Number(speed) || 1, 0.4, 2.5);
  return { dx: yaw * gain, dy: (invertY ? pitch : -pitch) * gain };
}

/** `from`, moved, stopping at the edges of `display` ({x, y, width, height}). */
export function moveWithin(from, dx, dy, display) {
  return {
    x: clamp(from.x + dx, display.x, display.x + display.width - 1),
    y: clamp(from.y + dy, display.y, display.y + display.height - 1)
  };
}

/**
 * `from`, moved across `displays` as a mouse crosses them: together they're one
 * space, so it stops only where no screen goes on, and slides along that edge.
 */
export function moveAcross(from, dx, dy, displays) {
  const wanted = { x: from.x + dx, y: from.y + dy };
  let nearest = wanted;
  let gap = Infinity;
  for (const display of displays) {
    const inside = moveWithin(wanted, 0, 0, display);
    const away = Math.hypot(inside.x - wanted.x, inside.y - wanted.y);
    if (away < gap) {
      nearest = inside;
      gap = away;
    }
  }
  return nearest;
}

/** Where the cursor was at `time`, from what it did lately, oldest first. */
export function whereAt(trail, time) {
  return trail.findLast((point) => point.at <= time) || trail[0] || null;
}

/**
 * Where a press at `time` was aimed. Fingers coming together turn the wrist
 * from well before they touch (`Tests/pinch-recording-fingers.csv`: about 13 px
 * in the last 100 ms), so it looks back past all that. A hand that had gone
 * further than a pinch does was travelling, and that far back it was somewhere
 * else, so then it looks back only as far as the jolt.
 */
export function whereAimed(trail, time) {
  const before = whereAt(trail, time - PINCH_LOOKBACK_MS);
  const reached = whereAt(trail, time);
  if (!before || Math.hypot(reached.x - before.x, reached.y - before.y) <= PINCH_REACH_PX) return before;
  return whereAt(trail, time - JOLT_LOOKBACK_MS);
}

/** A hand on its way to a fist: from here the click lands where it was aimed. */
export function isClosing(cursor) {
  return !!cursor?.click || !!cursor?.down || (Number(cursor?.progress) || 0) >= CLOSING_FROM;
}

/** One tick of easing from where the cursor is towards where it is aimed. */
export function easeToward(from, to, k = EASE) {
  if (!from) return { x: to.x, y: to.y };
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.hypot(dx, dy) < 0.5) return { x: to.x, y: to.y };
  return { x: from.x + dx * k, y: from.y + dy * k };
}

/** Whether the mouse is somewhere Jester didn't put it. */
export function movedByHand(actual, lastSet, slack = MOUSE_SLACK) {
  return !!actual && !!lastSet && Math.hypot(actual.x - lastSet.x, actual.y - lastSet.y) > slack;
}

/** Where to look around an aim point: the point, then two rings, as the extension does. */
export function probePoints(x, y, radius, perRing = 8) {
  const points = [{ x, y }];
  for (const [ring, turn] of [[0.5, 0], [1, Math.PI / perRing]]) {
    for (let i = 0; i < perRing; i++) {
      const angle = (i / perRing) * 2 * Math.PI + turn;
      points.push({ x: x + Math.cos(angle) * radius * ring, y: y + Math.sin(angle) * radius * ring });
    }
  }
  return points;
}

export function frameHolds(frame, point) {
  return !!frame && point.x >= frame.x && point.x <= frame.x + frame.w && point.y >= frame.y && point.y <= frame.y + frame.h;
}

/**
 * What a click at `point` was meant for, given the frames of the pressable
 * things found around it: the one under the point; else the nearest within
 * `radius`; the smaller of equals (the button, not the toolbar holding it).
 * Returns where to click — the point itself when it is already on the target,
 * else the target's centre — or null to click where aimed.
 */
export function chooseTarget(frames, point, radius) {
  let best = null;
  for (const frame of frames) {
    if (!frame || !(frame.w > 0) || !(frame.h > 0)) continue;
    const dx = Math.max(frame.x - point.x, 0, point.x - (frame.x + frame.w));
    const dy = Math.max(frame.y - point.y, 0, point.y - (frame.y + frame.h));
    const distance = Math.hypot(dx, dy);
    if (distance > radius) continue;
    const area = frame.w * frame.h;
    if (!best || distance < best.distance || (distance === best.distance && area < best.area)) best = { frame, distance, area };
  }
  if (!best) return null;
  if (best.distance === 0) return { x: point.x, y: point.y, frame: best.frame };
  return { x: best.frame.x + best.frame.w / 2, y: best.frame.y + best.frame.h / 2, frame: best.frame };
}
