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

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

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
