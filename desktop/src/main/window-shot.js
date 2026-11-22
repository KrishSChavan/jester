/**
 * A picture of the window the assistant read, as the screen shows it, with
 * each control's id drawn on it (agent/marks.js): for a model that can see,
 * when the window's words aren't enough. The display is captured, cut to the
 * window, made no wider than a model needs and sent as a JPEG.
 *
 * macOS gives Jester the screen only with Screen Recording allowed, and asking
 * without it would put up the system's prompt in the middle of a task, so
 * nothing is captured until it's allowed. Jester's own windows over the
 * window (the overlays, the stop button, his own window) are seen through for the moment it takes.
 *
 * Electron's parts come in as deps, so this runs in tests without it.
 */

import { chooseMarks, drawMarks } from './agent/marks.js';

/** Wide enough for the numbers to stay legible: the extension's width. */
export const SHOT_MAX_WIDTH = 1280;
/**
 * No taller than a model takes whole: a picture with a longer side is made smaller on its way in, and a place the
 * model then gives in it (a click by x and y) would be a place in a picture nobody else has.
 */
export const SHOT_MAX_HEIGHT = 1568;
const JPEG_QUALITY = 75;
/** For the window server to take Jester's hidden windows off the screen before it's captured. */
const HIDE_MS = 120;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const intersect = (a, b) => {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.width) - x;
  const h = Math.min(a.y + a.h, b.y + b.height) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
};
const meets = (bounds, area) => !!intersect(area, bounds);

/**
 * Where the window is in a capture of its display: the part of it on that
 * display, in the capture's pixels.
 * @param {{x:number, y:number, w:number, h:number}} region  the window on the display, in DIPs
 * @param {{x:number, y:number, width:number, height:number}} bounds  the display's, in DIPs
 * @param {{width:number, height:number}} size  the capture's, in pixels
 */
export function cropFor(region, bounds, size) {
  const kx = size.width / bounds.width;
  const ky = size.height / bounds.height;
  const x = Math.max(0, Math.round((region.x - bounds.x) * kx));
  const y = Math.max(0, Math.round((region.y - bounds.y) * ky));
  return { x, y, width: Math.min(size.width - x, Math.round(region.w * kx)), height: Math.min(size.height - y, Math.round(region.h * ky)) };
}

/**
 * What a picture shows, as the driver places things: the part of the window in it ({x, y, w, h}, in the driver's own
 * coordinates) and the picture's size in pixels. A place in the picture is then a place on screen (host.js locate).
 * The window's frame is known both ways (the driver's, and Electron's DIPs), so the part pictured is worked out
 * as a share of it: no display's scale is needed.
 * @param {{x:number, y:number, w:number, h:number}} frame  the window, as the driver gave it
 * @param {{x:number, y:number, w:number, h:number}} dip  the same window in DIPs
 * @param {{x:number, y:number, w:number, h:number}} region  the part of it pictured, in DIPs
 * @param {{width:number, height:number}} size  the picture's
 */
export function viewOf(frame, dip, region, size) {
  const kx = frame.w / dip.w;
  const ky = frame.h / dip.h;
  return { x: frame.x + (region.x - dip.x) * kx, y: frame.y + (region.y - dip.y) * ky, w: region.w * kx, h: region.h * ky, width: size.width, height: size.height };
}

/**
 * @param {object} deps
 * @param {{getSources: Function}} deps.capturer  Electron's desktopCapturer
 * @param {{getDisplayMatching: Function}} deps.screen  Electron's screen
 * @param {{createFromBitmap: Function}} deps.images  Electron's nativeImage
 * @param {() => boolean} deps.allowed  whether the OS lets Jester capture the screen
 * @param {() => object[]} [deps.ownWindows]  Jester's BrowserWindows
 * @param {(frame:object) => object|null} [deps.toDip]  a driver frame in Electron's DIPs (driver.js toDipFrame)
 * @param {(ms:number) => Promise<void>} [deps.wait]
 * @returns {Function & {allowed: () => boolean}}
 *   (snapshot, {goal}) => {ok:true, image:{mimeType, data}, marked:number[], width, height, view} | {ok:false, detail};
 *   view: what the picture shows, for a place in it to be found on screen (viewOf)
 */
