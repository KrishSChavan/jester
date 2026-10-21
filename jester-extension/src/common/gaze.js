/**
 * Turning "what do the eyes and head look like" into "where on the screen are
 * they looking".
 *
 * The reading is what MediaPipe's face tracker measures (src/offscreen/eyes.js):
 * where each iris sits in its eye, how open the lids are, the tracker's own gaze
 * blendshapes, and which way the head points and where it is. A ridge
 * regression maps that to a point on the screen. Calibration is the training
 * set: look at a dot, close your hand, and the reading at that moment is paired
 * with where the dot was.
 *
 *   - Fourteen numbers, not WebGazer's 120 grey levels: few enough to fit with
 *     a handful of curved terms (the iris travels less per degree near the
 *     screen's edges) without fitting the noise. Which terms, and how hard to
 *     penalise them, is chosen per calibration by asking each candidate to read
 *     looks it never learned from. See `FEATURE_SETS` and `chooseModel()`.
 *   - The head's pose is an input. Turn your head to look at a corner and the
 *     model knows it, rather than reading the turned head as eyes looking
 *     somewhere else.
 *   - Calibration is three rounds over the same thirteen dots, and after the
 *     ridge a nearest-neighbours step pulls the reading onto each dot it was
 *     calibrated on. See `CALIBRATION_ROUNDS` and `buildWarp()`.
 *   - Smoothed by a fixation filter, measured in each user's own noise. See
 *     `makeGazeFilter()`.
 *
 * Everything here is pure, so the fit can be tested without a camera.
 */

import { fitRidge, predictRidge } from './ridge.js';
import { BASE_FEATURE_COUNT, GAZE_FEATURE_VERSION, MODEL_KIND, NOISE_RHO_LIMIT } from './gaze-store.js';

/**
 * Each hold's frames are weighted as if it had this many, so a hold that read
 * a few more frames doesn't pull the fit toward itself.
 */
const REFERENCE_FRAMES = 12;

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const validFeatures = (features) =>
  Array.isArray(features) && features.length === BASE_FEATURE_COUNT && features.every(Number.isFinite);

// ---------------------------------------------------------------------------
// The targets
// ---------------------------------------------------------------------------

/**
 * Inset from the true edge so each dot renders fully on screen. Small, because
 * everything outside the calibrated area is extrapolation.
 */
export const CALIBRATION_MARGIN = 0.05;

/**
 * A 3x3 grid, ordered centre-first and then clockwise around the ring.
 *
 * Centre first because it is the easiest target and gets the user settled while
 * they are still reading the instructions; the ring after it because
 * consecutive targets are then adjacent, so the eyes make the shortest jump
 * and the head has the least reason to follow them.
 */
export const CALIBRATION_TARGETS = (() => {
  const lo = CALIBRATION_MARGIN;
  const hi = 1 - CALIBRATION_MARGIN;
  const mid = 0.5;
  return [
    { x: mid, y: mid, label: 'centre' },
    { x: lo, y: lo, label: 'top left' },
    { x: mid, y: lo, label: 'top middle' },
    { x: hi, y: lo, label: 'top right' },
    { x: hi, y: mid, label: 'right middle' },
    { x: hi, y: hi, label: 'bottom right' },
    { x: mid, y: hi, label: 'bottom middle' },
    { x: lo, y: hi, label: 'bottom left' },
    { x: lo, y: mid, label: 'left middle' }
  ];
})();

/**
 * Four more dots, inside the grid, where most of what gets looked at is.
 *
 * Every dot trains the fit — the middle of the screen needs dots of its own
 * for the nearest-neighbour step to work from — and the grade comes from the
 * rounds: see `crossValidateRounds()`.
 */
export const INNER_TARGETS = [
  { x: 0.3, y: 0.3, label: 'inner top left' },
  { x: 0.7, y: 0.3, label: 'inner top right' },
  { x: 0.7, y: 0.7, label: 'inner bottom right' },
  { x: 0.3, y: 0.7, label: 'inner bottom left' }
];

/** Every round, in this order: the centre, clockwise round the edge, then the inner four. */
export const CALIBRATION_DOTS = [...CALIBRATION_TARGETS, ...INNER_TARGETS];

/**
 * One full calibration: every dot, in order, three times over.
 *
 * Each dot's three looks come from moments far enough apart that the head and
 * the light have wandered a little, so the fit learns which differences are
 * noise — and a round can be graded by a fit made from the other two. In
 * simulation through WebGazer's own feature pipeline, three rounds of thirteen
 * against one round of nine cut the reading's frame-to-frame scatter by 16–32%
 * and its aim by 7–22%.
 */
export const CALIBRATION_ROUNDS = 3;

/** The one dot a re-centre asks for. */
export const RECENTRE_TARGET = { x: 0.5, y: 0.5, label: 'centre' };

// ---------------------------------------------------------------------------
// Reducing one hold to training rows
// ---------------------------------------------------------------------------

/** How far back from the fist landing the eyes are read. */
export const CAPTURE_WINDOW_MS = 600;
/**
 * Frames from the first moments after a dot appears are the eyes still getting
 * there: 200–250 ms before they move, 50 ms in flight, and often a corrective
 * jump 100–150 ms after that when the dot was far away.
 */
export const SETTLE_MS = 400;
/** A fist sooner than this after the dot appears was not made while looking at it. */
export const MIN_LOOK_MS = 700;
/** Below this a hold is too short to trust. */
export const HOLD_MIN_FRAMES = 6;
/**
 * A frame whose eyes are less open than this fraction of the hold's median is
 * part of a blink. Tighter than a blink detector would usually be: a lid only a
 * quarter closed already moves WebGazer's reading by a tenth of the screen.
 */
export const HOLD_BLINK_RATIO = 0.75;
/**
 * Iris readings farther than this from the hold's median — or 2.5 MADs, if
 * wider, so ordinary landmark noise never counts — were looking elsewhere…
 */
export const IRIS_OUTLIER_MIN = 0.035;
const IRIS_OUTLIER_MAD = 2.5;
/**
 * …but never farther than this, however much the hold scattered. The whole
 * screen is only about 0.19 eye widths of iris travel across, so a reading
 * 0.08 away was looking nearly half the screen away; a hold that wandered the
 * whole time must not raise its own bar.
 */
export const IRIS_OUTLIER_MAX = 0.08;
/** When more than this share of a hold was looking elsewhere, the hold as a whole is suspect. */
export const IRIS_DROP_LIMIT = 1 / 3;

/**
 * Collapse the frames around one confirm into training rows.
 *
 * WebGazer's own calibration asks for five clicks per dot and learns from each.
 * A fist is slower than a click, so instead one confirm yields every usable
 * frame from the moment before the hand closed, while the eyes were on the
 * dot. "Usable" is decided frame by frame, because what spoils a hold almost
 * never spoils all of it:
 *
 *   - no face, a hand across the eyes, or eye patches too flat to read;
 *   - blinks — and the frame before and two after each, while the lid is still
 *     travelling;
 *   - a glance away — the iris somewhere other than where the rest of the hold
 *     had it. A spread measure can't see a glance that lasts less than half the
 *     hold, which is exactly the one that does the damage (a look down at the
 *     closing hand), so the odd frames are dropped one by one instead.
 *
 * @param frames per camera frame: `{ face, occluded, far, lowContrast,
 *   features, ear, iris, pose }`, in order. `far`: the eyes are too small in
 *   the picture to aim with, or were read from a zoomed-in face.
 */
