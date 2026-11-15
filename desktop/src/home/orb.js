/**
 * Jester as a thinking orb: thinking-orbs 0.3.2 (MIT, Jakub Antalik), drawn
 * on a canvas without its React component. Only the library's engine is
 * vendored, in src/vendor/thinking-orbs; the loop here is its component's,
 * plus a short crossfade when he changes what he's doing, and his window's
 * opening: a dot of light that the orb's dots spread out from.
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
 * slow the whole Mac; 30 a second looks the same at the speeds it moves. The
 * opening, a second and a half of it, is drawn at the display's rate.
 */
const FRAME_MS = 1000 / 30;
/** The opening: the dot of light comes up, then the orb spreads out of it from here to the end. */
const SPREAD_FROM = 0.24;

const clamp = (x) => Math.min(1, Math.max(0, x));
const easeOut = (x) => 1 - (1 - x) ** 3;
const easeInOut = (x) => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2);

function tintOf(color) {
  const hex = String(color || '').trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!hex) return undefined;
  const digits = hex[1].length === 3 ? hex[1].replace(/./g, (c) => c + c) : hex[1];
  const n = parseInt(digits, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** A frame drawn closer in to the middle: `k` 0 is all of it at one point, 1 as it is. */
function gathered(frame, middle, k) {
  const near = (v) => middle + (v - middle) * k;
  return {
    dots: frame.dots.map((dot) => ({ ...dot, x: near(dot.x), y: near(dot.y), r: dot.r * (0.3 + 0.7 * k) })),
    lines: frame.lines.map((line) => ({ ...line, x1: near(line.x1), y1: near(line.y1), x2: near(line.x2), y2: near(line.y2) }))
  };
}

/**
 * `size` is the canvas's CSS size; `preset` is which of the library's tuned
 * designs to draw it from (64, 32 or 20); `tune` is the library's own `dots`
 * and `dotSize` multipliers, by state. `show(state)` animates one of the
 * library's states, `show(null)` stops and clears. `intro()` opens with a dot
 * of light the orb spreads out of.
 */
export function createOrb(canvas, { size, preset = 64, color, tune = {} }) {
  const ctx = canvas.getContext('2d');
  const tint = tintOf(color);
  const light = tint || { r: 182, g: 156, b: 245 };
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  let dpr = 1;
  let current = null;
  let leaving = null;
  let fadeFrom = 0;
  let raf = 0;
  let drawnAt = -Infinity;
  /** The opening: waiting to be played and seen (`from` null), then under way. */
  let opening = null;
  /** Covered by another of the window's screens: nothing's drawn until it's back. */
  let paused = false;

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

  function paint(one, now, alpha, k = 1) {
    const t = still.matches ? STILL_T : (now / 1000) * one.speed;
    const frame = one.frame(size, t, one.opts);
    ctx.globalAlpha = alpha;
    paintFrame(ctx, k < 1 ? gathered(frame, size / 2, k) : frame, true, tint);
  }

  /** The dot of light: a white point in a glow of the orb's colour. */
  function glow(radius, alpha) {
    if (radius <= 0 || alpha <= 0) return;
    const middle = size / 2;
    const shine = ctx.createRadialGradient(middle, middle, 0, middle, middle, radius);
    shine.addColorStop(0, `rgba(255, 255, 255, ${alpha})`);
    shine.addColorStop(0.16, `rgba(${light.r}, ${light.g}, ${light.b}, ${0.9 * alpha})`);
    shine.addColorStop(0.45, `rgba(${light.r}, ${light.g}, ${light.b}, ${0.25 * alpha})`);
    shine.addColorStop(1, `rgba(${light.r}, ${light.g}, ${light.b}, 0)`);
    ctx.globalAlpha = 1;
    ctx.fillStyle = shine;
    ctx.beginPath();
    ctx.arc(middle, middle, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  /** One frame of the opening, `p` from 0 to 1. @returns {boolean} whether it's over */
  function drawOpening(now, p) {
    // The dot comes up, then swells as the orb spreads out of it, and fades as it does.
    const rise = easeOut(clamp(p / SPREAD_FROM));
    const spread = easeInOut(clamp((p - SPREAD_FROM) / (1 - SPREAD_FROM)));
    const bloom = Math.sin(Math.PI * clamp((p - SPREAD_FROM * 0.7) / 0.55));
    const radius = size * (0.035 + 0.05 * rise + 0.22 * bloom);
    if (current && spread > 0) paint(current, now, Math.min(1, spread * 1.5), spread);
    glow(radius, rise * (1 - spread) ** 1.4 + 0.3 * bloom * (1 - spread));
    if (opening.onReveal && p >= opening.revealAt) {
      opening.onReveal();
      opening.onReveal = null;
    }
    return p >= 1;
  }

  function draw(now = performance.now()) {
    drawnAt = now;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    if (opening) {
      // Not seen yet: nothing, so the orb never shows before its dot.
      if (opening.from === null) return;
      const over = drawOpening(now, clamp((now - opening.from) / opening.ms));
      ctx.globalAlpha = 1;
      if (!over) return;
      opening = null;
      ctx.clearRect(0, 0, size, size);
    }
    const k = leaving && !still.matches ? Math.min(1, (now - fadeFrom) / FADE_MS) : 1;
    if (k >= 1) leaving = null;
    if (leaving) paint(leaving, now, 1 - k);
    if (current) paint(current, now, k);
    ctx.globalAlpha = 1;
  }

  /** The opening starts once it's played and the window's on screen, or the dot would spread before anyone saw it. */
  function begin() {
    if (opening?.playing && opening.from === null && document.visibilityState !== 'hidden') {
      opening.from = performance.now();
      leaving = null;
    }
  }

  function loop(now) {
    raf = 0;
    if (paused || (!current && !leaving && !opening?.playing)) return;
    // Motion reduced, even mid-opening (its change event isn't to be relied on while frames are drawn): one still frame.
    if (still.matches) {
      endOpening();
      draw(now);
      return;
    }
    begin();
    // A little early still counts, or a 60 Hz display would only get 20.
    if (opening?.playing || now - drawnAt >= FRAME_MS - 4) draw(now);
    if (document.visibilityState !== 'hidden') raf = requestAnimationFrame(loop);
  }

  function run() {
    if (!raf && !paused) raf = requestAnimationFrame(loop);
  }

  function show(state) {
    if ((current?.state ?? null) === (state ?? null)) return;
    leaving = still.matches || opening ? null : current;
    fadeFrom = performance.now();
    current = state ? look(state) : null;
    draw();
    run();
  }

  /**
   * Readies the opening: a dot of light the orb spreads out of, `ms` long.
   * Nothing's drawn until `play()`, once the window is on screen. `onReveal`
   * is called `revealAt` of the way through, for what's around the orb to
   * come in. With motion reduced, there's no opening, and it's called at once.
   */
  function intro({ ms = 1800, revealAt = 0.55, onReveal = null } = {}) {
    if (still.matches) {
      opening = null;
      onReveal?.();
      return;
    }
    opening = { from: null, playing: false, ms, revealAt, onReveal };
    draw();
  }

  /** The opening readied, played: from now, or once the window is seen. */
  function play() {
    if (!opening || opening.playing) return;
    if (still.matches) {
      endOpening();
      draw();
      return;
    }
    opening.playing = true;
    begin();
    draw();
    run();
  }

  /**
   * Paused, no frames are drawn: a thousand dots thirty times a second are for
   * someone to see. An opening under way is over at once, with what it reveals.
   */
  function pause(on) {
    if (!!on === paused) return;
    paused = !!on;
    if (paused) {
      cancelAnimationFrame(raf);
      raf = 0;
      endOpening();
      return;
    }
    draw();
    run();
  }

  function resize(next) {
    if (next === size || next <= 0) return;
    size = next;
    fit();
    draw();
  }

  /** An opening under way when motion's reduced is over at once, with what it reveals. */
  function endOpening() {
    if (!opening) return;
    const reveal = opening.onReveal;
    opening = null;
    reveal?.();
  }

  /** Moved to a display with other pixels (a Retina one, say), the canvas is made sharp for it. */
  function watchPixels() {
    const media = matchMedia(`(resolution: ${devicePixelRatio || 1}dppx)`);
    media.addEventListener(
      'change',
      () => {
        fit();
        draw();
        watchPixels();
      },
      { once: true }
    );
  }

  fit();
  watchPixels();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') return;
    begin();
    run();
  });
  still.addEventListener('change', () => {
    if (still.matches) endOpening();
    draw();
    run();
  });
  return { show, resize, intro, play, pause };
}
