/**
 * The numbers drawn on a picture of the window, for a model that can see it
 * (Set-of-Marks, as the extension's screenshots have): each control's own id
 * in a yellow box on it, the same id its screen line has, so the model acts
 * on what it saw with the ids it already knows.
 *
 * Pure: controls and their boxes in the picture in; which are numbered, and
 * the numbers painted into raw pixels, out.
 */

import { goalWords, hasWord } from './screen.js';

/** More than this and the numbers would hide what the picture is for. */
export const MAX_MARKS = 60;
/** Words, not controls: nothing to press. */
const UNMARKED = new Set(['text', 'heading']);
/** Smaller than this in the picture, a box can't be seen to hold anything. */
const MIN_SIDE = 4;

/** Digits 0-9, five pixels by seven, a row to a number (the left pixel the high bit). */
const DIGITS = [
  [14, 17, 19, 21, 25, 17, 14],
  [4, 12, 4, 4, 4, 4, 14],
  [14, 17, 1, 2, 4, 8, 31],
  [31, 2, 4, 2, 1, 17, 14],
  [2, 6, 10, 18, 31, 2, 2],
  [31, 16, 30, 1, 1, 17, 14],
  [6, 8, 16, 30, 17, 17, 14],
  [31, 1, 2, 4, 8, 8, 8],
  [14, 17, 17, 14, 17, 17, 14],
  [14, 17, 17, 15, 1, 2, 12]
];
/** Each font pixel is this many of the picture's: about the extension's bold 16 px, once a Retina capture is made 1280 wide. */
const SCALE = 2;
/** The outline's width, as the extension's. */
const LINE = 2;
const PAD = 2;
const LABEL_H = 7 * SCALE + PAD * 2;
const YELLOW = [255, 212, 0];
const INK = [0, 0, 0];

/** How wide a number's box is. */
export const labelWidth = (id) => String(id).length * (5 * SCALE + SCALE) - SCALE + PAD * 2;

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Which controls get a number, and where it goes: the unnamed first (the
 * picture is all that names them), then those the goal's words are in, then
 * the rest; at most MAX_MARKS, and never a number over another. A control
 * whose number finds no room is left unmarked.
 * @param {{element:object, box:{x:number, y:number, w:number, h:number}}[]} items  each control's box, in the picture's pixels
 * @param {{width:number, height:number, goal?:string, max?:number}} picture
 * @returns {{id:number, box:object, label:{x:number, y:number, w:number, h:number}}[]}  in id order
 */
export function chooseMarks(items, { width, height, goal = '', max = MAX_MARKS }) {
  const words = goalWords(goal);
  const seen = (item) => {
    const { box } = item;
    if (!box || !(box.w >= MIN_SIDE && box.h >= MIN_SIDE)) return false;
    // Mostly out of the picture: scrolled away, or in another window.
    const w = Math.min(box.x + box.w, width) - Math.max(box.x, 0);
    const h = Math.min(box.y + box.h, height) - Math.max(box.y, 0);
    return w >= MIN_SIDE && h >= MIN_SIDE && w * h >= (box.w * box.h) / 2;
  };
  const rank = ({ element }) => {
    const said = [element.label, typeof element.value === 'string' ? element.value : '', element.placeholder].filter(Boolean).join(' ').toLowerCase();
    return (element.label ? 0 : 8) + words.reduce((sum, word) => sum + (hasWord(said, word) ? 3 : 0), 0) + (element.focused ? 2 : 0) + (element.role === 'row' ? 0 : 1);
  };
  const candidates = items.filter((item) => Number.isSafeInteger(item.element?.id) && !UNMARKED.has(item.element.role) && seen(item));
  const ranked = candidates.map((item, order) => ({ item, order, points: rank(item) })).sort((a, b) => b.points - a.points || a.order - b.order);
  const placed = [];
  for (const { item } of ranked) {
    if (placed.length >= max) break;
    const { box, element } = item;
    const w = labelWidth(element.id);
    const h = LABEL_H;
    const clamp = (x, y) => ({ x: Math.round(Math.max(0, Math.min(width - w, x))), y: Math.round(Math.max(0, Math.min(height - h, y))), w, h });
    // Inside its top left, above it, inside its top right, to its left.
    const spots = [clamp(box.x, box.y), clamp(box.x, box.y - h), clamp(box.x + box.w - w, box.y), clamp(box.x - w, box.y)];
    const label = spots.find((spot) => !placed.some((mark) => overlaps(mark.label, spot)));
    if (label) placed.push({ id: element.id, box, label });
  }
  return placed.sort((a, b) => a.id - b.id);
}

/**
 * Paints the marks into a picture's pixels, in place: a yellow outline
 * round each control, and its number, black on yellow.
 * @param {Uint8Array} pixels  BGRA, four bytes a pixel, rows packed: what Electron's
 *   nativeImage.toBitmap() gives on macOS and Windows
 */
export function drawMarks(pixels, width, height, marks) {
  const dot = (x, y, [r, g, b]) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const at = (y * width + x) * 4;
    pixels[at] = b;
    pixels[at + 1] = g;
    pixels[at + 2] = r;
    pixels[at + 3] = 255;
  };
  const fill = (x, y, w, h, color) => {
    for (let row = Math.max(0, y); row < Math.min(height, y + h); row++) for (let col = Math.max(0, x); col < Math.min(width, x + w); col++) dot(col, row, color);
  };
  for (const { box } of marks) {
    const [x, y, w, h] = [box.x, box.y, box.w, box.h].map(Math.round);
    fill(x, y, w, LINE, YELLOW);
    fill(x, y + h - LINE, w, LINE, YELLOW);
    fill(x, y, LINE, h, YELLOW);
    fill(x + w - LINE, y, LINE, h, YELLOW);
  }
  // Numbers after every outline, so no outline crosses one.
  for (const { id, label } of marks) {
    fill(label.x, label.y, label.w, label.h, INK);
    fill(label.x + 1, label.y + 1, label.w - 2, label.h - 2, YELLOW);
    [...String(id)].forEach((digit, place) => {
      const left = label.x + PAD + place * (5 * SCALE + SCALE);
      DIGITS[digit].forEach((bits, row) => {
        for (let col = 0; col < 5; col++) if (bits & (16 >> col)) fill(left + col * SCALE, label.y + PAD + row * SCALE, SCALE, SCALE, INK);
      });
    });
  }
  return pixels;
}

/** A card's number or code, as a field names it: not a thing to take a picture of. */
const CARD_FIELD = /\b(?:card ?number|credit card|debit card|cvv|cvc|security code|expir(?:y|ation))\b/i;

/**
 * Why no picture may be taken of this screen, or '' when one may: never with
 * a password or card field on it, as the extension never takes one.
 */
export function pictureRefusal(snapshot) {
  const fields = (snapshot?.elements || []).filter((element) => element.role !== 'text' && element.role !== 'heading');
  if (fields.some((element) => element.role === 'password')) return 'No picture while a password field is on screen: work from the screen text.';
  if (fields.some((element) => CARD_FIELD.test(`${element.label || ''} ${element.placeholder || ''}`))) return 'No picture while a card field is on screen: work from the screen text.';
  return '';
}