export function summariseHold(frames) {
  if (!frames?.length) return null;

  const faceless = frames.filter((f) => !f.face).length;
  const covered = frames.filter((f) => f.face && f.occluded).length;
  const far = frames.filter((f) => f.face && !f.occluded && f.far).length;
  // A face, nothing across it, near enough, and still no reading: patches too
  // flat to mean anything (dim light, glare), or no eye patch at all.
  const unreadable = frames.filter(
    (f) => f.face && !f.occluded && !f.far && (f.lowContrast || !validFeatures(f.features))
  ).length;
  const read = [];
  frames.forEach((f, i) => {
    if (f.face && !f.occluded && !f.far && !f.lowContrast && validFeatures(f.features)) read.push({ f, i });
  });

  const earMedian = read.length ? median(read.map(({ f }) => f.ear)) : 0;
  const blinking = new Set();
  for (const { f, i } of read) {
    if (f.ear < earMedian * HOLD_BLINK_RATIO) for (let j = i - 1; j <= i + 2; j += 1) blinking.add(j);
  }
  const open = read.filter(({ i }) => !blinking.has(i));

  let kept = open;
  const withIris = open.filter(({ f }) => Array.isArray(f.iris));
  if (withIris.length >= 3) {
    const mu = median(withIris.map(({ f }) => f.iris[0]));
    const mv = median(withIris.map(({ f }) => f.iris[1]));
    const distance = ({ f }) => (f.iris ? Math.hypot(f.iris[0] - mu, f.iris[1] - mv) : 0);
    const limit = Math.max(
      IRIS_OUTLIER_MIN,
      Math.min(IRIS_OUTLIER_MAX, IRIS_OUTLIER_MAD * median(withIris.map(distance)))
    );
    kept = open.filter((entry) => distance(entry) <= limit);
  }

  return {
    rows: kept.map(({ f }) => f.features),
    // Which frame of the hold each row came from, so frames that were next to
    // each other can be told from ones a blink or a glance came between.
    index: kept.map(({ i }) => i),
    poses: kept.map(({ f }) => f.pose).filter(Boolean),
    frames: frames.length,
    faceless,
    covered,
    far,
    unreadable,
    blinks: read.length - open.length,
    open: open.length,
    irisDropped: open.length - kept.length,
    usable: kept.length
  };
}

/**
 * Is this hold good enough to learn from, and if not, what should the user
 * change? Either it is, or it names the loss that did the damage — they need
 * different fixes, and "try again" alone teaches nothing.
 */
export function gradeHold(summary, { minFrames = HOLD_MIN_FRAMES } = {}) {
  if (!summary || !summary.frames) return { verdict: 'reject', reason: 'no-frames' };
  if (summary.open >= minFrames && summary.irisDropped > summary.open * IRIS_DROP_LIMIT) {
    return { verdict: 'reject', reason: 'eyes-moved' };
  }
  if (summary.usable >= minFrames) return { verdict: 'ok', reason: null };

  const losses = [
    ['covered', summary.covered],
    ['no-face', summary.faceless],
    ['too-far', summary.far || 0],
    ['unreadable', summary.unreadable],
    ['blinked', summary.blinks],
    ['eyes-moved', summary.irisDropped]
  ].sort((a, b) => b[1] - a[1]);
  return { verdict: 'reject', reason: losses[0][1] > 0 ? losses[0][0] : 'too-short' };
}

/**
 * How many usable frames a hold needs, given how fast frames are actually
 * arriving. Six at the usual rate; fewer on a camera that can't keep up, where
 * six can't fit in the window at all and asking the user to "look longer"
 * would be advice that can't help. Never fewer than three.
 *
 * @param interval the typical gap between camera frames, in ms.
 * @param windowMs how much of the hold the capture window covered.
 */
export function holdMinFrames(interval, windowMs) {
  if (!(interval > 0) || !(windowMs > 0)) return HOLD_MIN_FRAMES;
  const expected = windowMs / interval;
  return Math.max(3, Math.min(HOLD_MIN_FRAMES, Math.ceil(expected * 0.6)));
}

// ---------------------------------------------------------------------------
// The fit
// ---------------------------------------------------------------------------

/** The unit a training row is weighted by: its hold — or, for samples that don't say, its dot. */
const holdKey = (s) => s.hold ?? s.dot;

/**
 * What the ridge is fitted on, made from one frame's 14 numbers (see
 * `BASE_FEATURES` in src/offscreen/eyes.js). Each set is a candidate; a
 * calibration keeps whichever reads its own rounds best (`chooseModel()`).
 *
 *   linear  both eyes averaged, the lids, the gaze blendshapes and the head:
 *           straight lines only.
 *   curved  the same, plus the bends: near the screen's edges the iris travels
 *           less for the same move of the gaze, so the reading is squeezed
 *           toward the middle unless the fit can curve, and a turned head
 *           changes how far the iris travels at all.
 *   perEye  curved, with each eye's iris and lids as well as their average —
 *           for a face the tracker reads unevenly (glasses, a squint, a
 *           drooping lid).
 */
export const FEATURE_SETS = {
  linear(f) {
    return [(f[0] + f[2]) / 2, (f[1] + f[3]) / 2, (f[4] + f[5]) / 2, f[6], f[7], f[8], f[9], f[10], f[11], f[12], f[13]];
  },
  curved(f) {
    const base = FEATURE_SETS.linear(f);
    const [u, v] = base;
    return [...base, u * u, v * v, u * v, u * u * u, v * v * v, u * f[8], v * f[9]];
  },
  perEye(f) {
    return [...FEATURE_SETS.curved(f), f[0], f[1], f[2], f[3], f[4], f[5]];
  }
};

/**
 * Penalties tried, per unit of total weight, on standardised inputs. The
 * smallest barely regularises; the largest flattens the curves to nearly
 * straight lines.
 */
export const LAMBDAS = [0.0003, 0.001, 0.003, 0.01, 0.03, 0.1, 0.3];

/**
 * What a calibration with no second round to choose by is fitted with — and
 * without the nearest-neighbour step, which needs rounds to measure honest
 * errors from.
 */
export const DEFAULT_SPEC = { set: 'curved', lambda: 0.01, warp: false };

/**
 * The ridge, for both axes at once. Rows are weighted so every hold counts as
 * `REFERENCE_FRAMES` frames however many it read, and the penalty is per unit
 * of that weight — so three rounds don't triple it.
 *
 * @param spec `{ set, lambda }`: which `FEATURE_SETS` expansion, which penalty.
 * @returns `{ set, lambda, mean, scale, coef, intercept }`, or null.
 */
function solve(samples, spec = DEFAULT_SPEC) {
  const expand = FEATURE_SETS[spec.set];
  if (!expand || !samples.length) return null;
  const counts = new Map();
  for (const s of samples) counts.set(holdKey(s), (counts.get(holdKey(s)) || 0) + 1);
  const rows = [];
  const targets = [];
  const weights = [];
  for (const s of samples) {
    rows.push(expand(s.features));
    targets.push([s.x, s.y]);
    weights.push(REFERENCE_FRAMES / counts.get(holdKey(s)));
  }
  const fit = fitRidge(rows, targets, { weights, lambda: spec.lambda });
  return fit && { set: spec.set, lambda: spec.lambda, ...fit };
}

/** The ridge's reading of one frame, in screen pixels. */
function ridgeRead(fit, features) {
  const [x, y] = predictRidge(fit, FEATURE_SETS[fit.set](features));
  return { x, y };
}

// ---------------------------------------------------------------------------
// The nearest-neighbour step
//
// Even with its curves the ridge is a smooth guess, and each face departs from
// it its own way, most of all near the screen's edges. Three rounds show
// exactly how: for each dot there are three looks, and the ridge's reading of
// them against where the dot really was is the error at that spot. This step
// keeps those errors — one per dot — and corrects every later reading by the
// errors of the dots it lands nearest, weighted by how near: k-nearest-
// neighbour regression on the ridge's residuals, in screen space. It stores
// 4 numbers per dot, no eye data.
// ---------------------------------------------------------------------------

/** Dots whose errors correct a reading: the nearest four. */
export const WARP_NEIGHBOURS = 4;
/** Fewer calibrated dots than this and there is no neighbourhood to speak of. */
const WARP_MIN_DOTS = 5;