export function createWindowShot({ capturer, screen, images, allowed, ownWindows = () => [], toDip = (frame) => frame, wait = pause, maxWidth = SHOT_MAX_WIDTH, maxHeight = SHOT_MAX_HEIGHT }) {
  async function shoot(snapshot, { goal = '' } = {}) {
    if (!allowed()) return { ok: false, detail: 'Pictures of the screen aren’t allowed now: work from the screen text.' };
    const window = toDip(snapshot?.window?.frame);
    if (!(window?.w > 0 && window?.h > 0)) return { ok: false, detail: 'The window has no place on screen to take a picture of.' };
    const display = screen.getDisplayMatching({ x: Math.round(window.x), y: Math.round(window.y), width: Math.round(window.w), height: Math.round(window.h) });
    const region = display && intersect(window, display.bounds);
    if (!region) return { ok: false, detail: 'The window is off the screen.' };
    const pixels = { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) };

    // Jester's own windows over it are seen through for the picture, not hidden: hidden and shown again, one comes
    // back in front of the app being worked on (2026-11-14: his window over Calculator, and every step after the
    // picture failed as "Calculator isn't in front any more"). Each keeps its place among the windows.
    const inTheWay = ownWindows()
      .filter((win) => !win.isDestroyed() && win.isVisible() && meets(win.getBounds(), region))
      .map((win) => ({ win, opacity: win.getOpacity() }));
    let sources;
    try {
      for (const { win } of inTheWay) win.setOpacity(0);
      if (inTheWay.length) await wait(HIDE_MS);
      sources = await capturer.getSources({ types: ['screen'], thumbnailSize: pixels, fetchWindowIcons: false });
    } catch (err) {
      return { ok: false, detail: `The picture couldn’t be taken: ${String(err?.message || err).slice(0, 120)}` };
    } finally {
      for (const { win, opacity } of inTheWay) if (!win.isDestroyed()) win.setOpacity(opacity);
    }
    const source = sources.find((item) => String(item.display_id) === String(display.id)) || (sources.length === 1 ? sources[0] : null);
    const capture = source?.thumbnail;
    if (!capture || capture.isEmpty()) return { ok: false, detail: 'The picture came back empty.' };

    const cut = capture.crop(cropFor(region, display.bounds, capture.getSize()));
    // Made to fit both ways, its shape kept: one scale turns a place in it back into a place on screen.
    const size = cut.getSize();
    const fit = Math.min(1, maxWidth / size.width, maxHeight / size.height);
    const picture = fit < 1 ? cut.resize({ width: Math.max(1, Math.round(size.width * fit)), quality: 'good' }) : cut;
    const { width, height } = picture.getSize();
    // DIPs to the picture's pixels.
    const scale = width / region.w;
    const items = (snapshot.elements || []).map((element) => {
      const frame = element.frame ? toDip(element.frame) : null;
      return { element, box: frame && { x: (frame.x - region.x) * scale, y: (frame.y - region.y) * scale, w: frame.w * scale, h: frame.h * scale } };
    });
    const marks = chooseMarks(items, { width, height, goal });
    const drawn = drawMarks(picture.toBitmap(), width, height, marks);
    const jpeg = images.createFromBitmap(drawn, { width, height }).toJPEG(JPEG_QUALITY);
    return { ok: true, image: { mimeType: 'image/jpeg', data: jpeg.toString('base64') }, marked: marks.map((mark) => mark.id), width, height, view: viewOf(snapshot.window.frame, window, region, { width, height }) };
  }
  shoot.allowed = allowed;
  return shoot;
}
