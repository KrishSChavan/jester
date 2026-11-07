/**
 * Jester as a thinking orb: thinking-orbs 0.3.2 (MIT, Jakub Antalik), drawn
 * on a canvas without its React component. Only the library's engine is
 * vendored, in src/vendor/thinking-orbs; the loop here is its component's,
 * plus a short crossfade when he changes what he's doing.
 */

import {
  r as resolvePreset,
  s as scaleCounts,
  a as scaleRadii,
  M as MODE_FRAMES,
  p as paintFrame
} from '../vendor/thinking-orbs/engine.js';

/** What the orb shows for each of his moods. */
export const ORB_STATES = { resting: 'breathing', listening: 'listening', thinking: 'working', speaking: 'composing' };

/** How long one state hands over to the next. */
const FADE_MS = 320;
/** The frame the library shows when motion is reduced. */
const STILL_T = 0.6;
/**
 * A frame is a thousand or two dots, each its own fill. At a 120 Hz display's
 * every frame that kept the GPU process and the window server busy enough to
 * slow the whole Mac; 30 a second looks the same at the speeds it moves.
 */
const FRAME_MS = 1000 / 30;

function tintOf(color) {
  const hex = String(color || '').trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!hex) return undefined;
  const digits = hex[1].length === 3 ? hex[1].replace(/./g, (c) => c + c) : hex[1];
  const n = parseInt(digits, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/**
 * `size` is the canvas's CSS size; `preset` is which of the library's tuned
 * designs to draw it from (64, 32 or 20); `tune` is the library's own `dots`
 * and `dotSize` multipliers, by state. `show(state)` animates one of the
 * library's states, `show(null)` stops and clears.
 */
export function createOrb(canvas, { size, preset = 64, color, tune = {} }) {
  const ctx = canvas.getContext('2d');
  const tint = tintOf(color);
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  let dpr = 1;
  let current = null;
  let leaving = null;
  let fadeFrom = 0;
  let raf = 0;
  let drawnAt = -Infinity;

  function look(state) {
    const { mode, speed, opts: tuned } = resolvePreset(state, preset);
    const { dots = 1, dotSize = 1 } = tune[state] || {};
    let opts = dots !== 1 ? scaleCounts(tuned, dots) : tuned;
    if (dotSize !== 1) opts = scaleRadii(opts, dotSize);
    return { state, frame: MODE_FRAMES[mode], speed, opts };
  }

  function fit() {
    dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    canvas.style.width = canvas.style.height = `${size}px`;
  }

  function paint(one, now, alpha) {
    const t = still.matches ? STILL_T : (now / 1000) * one.speed;
    ctx.globalAlpha = alpha;
    paintFrame(ctx, one.frame(size, t, one.opts), true, tint);
  }

  function draw(now = performance.now()) {
    drawnAt = now;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    const k = leaving && !still.matches ? Math.min(1, (now - fadeFrom) / FADE_MS) : 1;
    if (k >= 1) leaving = null;
    if (leaving) paint(leaving, now, 1 - k);
    if (current) paint(current, now, k);
    ctx.globalAlpha = 1;
  }

  function loop(now) {
    raf = 0;
    if (!current && !leaving) return;
    // A little early still counts, or a 60 Hz display would only get 20.
    if (now - drawnAt >= FRAME_MS - 4) draw(now);
    if (!still.matches && document.visibilityState !== 'hidden') raf = requestAnimationFrame(loop);
  }

  function run() {
    if (!raf) raf = requestAnimationFrame(loop);
  }

  function show(state) {
    if ((current?.state ?? null) === (state ?? null)) return;
    leaving = still.matches ? null : current;
    fadeFrom = performance.now();
    current = state ? look(state) : null;
    draw();
    run();
  }

  function resize(next) {
    if (next === size || next <= 0) return;
    size = next;
    fit();
    draw();
  }

  fit();
  document.addEventListener('visibilitychange', () => document.visibilityState !== 'hidden' && run());
  still.addEventListener('change', () => (draw(), run()));
  return { show, resize };
}