/**
 * The per-dot errors: `[readX, readY, errX, errY]` for each dot — where the
 * ridge reads that dot, and how far from the dot that is.
 *
 * Honest errors: each hold is read by a ridge fitted *without its round*, so a
 * dot's error is what the model gets wrong about a look it never learned from
 * — the same thing it will get wrong at runtime — not how closely it memorised
 * the look it was given. A round whose leave-it-out fit can't be made (too few
 * dots in the others) contributes nothing rather than a memorised error. With
 * only one round there is nothing to leave out and the fitted ridge reads its
 * own holds.
 *
 * @param samples as `fitGazeCalibration` takes them, with `round` where known.
 * @param fit the ridge fitted on all of them.
 * @param spec what it was fitted with, so each leave-one-out fit matches it.
 * @returns the table, or null when too few dots were read to correct anything.
 */
export function buildWarp(samples, fit, spec = DEFAULT_SPEC) {
  const rounds = [...new Set(samples.map((s) => s.round ?? 0))];
  const folds = new Map();
  const readerFor = (round) => {
    if (rounds.length < 2) return fit;
    if (!folds.has(round)) {
      const rest = samples.filter((s) => (s.round ?? 0) !== round);
      folds.set(round, new Set(rest.map((s) => s.dot)).size >= WARP_MIN_DOTS ? solve(rest, spec) : null);
    }
    return folds.get(round);
  };
  // Each hold's mean reading, then each dot's mean over its holds.
  const byHold = new Map();
  for (const s of samples) {
    const key = holdKey(s);
    if (!byHold.has(key)) byHold.set(key, { dot: s.dot, round: s.round ?? 0, x: s.x, y: s.y, rows: [] });
    byHold.get(key).rows.push(s.features);
  }
  const byDot = new Map();
  for (const hold of byHold.values()) {
    const reader = readerFor(hold.round);
    if (!reader) continue;
    let rx = 0;
    let ry = 0;
    for (const features of hold.rows) {
      const p = ridgeRead(reader, features);
      rx += p.x;
      ry += p.y;
    }
    if (!byDot.has(hold.dot)) byDot.set(hold.dot, { x: hold.x, y: hold.y, rx: 0, ry: 0, n: 0 });
    const dot = byDot.get(hold.dot);
    dot.rx += rx / hold.rows.length;
    dot.ry += ry / hold.rows.length;
    dot.n += 1;
  }
  if (byDot.size < WARP_MIN_DOTS) return null;
  const warp = [];
  for (const dot of byDot.values()) {
    const readX = dot.rx / dot.n;
    const readY = dot.ry / dot.n;
    warp.push([readX, readY, dot.x - readX, dot.y - readY].map((v) => Math.round(v * 10) / 10));
  }
  return warp.every((row) => row.every(Number.isFinite)) ? warp : null;
}

/**
 * The correction for a ridge reading at (x, y): a weighted mean of the errors
 * of the `WARP_NEIGHBOURS` dots it reads nearest. On a calibrated dot's own
 * reading it is that dot's error — the dot lands exactly where it was — and
 * between dots it blends theirs.
 *
 * Each weight is 1/d less the same for the first dot left out, so a dot's
 * weight has fallen to nothing by the time another takes its place among the
 * nearest. Plain 1/d over the nearest four jumped wherever the fourth and
 * fifth changed places — by 40 to 90 px, measured — and a resting gaze on such
 * a seam made the cursor hop between two corrections.
 */
export function warpCorrection(warp, x, y) {
  if (!Array.isArray(warp) || !warp.length) return { x: 0, y: 0 };
  const sorted = warp.map((row) => ({ row, d: Math.hypot(row[0] - x, row[1] - y) })).sort((a, b) => a.d - b.d);
  // A reading within a hair of a dot's own reading is that dot.
  if (sorted[0].d < 1e-3) return { x: sorted[0].row[2], y: sorted[0].row[3] };
  const cutoff = sorted.length > WARP_NEIGHBOURS ? 1 / sorted[WARP_NEIGHBOURS].d : 0;
  let sx = 0;
  let sy = 0;
  let sw = 0;
  for (const { row, d } of sorted.slice(0, WARP_NEIGHBOURS)) {
    const w = 1 / d - cutoff;
    if (!(w > 0)) continue;
    sx += w * row[2];
    sy += w * row[3];
    sw += w;
  }
  return sw > 0 ? { x: sx / sw, y: sy / sw } : { x: 0, y: 0 };
}

/** A reading in screen pixels with the nearest-neighbour step but no re-centring. */
export function predictUnbiased(model, features) {
  const raw = ridgeRead(model.fit, features);
  if (!model.warp) return raw;
  const c = warpCorrection(model.warp, raw.x, raw.y);
  return { x: raw.x + c.x, y: raw.y + c.y };
}

/** A prediction in screen pixels, with any re-centring applied. */
export function predictPx(model, features) {
  const p = predictUnbiased(model, features);
  const bias = Array.isArray(model.bias) && model.bias.length === 2 && model.bias.every(Number.isFinite) ? model.bias : [0, 0];
  return { x: p.x + bias[0], y: p.y + bias[1] };
}

// ---------------------------------------------------------------------------
// Fitting, grading, and how noisy the result is
// ---------------------------------------------------------------------------

/** Dots a fit needs at the least. */
export const MIN_POINTS = 5;

/**
 * Collected holds as fitting samples: one per usable frame, labelled with its
 * dot, its round and its hold (the unit the fit weights by).
 *
 * @param holds `{ rows, x, y, dot, round }` — `x`/`y` in screen pixels.
 */
export function holdSamples(holds) {
  const samples = [];
  for (const h of holds || []) {
    if (!h) continue;
    const round = h.round ?? 0;
    for (const features of h.rows || []) {
      samples.push({ features, x: h.x, y: h.y, dot: h.dot, round, hold: `${round}:${h.dot}` });
    }
  }
  return samples;
}

/**
 * How far the reading scatters from frame to frame while the eyes hold still,
 * per axis, in pixels: the fixation filter's unit of "this could be noise".
 *
 * Pooled over every hold of three or more frames — each hold is the eyes on
 * one dot. Best measured on looks the model never learned from, which
 * `crossValidateRounds()` has to hand; this in-sample version is the fallback
 * when there's only one round. The fit has already seen these frames and
 * scatters less over them than over new ones, so it's scaled up a little:
 * simulated, the in-sample spread was 0.73–0.88 of the live one with the
 * nearest-neighbour step, and the held-out spread 0.95–1.17 of it.
 */
export const NOISE_IN_SAMPLE_FACTOR = 1.12;
export const NOISE_HELD_OUT_FACTOR = 0.95;

/**
 * Σ over every pair (a, b) of a run of `n` readings of ρ^|a−b|: how much
 * correlated readings move together. `n` for independent ones.
 */
function pairSum(n, rho) {
  if (!(rho > 0)) return n;
  let sum = n;
  let power = 1;
  for (let k = 1; k < n; k += 1) {
    power *= rho;
    sum += 2 * (n - k) * power;
  }
  return sum;
}

/**
 * Pooled per-axis scatter of each group of readings around its own mean — or
 * null with fewer than three groups of three.
 *
 * Readings correlated from one to the next by ρ wander together, so they
 * scatter less about their own short mean than independent ones would: each
 * group has n − S/n degrees of freedom (S from `pairSum()`), not n − 1.
 * Counted as n − 1, a correlated camera's noise read up to a quarter low — and
 * the cursor's jump test, which works to it, fired on plain noise until the
 * live readings caught up.
 */
function pooledScatter(groups, rho = 0) {
  let ss = 0;
  let dof = 0;
  let used = 0;
  for (const points of groups) {
    const n = points.length;
    if (n < 3) continue;
    const mx = points.reduce((sum, p) => sum + p.x, 0) / n;
    const my = points.reduce((sum, p) => sum + p.y, 0) / n;
    for (const p of points) ss += (p.x - mx) ** 2 + (p.y - my) ** 2;
    dof += n - pairSum(n, rho) / n;
    used += 1;
  }
  return used >= 3 && dof > 0 ? Math.sqrt(ss / dof / 2) : null;
}

