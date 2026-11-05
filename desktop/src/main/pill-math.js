/**
 * Where a window goes beside the voice pill. Pure, so it's testable with no
 * screen: stop-button.js places its window with it.
 */

/** Between the pill's end and the window beside it. */
export const PILL_GAP = 4;
/** The pill at its narrowest, and how far its middle sits above the usable area's bottom (overlay.css). */
const PILL_WIDTH = 132;
const PILL_MIDDLE = 24 + 46 / 2;

/** Where the pill would end in a display's usable area, for when it hasn't said where it is. */
export function pillEnd(area) {
  return { x: area.x + (area.width + PILL_WIDTH) / 2, y: area.y + area.height - PILL_MIDDLE };
}

/**
 * Bounds for a window just past the pill's right end, level with it and
 * inside the usable area: on a small screen, over the end of the pill.
 * @param {{x:number, y:number}} end  the pill's right end, at its middle
 * @param {{width:number, height:number}} size
 * @param {{x:number, y:number, width:number, height:number}} area
 */
export function besidePill(end, { width, height }, area) {
  const x = Math.round(end.x + PILL_GAP);
  return { width, height, x: Math.max(area.x, Math.min(x, area.x + area.width - width)), y: Math.round(end.y - height / 2) };
}