export function estimateNoise(model, samples) {
  const byHold = new Map();
  for (const s of samples) {
    const key = holdKey(s);
    if (!byHold.has(key)) byHold.set(key, []);
    byHold.get(key).push(predictUnbiased(model, s.features));
  }
  const scatter = pooledScatter(byHold.values());
  return scatter === null ? null : scatter * NOISE_IN_SAMPLE_FACTOR;
}

/**
 * Fit a calibration to the collected samples: the ridge, then the
 * nearest-neighbour step, then how noisy the two together read.
 *
 * @param samples `{ features, x, y, dot, round?, hold? }` — one frame's 14
 *   numbers, the screen point in CSS pixels the user was looking at, which dot
 *   it was and (from `holdSamples()`) which round and hold.
 * @param meta must include `screenW` and `screenH`; stored alongside. `spec`,
 *   if given, is which `FEATURE_SETS` expansion and penalty to fit with
 *   (`DEFAULT_SPEC` otherwise) and is not stored — the fit carries it.
 * @returns `{ ok, model }`, or `{ ok: false, detail }`. `model.error` is left
 *   for `crossValidateRounds()` to fill in.
 */
export function fitGazeCalibration(samples, meta = {}) {
  const { spec = DEFAULT_SPEC, ...stored } = meta;
  if (!(stored.screenW > 0) || !(stored.screenH > 0)) return { ok: false, detail: 'The screen size is unknown.' };

  const usable = (samples || []).filter(
    (s) => validFeatures(s?.features) && Number.isFinite(s.x) && Number.isFinite(s.y)
  );
  const dots = new Set(usable.map((s) => s.dot));
  if (dots.size < MIN_POINTS) return { ok: false, detail: 'Not enough of the dots could be read. Run calibration again.' };

  const fit = solve(usable, spec);
  if (!fit) return { ok: false, detail: 'The fit failed. Run calibration again.' };

  const model = {
    kind: MODEL_KIND,
    featureVersion: GAZE_FEATURE_VERSION,
    fit,
    warp: spec.warp === false ? null : buildWarp(usable, fit, spec),
    noisePx: null,
    bias: [0, 0],
    error: null,
    errorPx: null,
    points: dots.size,
    samples: usable.length,
    createdAt: Date.now(),
    ...stored
  };
  const noise = estimateNoise(model, usable);
  // A figure that rounds to nothing isn't a measurement; the filter has a fallback.
  model.noisePx = noise > 0.05 ? Math.round(noise * 10) / 10 : null;
  return { ok: true, model };
}

/**
 * The grade: every round read by a fit made without it.
 *
 * Every look trains the calibration, so none is left to grade it with.
 * Instead the fit is made three more times, each time leaving one round out,
 * and each left-out look is read by the fit that never saw it — the same
 * question the cursor will be asked about a look it has never seen. `fit`
 * must be the function the calibration itself is fitted with, so the grade
 * grades what ships.
 *
 * Simulated, this tracked the true miss far better than holding four dots out
 * did (rank correlation 0.88–0.90 against 0.66–0.74, pooled across webcam
 * qualities), typically 0.9–1.15× of it on ordinary and noisy webcams and
 * erring high, about 1.3×, on bad ones — one user in ten further off still.
 *
 * The same held-out readings measure how correlated consecutive readings are
 * (`readingCorrelation()`) and then, allowing for that, the noise — pooled
 * here and scaled by `NOISE_HELD_OUT_FACTOR` (`estimateNoise()` is the
 * one-round fallback).
 *
 * A round whose leave-it-out fit can't be made — the other rounds together
 * read too few dots — can't be graded honestly, and the result says so
 * (`partial`) rather than pass off the rounds that could be as the whole.
 *
 * @param holds `{ rows, x, y, dot, round }` per hold taken.
 * @param fit `(samples) => { ok, model }`.
 * @returns `{ error, errorPx, noisePx, noiseRho, partial, rounds,
 *   holds: [{ dot, round, x, y, px, py, miss }], dots: [{ dot, x, y, px, py, miss }] }`
 *   — error as a fraction of the screen's width, `rounds` how many were
 *   graded — or null with fewer than two rounds to read against each other.
 */
export function crossValidateRounds(holds, fit) {
  const usable = (holds || []).filter((h) => h && (h.rows || []).some(validFeatures));
  const rounds = [...new Set(usable.map((h) => h.round ?? 0))];
  if (rounds.length < 2) return null;
  const scored = [];
  const scatter = [];
  const series = [];
  let screenW = 0;
  let graded = 0;
  for (const round of rounds) {
    const fitted = fit(holdSamples(usable.filter((h) => (h.round ?? 0) !== round)));
    if (!fitted?.ok) continue;
    graded += 1;
    screenW = fitted.model.screenW;
    for (const h of usable.filter((g) => (g.round ?? 0) === round)) {
      const valid = h.rows.map((row, i) => ({ row, frame: h.index?.[i] ?? i })).filter(({ row }) => validFeatures(row));
      const readings = valid.map(({ row }) => predictPx(fitted.model, row));
      series.push(readings.map((p, i) => ({ ...p, frame: valid[i].frame })));
      scatter.push(readings);
      const px = median(readings.map((p) => p.x));
      const py = median(readings.map((p) => p.y));
      scored.push({ dot: h.dot, round, x: h.x, y: h.y, px, py, miss: Math.hypot(px - h.x, py - h.y) });
    }
  }
  if (!scored.length || !(screenW > 0)) return null;
  const errorPx = Math.sqrt(scored.reduce((sum, h) => sum + h.miss * h.miss, 0) / scored.length);
  const rho = readingCorrelation(series);
  const spread = pooledScatter(scatter, rho ?? 0);
  const dots = [];
  for (const dot of [...new Set(scored.map((h) => h.dot))]) {
    const mine = scored.filter((h) => h.dot === dot);
    const px = median(mine.map((h) => h.px));
    const py = median(mine.map((h) => h.py));
    dots.push({ dot, x: mine[0].x, y: mine[0].y, px, py, miss: Math.hypot(px - mine[0].x, py - mine[0].y) });
  }
  return {
    error: errorPx / screenW,
    errorPx,
    noisePx: spread > 0.05 ? Math.round(spread * NOISE_HELD_OUT_FACTOR * 10) / 10 : null,
    noiseRho: rho === null ? null : Math.round(rho * 100) / 100,
    partial: graded < rounds.length,
    rounds: graded,
    holds: scored,
    dots
  };
}

/**
 * How correlated each reading is with the next while the eyes hold still:
 * the lag-1 autocorrelation of each hold's readings about its own mean, pooled
 * over holds, from frames that were next to each other — a repeated picture
 * (an identical reading) says nothing and is passed over. Short series read
 * low (taking out each hold's own mean takes some of the correlation with it),
 * so the pooled figure is turned back into ρ through its exact expectation for
 * series of the holds' length; on simulated AR(1) holds that recovered ρ from
 * 0 to 0.7 within ±0.06 for four runs in five. The cursor's jump test then
 * allows for the real amount of wander (see `meanDifferenceVariance()`).
 *
 * @param series per hold, its readings in frame order: `{ x, y, frame }`.
 * @returns ρ in [0, `NOISE_RHO_MAX`], or null with too little to go on.
 */
const RHO_MIN_PAIRS = 30;
function readingCorrelation(series) {
  let num = 0;
  let pairs = 0;
  let den = 0;
  let count = 0;
  let holds = 0;
  for (const readings of series) {
    if (readings.length < 4) continue;
    const mx = readings.reduce((sum, p) => sum + p.x, 0) / readings.length;
    const my = readings.reduce((sum, p) => sum + p.y, 0) / readings.length;
    for (let i = 0; i < readings.length; i += 1) {
      const a = readings[i];
      den += (a.x - mx) ** 2 + (a.y - my) ** 2;
      count += 1;
      const b = readings[i + 1];
      if (!b || b.frame - a.frame !== 1 || (b.x === a.x && b.y === a.y)) continue;
      num += (a.x - mx) * (b.x - mx) + (a.y - my) * (b.y - my);
      pairs += 1;
    }
    holds += 1;
  }
  if (pairs < RHO_MIN_PAIRS || !(den > 0)) return null;
  const r = num / pairs / (den / count);
  const n = Math.max(4, Math.round(count / holds));
  if (!(r > lag1Expected(0, n))) return 0;
  let lo = 0;
  let hi = 0.95;
  for (let k = 0; k < 40; k += 1) {
    const mid = (lo + hi) / 2;
    if (lag1Expected(mid, n) < r) lo = mid;
    else hi = mid;
  }
  return clamp((lo + hi) / 2, 0, NOISE_RHO_MAX);
}

/**
 * What the pooled lag-1 autocorrelation of mean-removed series of length `n`
 * comes to, on average, when the truth is an AR(1) process with correlation
 * `rho`: the ratio of the expected cross products to the expected squares.
 */
function lag1Expected(rho, n) {
  let S = 0;
  for (let i = 0; i < n; i += 1) for (let j = 0; j < n; j += 1) S += rho ** Math.abs(i - j);
  let edge = 0;
  for (let j = 0; j < n; j += 1) edge += rho ** j;
  const cross = ((n - 1) * rho - (2 * S - 2 * edge) / n + ((n - 1) * S) / (n * n)) / (n - 1);
  const square = (n - S / n) / n;
  return cross / square;
}

/**
 * A look that can't have been at its dot, by the other rounds' account.
 *
 * The frame-by-frame checks can't see a hold whose eyes were somewhere else
 * the *whole* time — a fist closed before the eyes left the last dot. Three
 * rounds can: the other two agree about that dot and this one doesn't. A hold
 * the other rounds read more than three times the typical miss (and more than
 * 15% of the screen) from its dot is the one to drop — the worst such, never
 * a dot's last look, nor a second from a dot already dropped from. Simulated,
 * that caught such a hold every time at ordinary webcam noise, and dropping a
 * good hold by mistake cost nothing measurable.
 *
 * One at a time: a bad look is in the other rounds' training too, and bends
 * their readings of its neighbours, so each drop is followed by a fresh grade
 * before the next is judged. See `fitCalibration()`.
 *
 * A dot's last look is kept even when flagged — it may be the only evidence
 * of that corner — unless it plainly reads as another dot: its held-out
 * reading lands on another dot's (within a quarter of the distance between
 * the two dots). Then it was a look at that other dot, and keeping it would
 * drag every look there toward the wrong place; the result screen offers the
 * dot back instead.
 *
 * @param score `crossValidateRounds()`'s result for `holds`.
 * @param spared dots not to drop from again.
 * @returns the hold to drop, or null.
 */
export const INCONSISTENT_MISS = 3;
export const INCONSISTENT_FLOOR = 0.15;
export const INCONSISTENT_MAX = 3;
export const COINCIDENT_READING = 0.25;
export function inconsistentHold(holds, score, screenW, spared = new Set()) {
  if (!score?.holds?.length || !(screenW > 0)) return null;
  const typical = median(score.holds.map((h) => h.miss));
  const limit = Math.max(INCONSISTENT_MISS * typical, INCONSISTENT_FLOOR * screenW);
  const worst = score.holds.filter((h) => h.miss > limit).sort((a, b) => b.miss - a.miss);
  for (const bad of worst) {
    if (spared.has(bad.dot)) continue;
    const hold = (holds || []).find((h) => h.dot === bad.dot && (h.round ?? 0) === bad.round);
    if (!hold) continue;
    if (holds.filter((h) => h.dot === bad.dot).length < 2 && !readsAsAnotherDot(score, bad)) continue;
    return hold;
  }
  return null;
}

/**
 * Whether a look's held-out reading lands on another dot's.
 *
 * @param bad one of `score.holds`: `{ dot, x, y, px, py }`.
 */
function readsAsAnotherDot(score, bad) {
  return (score.dots || []).some(
    (d) =>
      d.dot !== bad.dot &&
      Math.hypot(d.px - bad.px, d.py - bad.py) < COINCIDENT_READING * Math.hypot(d.x - bad.x, d.y - bad.y)
  );
}

/**
 * Which expansion of the reading (`FEATURE_SETS`), which penalty (`LAMBDAS`)
 * and whether to add the nearest-neighbour step this calibration should be
 * fitted with: whichever reads the rounds best when each is read by a fit made
 * from the others — the grade's own question, asked of every candidate.
 *
 * Faces, cameras and seats differ in how bent the relation is and how noisy
 * the reading, so no one choice is best for everyone; with three rounds to
 * check against each other, the calibration can pick its own. The
 * nearest-neighbour step is a candidate rather than a given: it learns its
 * corrections from fits made with a round left out, and when a curved fit
 * reads the dots well already, those corrections can be mostly noise —
 * measured on synthetic eyes, a curved ridge alone missed by 10 px where adding
 * the step made it 70. Only rounds that can all be graded are trusted to choose
 * (see `crossValidateRounds()`'s `partial`); without them it is `DEFAULT_SPEC`.
 *
 * @returns `{ set, lambda, warp }`.
 */
export function chooseModel(holds, meta = {}) {
  const usable = (holds || []).filter((h) => h && (h.rows || []).some(validFeatures));
  if (new Set(usable.map((h) => h.round ?? 0)).size < 2) return DEFAULT_SPEC;
  let best = null;
  for (const warp of [false, true]) {
    for (const set of Object.keys(FEATURE_SETS)) {
      for (const lambda of LAMBDAS) {
        const spec = { set, lambda, warp };
        const score = crossValidateRounds(usable, (samples) => fitGazeCalibration(samples, { ...meta, spec }));
        if (score && !score.partial && Number.isFinite(score.errorPx) && (!best || score.errorPx < best.errorPx)) {
          best = { spec, errorPx: score.errorPx };
        }
      }
    }
  }
  return best ? best.spec : DEFAULT_SPEC;
}

/**
 * A whole calibration from the holds taken: choose how to fit it, fit, grade,
 * drop any look the other rounds say was somewhere else, and fit and grade
 * again without it.
 *
 * @param holds `{ rows, x, y, dot, round }` per hold taken (skipped ones absent).
 * @param meta as `fitGazeCalibration()` takes it.
 * @returns `{ ok, model, score, dropped }` — `score` as `crossValidateRounds()`
 *   returns it (null with one round), `dropped` the holds left out — or
 *   `{ ok: false, detail }`.
 */
export function fitCalibration(holds, meta = {}) {
  let used = (holds || []).filter((h) => h && (h.rows || []).some(validFeatures));
  let spec = chooseModel(used, meta);
  let fit = (samples) => fitGazeCalibration(samples, { ...meta, spec });
  let score = crossValidateRounds(used, fit);
  const dropped = [];
  // A partial grade can't say which looks disagree with the rest: some were never read.
  while (score && !score.partial && dropped.length < INCONSISTENT_MAX) {
    const bad = inconsistentHold(used, score, meta.screenW, new Set(dropped.map((h) => h.dot)));
    if (!bad) break;
    dropped.push(bad);
    used = used.filter((h) => h !== bad);
    score = crossValidateRounds(used, fit);
  }
  if (dropped.length) {
    // A look at the wrong dot can sway which fit reads best; choose again without it.
    spec = chooseModel(used, meta);
    fit = (samples) => fitGazeCalibration(samples, { ...meta, spec });
    score = crossValidateRounds(used, fit);
  }
  const fitted = fit(holdSamples(used));
  if (!fitted.ok) return fitted;
  const model = fitted.model;
  model.rounds = new Set(used.map((h) => h.round ?? 0)).size;
  model.holds = used.length;
  model.dropped = dropped.length;
  if (score) {
    model.error = score.error;
    model.errorPx = score.errorPx;
    model.errorMethod = score.partial ? 'rounds-partial' : 'rounds';
    if (score.noisePx > 0) model.noisePx = score.noisePx;
    if (score.noiseRho !== null) model.noiseRho = score.noiseRho;
  }
  return { ok: true, model, score, dropped };
}

/**
 * The offset that puts a re-centre dot back where it belongs.
 *
 * The model knows which way the head points, but not everything about how a
 * face sits after it has moved — slide along the sofa, slouch, and the whole
 * map can shift a little. Most of that shift is the same everywhere on screen,
 * so looking at one known dot measures it — a fraction of the cost of the full
 * thirty-nine. Measured through the whole model, nearest-neighbour step
 * included, but none of the old offset.
 */
export function recentreBias(model, rows, target) {
  const usable = (rows || []).filter(validFeatures);
  if (!usable.length) return null;
  const readings = usable.map((features) => predictUnbiased(model, features));
  return [target.x - median(readings.map((p) => p.x)), target.y - median(readings.map((p) => p.y))];
}

/**
 * Where the head was during calibration: medians of each pose reading, so a
 * later reading can say "you've moved since".
 */
export function poseSummary(poses) {
  const usable = (poses || []).filter(
    (p) => p && [p.yaw, p.pitch, p.span, p.x, p.y].every(Number.isFinite)
  );
  if (!usable.length) return null;
  const of = (key) => median(usable.map((p) => p[key]));
  return { yaw: of('yaw'), pitch: of('pitch'), span: of('span'), x: of('x'), y: of('y') };
}

/**
 * Has the head moved far enough from where it was during calibration that the
 * cursor will be off? `'turned'` and `'moved'` a re-centre fixes; `'distance'`
 * (closer to or farther from the camera) it doesn't, and needs a
 * recalibration.
 *
 * The head's pose is one of the model's inputs, so a turn or a shift within
 * what calibration saw is allowed for; these flag what lies well outside it —
 * a head turned 12° (yaw and pitch here are radians, from the face tracker's
 * pose matrix), or moved more than one and a half eye-spacings — where the
 * model is guessing beyond anything it learned from.
 */
export const DRIFT_TURN = (12 * Math.PI) / 180;
export const DRIFT_SHIFT = 1.5;
export const DRIFT_DISTANCE = [0.82, 1.22];

/**
 * @param reference, now pose readings from src/offscreen/eyes.js (or their
 *   medians): `yaw` and `pitch` as above, `x`/`y` where the eyes sit in the
 *   frame and `span` how far apart they are, both as fractions of the frame's
 *   width — so `span` is distance from the camera, and a shift in `x`/`y` can
 *   be measured in the eyes' own spacing.
 */
export function poseDrift(reference, now) {
  if (!reference || !now || !(reference.span > 0)) return null;
  const ratio = now.span / reference.span;
  if (!(ratio >= DRIFT_DISTANCE[0] && ratio <= DRIFT_DISTANCE[1])) return 'distance';
  if (Math.abs(now.yaw - reference.yaw) > DRIFT_TURN || Math.abs(now.pitch - reference.pitch) > DRIFT_TURN) {
    return 'turned';
  }
  if (Math.hypot(now.x - reference.x, now.y - reference.y) > DRIFT_SHIFT * reference.span) return 'moved';
  return null;
}

// ---------------------------------------------------------------------------
// Using a calibration
// ---------------------------------------------------------------------------

/** A fitted calibration, ready to predict from live features. */
export class GazeModel {
  constructor(model) {
    this.fit = model.fit;
    this.warp = Array.isArray(model.warp) && model.warp.length ? model.warp : null;
    this.bias = Array.isArray(model.bias) && model.bias.length === 2 && model.bias.every(Number.isFinite) ? model.bias : [0, 0];
    this.screenW = model.screenW;
    this.screenH = model.screenH;
    this.pose = model.pose || null;
    /** Per-axis frame-to-frame scatter while the eyes rest, px; null from calibrations that predate it. */
    this.noisePx = model.noisePx > 0 ? model.noisePx : null;
    /** How correlated consecutive readings are, 0 (independent, or not measured) to `NOISE_RHO_MAX`. */
    this.noiseRho = model.noiseRho >= 0 ? Math.min(model.noiseRho, NOISE_RHO_MAX) : 0;
  }

  /** Screen pixels, unsmoothed — or null if the reading isn't a number. */
  predict(features) {
    const p = predictPx(this, features);
    return Number.isFinite(p.x) && Number.isFinite(p.y) ? p : null;
  }
}

// ---------------------------------------------------------------------------
// Steering: the fixation filter
//
// Eyes don't glide. They rest on something, then jump. While they rest, the
// reading scatters by some share of the screen that depends on the person, the
// camera and the light — measured at calibration, `noisePx`. Everything below
// is in units of it.
//
// It replaces a filter that called any two readings more than an eighth of
// the screen from the cursor a jump. For a noisy webcam that is only one to
// three times its own scatter, so noise alone fired it one to three times a
// second and each time threw the cursor to the mean of two noisy readings:
// the cursor "moving around rapidly". Simulated at 20 fps against it, at the
// default setting, on sessions held out from its tuning: jumps while the eyes
// rest 5.6 → 0.3 a minute on an ordinary webcam, 42 → 0.6 on a noisy one,
// 119 → 1.2 on a bad one; the cursor's steady-state wobble 2.4 → 0.9,
// 4.6 → 1.3, 7.6 → 2.0% of the screen's width; a big jump followed in 50 ms
// (median) on an ordinary webcam as before, 100 ms on noisy and bad ones (50
// before). The price is small moves — under about twice the noise they can't
// be told from it, and are followed at the Smoothing pace instead.
// ---------------------------------------------------------------------------

/** Longest run of the newest readings tested as "the eyes have moved". */
const JUMP_RUN_MAX = 6;
/**
 * How many earlier readings of the resting eyes a run is compared against.
 * Short on purpose: a small jump the test missed is forgotten within half a
 * second instead of being held against the next one.
 */
const JUMP_REFERENCE = 10;
/** Evidence for a jump, in standard errors of the difference — and enough not to wait a reading to confirm it. */
const JUMP_EVIDENCE = 4.5;
const JUMP_EVIDENCE_NOW = 7;
/** A run's readings must all lie within this many noise units of their own mean: one wild reading can't make a run. */
const JUMP_AGREE = 3;
/** No single reading pulls the cursor, or the reference it's tested against, by more than this many noise units. */
const PULL_CLIP = 3;
/** A run needs at least this many readings of the rest before it to be compared against. */
const MIN_REFERENCE = 2;
/** A reset counts as this many readings at the seed point. */
const SEED_READINGS = 3;
/**
 * The averaging window while the eyes rest, at Smoothing 0 and at 1 (linear in
 * between, 750 ms at the default). The longer the eyes rest, the steadier the
 * cursor, up to this. Jump detection doesn't change with the setting: that is
 * set by the noise, not by taste.
 */
export const HOLD_WINDOW_MS = [250, 1250];
/** The live noise estimate: differences kept, and the calibration value's weight in differences. */
const NOISE_KEEP = 400;
const NOISE_PRIOR_WEIGHT = 100;
/**
 * The live estimate stays between the calibration's figure and twice it.
 *
 * Never below: frame-to-frame differences understate the noise whenever
 * consecutive readings aren't independent — a camera that sends some pictures
 * twice, or landmarks smoothed over time — and a noise figure talked down that
 * way lets the jump test fire on plain noise again. Simulated with a quarter of
 * the pictures repeated, a floor of half the figure brought back 30–57 false
 * jumps a minute; this floor, 3–16. It may still rise, for a camera noisier
 * than calibration saw.
 */
const NOISE_BOUNDS = [1, 2];
/** …and within these shares of the screen's width. */
const NOISE_ABS = [0.005, 0.25];
/** For a calibration that doesn't say how noisy it is (one made before it could), start from this share of the width… */
const NOISE_FALLBACK = 0.06;
/** …and let the live readings take over from that guess within a second or so. */
const NOISE_GUESS_WEIGHT = 5;
/** median |N(0, 2σ²)| = 0.6745·√2·σ: frame-to-frame differences to σ. */
const MEDIAN_ABS_DIFF = 0.6745 * Math.SQRT2;
/** Correlation between consecutive readings, as calibration measures it, is taken at most this high. */
export const NOISE_RHO_MAX = NOISE_RHO_LIMIT;
/** Frame-to-frame differences seen before the live figure may raise the correlation allowed for. */
const RHO_LIVE_MIN = 40;

/**
 * How much the mean of the newest `m` readings and the mean of the `nb` before
 * them differ by chance, in units of the per-reading variance, when each
 * reading is correlated with the one before by `rho` (an AR(1) process).
 * Independent readings (rho 0) give the textbook 1/m + 1/nb. Correlated ones
 * wander together: each short mean varies more, but neighbouring means also
 * move together, so the difference can vary more or less than that depending
 * on the lengths — this is the exact figure either way, rather than the
 * independent one a jump test would otherwise assume.
 */
export function meanDifferenceVariance(m, nb, rho) {
  const weights = [];
  for (let i = 0; i < nb; i += 1) weights.push(-1 / nb);
  for (let i = 0; i < m; i += 1) weights.push(1 / m);
  let v = 0;
  for (let i = 0; i < weights.length; i += 1) {
    for (let j = 0; j < weights.length; j += 1) v += weights[i] * weights[j] * rho ** Math.abs(i - j);
  }
  return v;
}

/**
 * The noise, kept up to date from the readings themselves.
 *
 * Starts at the calibration's figure; then the median absolute difference
 * between consecutive readings — which the occasional jump barely moves —
 * takes over as readings arrive. Keep one per calibration and hand it to every
 * filter, so it goes on learning across cursors. Bounded between the
 * calibration's figure and twice it (see `NOISE_BOUNDS`), so a stretch of odd
 * readings can't talk it into anything wild.
 *
 * @param noisePx the calibration's `noisePx`; falsy for one made before it was measured.
 * @param noiseRho the calibration's `noiseRho` — how correlated consecutive readings are.
 * @param screenW the calibrated screen's width, px.
 */
export function makeNoiseTracker({ noisePx, noiseRho = 0, screenW } = {}) {
  const W = screenW > 0 ? screenW : 1440;
  const measured = noisePx > 0;
  const calibrationPx = clamp(measured ? noisePx : NOISE_FALLBACK * W, NOISE_ABS[0] * W, NOISE_ABS[1] * W);
  // A measured figure is trusted as the floor; a guessed one (an older
  // calibration) gives way to the live readings, bounded only by sense.
  const priorWeight = measured ? NOISE_PRIOR_WEIGHT : NOISE_GUESS_WEIGHT;
  const lo = measured ? NOISE_BOUNDS[0] * calibrationPx : NOISE_ABS[0] * W;
  const hi = measured ? NOISE_BOUNDS[1] * calibrationPx : NOISE_ABS[1] * W;
  // Correlated consecutive readings differ by √(2(1 − ρ))·σ, not √2·σ.
  const rhoCalibrated = clamp(noiseRho > 0 ? noiseRho : 0, 0, NOISE_RHO_MAX);
  const toSigma = MEDIAN_ABS_DIFF * Math.sqrt(1 - rhoCalibrated);
  const diffs = [];
  let value = calibrationPx;
  let rho = rhoCalibrated;
  let added = 0;
  const refresh = () => {
    const k = diffs.length / 2;
    if (k < 10) {
      value = calibrationPx;
      rho = rhoCalibrated;
      return;
    }
    const sorted = [...diffs].sort((a, b) => a - b);
    const live = sorted[sorted.length >> 1] / toSigma;
    const blended = Math.sqrt((priorWeight * calibrationPx ** 2 + k * live ** 2) / (priorWeight + k));
    value = clamp(blended, lo, hi);
    // Differences smaller than the noise figure allows, at the correlation
    // calibration measured, mean more correlation than it measured — readings
    // taken faster than calibration's, say — since the figure itself may not
    // go lower. The jump test allows for exactly that much wander.
    const spread = sorted[sorted.length >> 1] / 0.6745;
    rho = k >= RHO_LIVE_MIN ? clamp(1 - (spread * spread) / (2 * value * value), rhoCalibrated, NOISE_RHO_MAX) : rhoCalibrated;
  };
  return {
    add(dx, dy) {
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
      // A picture the camera sent twice says nothing about the noise.
      if (dx === 0 && dy === 0) return;
      diffs.push(Math.abs(dx), Math.abs(dy));
      if (diffs.length > 2 * NOISE_KEEP) diffs.splice(0, 2);
      added += 1;
      if (added % 5 === 0) refresh();
    },
    get px() {
      return value;
    },
    /** The correlation to allow for: calibration's, or more if the live readings say so. */
    get rho() {
      return rho;
    }
  };
}

/**
 * The cursor's filter: hold still while the eyes rest, jump when they jump.
 *
 *   - While the eyes rest, the cursor is the mean of the readings since they
 *     settled (up to the Smoothing window; an exponential average beyond it),
 *     each reading's pull clipped so one wild reading can't drag it.
 *   - A jump is a change-point test. Every frame, each run of the newest 2 to
 *     `JUMP_RUN_MAX` readings is compared with the rest before it: how far
 *     apart are their means, in standard errors of that difference? A run
 *     whose readings also agree with each other, scoring over
 *     `JUMP_EVIDENCE_NOW`, moves the cursor to it at once; over
 *     `JUMP_EVIDENCE`, it must still score so with one more reading. Big jumps
 *     take two readings; small ones take more, because only more can tell them
 *     from noise.
 *
 * Readings that are correlated from one to the next — landmarks smoothed over
 * time do that — wander together, and would pass for a jump; the test allows
 * for exactly that much wander, as calibration measured it (`noiseRho`). A
 * reading identical to the last is a picture the camera sent twice and is
 * passed over.
 *
 * @param smoothing the Settings slider, 0 (twitchy) to 1 (damped).
 * @param noisePx the calibration's `noisePx`; falsy for an older calibration.
 * @param noiseRho the calibration's `noiseRho`; absent means independent readings.
 * @param screenW the calibrated screen's width, px.
 * @param fps readings a second, to turn the window into readings.
 * @param tracker a `makeNoiseTracker()` to share across cursors; one is made if absent.
 */
export function makeGazeFilter({ smoothing = 0.5, noisePx, noiseRho = 0, screenW, fps = 20, tracker = null } = {}) {
  const W = screenW > 0 ? screenW : 1440;
  const rho = clamp(noiseRho > 0 ? noiseRho : 0, 0, NOISE_RHO_MAX);
  const noise = tracker || makeNoiseTracker({ noisePx, noiseRho: rho, screenW: W });
  // How far two means differ by chance, per (run length, reference length) —
  // run lengths one past the longest too, for a run waiting to be confirmed —
  // for the correlation in force, in steps of 0.05.
  const tables = new Map();
  const tableFor = (r) => {
    const key = Math.round(clamp(r, 0, NOISE_RHO_MAX) * 20) / 20;
    if (!tables.has(key)) {
      const table = [];
      for (let m = 0; m <= JUMP_RUN_MAX + 1; m += 1) {
        table.push([]);
        for (let nb = 0; nb <= JUMP_REFERENCE; nb += 1) table[m].push(m && nb ? meanDifferenceVariance(m, nb, key) : 1);
      }
      tables.set(key, table);
    }
    return tables.get(key);
  };
  let chance = tableFor(rho);
  const s = clamp(Number.isFinite(smoothing) ? smoothing : 0.5, 0, 1);
  const holdMs = HOLD_WINDOW_MS[0] + (HOLD_WINDOW_MS[1] - HOLD_WINDOW_MS[0]) * s;
  const windowReadings = Math.max(3, Math.round((holdMs * (fps > 0 ? fps : 20)) / 1000));
  const keep = JUMP_REFERENCE + JUMP_RUN_MAX + 4;

  let sigma = noise.px;
  let rest = []; // readings of the current rest, oldest first
  let seen = 0; // readings so far, seed readings included
  let x = null; // the cursor
  let y = null;
  let n = 0; // readings in the current rest
  let pendingFrom = null; // `seen` at the start of a run waiting one reading to confirm
  let previous = null;

  const clip = (vx, vy) => {
    const r = Math.hypot(vx, vy);
    const limit = PULL_CLIP * sigma;
    return r > limit ? [(vx * limit) / r, (vy * limit) / r] : [vx, vy];
  };

  /** The newest `m` readings against up to `JUMP_REFERENCE` readings before them. */
  const test = (m) => {
    const L = rest.length;
    if (L - m < MIN_REFERENCE) return null;
    let rx = 0;
    let ry = 0;
    for (let i = L - m; i < L; i += 1) {
      rx += rest[i][0];
      ry += rest[i][1];
    }
    rx /= m;
    ry /= m;
    const from = Math.max(0, L - m - JUMP_REFERENCE);
    const nb = L - m - from;
    let bx = 0;
    let by = 0;
    for (let i = from; i < L - m; i += 1) {
      bx += rest[i][0];
      by += rest[i][1];
    }
    bx /= nb;
    by /= nb;
    if (nb >= 3) {
      // The reference, too, is not to be dragged by one wild reading (two passes).
      for (let pass = 0; pass < 2; pass += 1) {
        let sx = 0;
        let sy = 0;
        for (let i = from; i < L - m; i += 1) {
          const [vx, vy] = clip(rest[i][0] - bx, rest[i][1] - by);
          sx += vx;
          sy += vy;
        }
        bx += sx / nb;
        by += sy / nb;
      }
    }
    const z2 = ((rx - bx) ** 2 + (ry - by) ** 2) / (sigma * sigma * chance[m][nb]);
    let spread = 0;
    for (let i = L - m; i < L; i += 1) spread = Math.max(spread, Math.hypot(rest[i][0] - rx, rest[i][1] - ry));
    return { z2, m, rx, ry, agree: spread < JUMP_AGREE * sigma };
  };

  // Said on the reading that moved it, so a head-steered cursor knows the eyes went somewhere new.
  const jump = (run) => {
    rest = rest.slice(rest.length - run.m);
    n = run.m;
    x = run.rx;
    y = run.ry;
    pendingFrom = null;
    return { x, y, jumped: true };
  };

  return {
    /** Start again at a known point — the median of the readings so far, say. */
    reset(px, py) {
      rest = [];
      for (let i = 0; i < SEED_READINGS; i += 1) rest.push([px, py]);
      seen = SEED_READINGS;
      x = px;
      y = py;
      n = SEED_READINGS;
      pendingFrom = null;
      previous = null;
    },
    next(px, py) {
      if (!Number.isFinite(px) || !Number.isFinite(py)) return x === null ? null : { x, y };
      if (x === null) {
        this.reset(px, py);
        previous = [px, py];
        return { x, y };
      }
      // The same picture again: nothing new to learn from, or to test.
      if (previous && px === previous[0] && py === previous[1]) return { x, y };
      if (previous) noise.add(px - previous[0], py - previous[1]);
      previous = [px, py];
      sigma = clamp(noise.px, NOISE_ABS[0] * W, NOISE_ABS[1] * W);
      chance = tableFor(Math.max(rho, noise.rho ?? rho));

      rest.push([px, py]);
      seen += 1;
      if (rest.length > keep) rest.shift();

      // A run from the last reading that waited to be confirmed: one reading
      // longer, does it still say the eyes have moved?
      if (pendingFrom !== null) {
        const m = seen - pendingFrom;
        const run = m <= rest.length ? test(m) : null;
        pendingFrom = null;
        if (run && run.agree && run.z2 > JUMP_EVIDENCE ** 2) return jump(run);
      }
      let best = null;
      for (let m = 2; m <= JUMP_RUN_MAX; m += 1) {
        const run = test(m);
        if (!run) break;
        if (run.agree && run.z2 > JUMP_EVIDENCE ** 2 && (!best || run.z2 > best.z2)) best = run;
      }
      if (best && best.z2 > JUMP_EVIDENCE_NOW ** 2) return jump(best);
      if (best) pendingFrom = seen - best.m;

      // Still resting: fold the reading into the rest's mean.
      n += 1;
      const a = Math.max(1 / n, 1 / windowReadings);
      const [vx, vy] = clip(px - x, py - y);
      x += a * vx;
      y += a * vy;
      return { x, y };
    },
    /** The noise it is working to, px. */
    get noisePx() {
      return sigma;
    }
  };
}

// ---------------------------------------------------------------------------
// Screen and page, for the calibration page
//
// The eyes aim at the screen, and calibration happens fullscreen, so gaze is
// in screen pixels. src/content/content.js has the same arithmetic for any
// page (it can't import this module), plus what only a web page needs: the
// last real mouse movement, and a zoom level the worker reports.
// ---------------------------------------------------------------------------

/**
 * The page's zoom, as a fullscreen page can read it off itself: the screen is
 * `screen.width` CSS pixels at 100%, and a zoomed page's viewport is narrower or
 * wider than that by the zoom factor. Chrome's default zoom, or a Ctrl+ on any
 * of Jester's own pages (they share one zoom level), would otherwise put every
 * dot somewhere it isn't.
 */
function fullscreenZoom(win) {
  const z = win.screen.width / win.innerWidth;
  return Number.isFinite(z) && z > 0 ? z : 1;
}

/**
 * An element in fullscreen is the screen, less any band the system keeps at
 * the top of it (the camera housing on a notched laptop) — the same reading
 * the content script takes, so the dots here and the cursor there agree.
 */
function fullscreenTop(win) {
  return Math.max(0, win.screen.height - win.innerHeight * fullscreenZoom(win));
}

/**
 * Where the display a window is on starts, in desktop pixels. Chrome says only
 * where its *usable* area starts — below a menu bar, beside a dock — so a
 * usable area that begins a menu bar's height from the desktop's own corner is
 * taken to be the main display, whose corner is the origin.
 */
function displayOrigin(screen) {
  if (!screen.isExtended) return { x: 0, y: 0 };
  const left = screen.availLeft || 0;
  const top = screen.availTop || 0;
  return left === 0 && top <= 40 ? { x: 0, y: 0 } : { x: left, y: top };
}

/**
 * Where a window's page starts on its screen, in CSS pixels, or null when the
 * window's numbers can't be trusted (a side panel, page zoom).
 */
export function viewportOrigin(win) {
  const chromeX = win.outerWidth - win.innerWidth;
  const chromeY = win.outerHeight - win.innerHeight;
  if (!(chromeX >= 0 && chromeX <= 16 && chromeY >= 0 && chromeY <= 200)) return null;
  const display = displayOrigin(win.screen);
  // Side borders are split evenly, and the bottom one is as thick as a side.
  return {
    left: win.screenX - display.x + chromeX / 2,
    top: win.screenY - display.y + chromeY - chromeX / 2
  };
}

/** A point in a page, in screen pixels — or null if the window can't say. */
export function viewportToScreen(win, x, y) {
  if (win.document.fullscreenElement) {
    const zoom = fullscreenZoom(win);
    return { x: x * zoom, y: y * zoom + fullscreenTop(win) };
  }
  const origin = viewportOrigin(win);
  return origin && { x: x + origin.left, y: y + origin.top };
}

/** A point on the screen, in a page's client pixels — or null if the window can't say. */
export function screenToViewport(win, x, y) {
  if (win.document.fullscreenElement) {
    const zoom = fullscreenZoom(win);
    return { x: x / zoom, y: (y - fullscreenTop(win)) / zoom };
  }
  const origin = viewportOrigin(win);
  return origin && { x: x - origin.left, y: y - origin.top };
}
