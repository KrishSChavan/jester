/**
 * Whether it was the user who said something: their face, in front of the camera, talking while it was heard. For
 * training mode (voice-training.js), where what's said with that face teaches him the user's voice, so that with it
 * off he's surer it's them when they just speak.
 *
 * The engine page reads the face from each camera frame while training mode is on, or while the face is being
 * scanned (offscreen.js `faceWatch`), and sends what jester-extension/src/common/face-print.js makes of it: its
 * shape, how far open its mouth is, which way it points. That, and how loud the always-on mic was, millisecond by
 * millisecond, is kept here for the last minute and a half, so that a line can be judged once it's over:
 *
 *   - seen: a face was in view for most of the time it was said;
 *   - theirs: that face is the one scanned (its shape, within the scan's own spread and some more);
 *   - talking: its mouth was moving, and, for a line long enough to tell, moving with the sound: louder as it opened.
 *     A mouth chewing while the television talks moves, but not with what's heard.
 *
 * The scan is three seconds of a face looking at the camera: the mean of its shapes, and how much they varied.
 * Nothing else is kept: no picture, and nothing of the face that could be made back into one.
 *
 * Pure but for the clock (`now`), so it's tested with readings made up for it.
 */

import { shapeDistance, SHAPE_SIZE } from '../../../jester-extension/src/common/face-print.js';

/** What the camera and the mic took in is kept this long, for a line to be judged by once it's over. */
const KEEP_MS = 90_000;
/** A face read within this of a moment counts as in view then; the engine reads 20 a second. */
const READ_GAP_MS = 160;
/** A line is looked at over this much more either side of it: the clocks of the mic, the camera and a server differ a little. */
const SLACK_MS = 300;
/** Of a line's time, at least this much with a face in view, or nothing's said of whose it was. */
const SEEN_SHARE = 0.6;
/** Of the readings that could tell whose face it was, at least this many and this share must be the user's. */
const THEIRS_MIN = 3;
const THEIRS_SHARE = 0.6;
/** How far open and shut the mouth went (the spread of its middle 80%) for it to be moving, and at most for it to be still. */
export const MOVING = 0.06;
export const STILL = 0.025;
/**
 * For a line this long, the mouth must move with the sound: their correlation at its best within LAG_MS either way
 * at least SYNC_MIN. A shorter one ("yes") is too few readings to tell, and its mouth moving is enough.
 */
export const SYNC_FROM_MS = 1500;
export const SYNC_MIN = 0.1;
const LAG_MS = 300;
const BIN_MS = 50;
/** Fewer pairs of readings than this, and no correlation is worked out. */
const SYNC_PAIRS = 12;
const SYNC_MOST_MS = 8000;
/** The mic's loudness is kept for every 32 ms of it. */
const FRAME = 512;
const RATE = 16000;
/** The scan: this many readings of a face square to the camera, over at least this long, given this long to get them. */
const SCAN_READS = 24;
const SCAN_MIN_MS = 2500;
const SCAN_GIVE_UP_MS = 20000;
/**
 * A reading is the scanned face when its shape is within this many times the scan's own spread of it, and never less
 * than TOLERANCE_MIN or more than TOLERANCE_MAX apart: a face read a day later, in other light, doesn't read
 * exactly as it did, and two faces are seldom more alike than TOLERANCE_MAX.
 */
const TOLERANCE_TIMES = 4;
export const TOLERANCE_MIN = 0.03;
export const TOLERANCE_MAX = 0.06;
/** Whether a face is in front of the camera now, for Settings: from the last this long of readings. */
const NOW_MS = 1500;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const round = (value) => Math.round(value * 1000) / 1000;
const quantile = (sorted, share) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(share * (sorted.length - 1))))];

/** How far apart a reading may be from the scanned face and still be it. */
export const tolerance = (print) => clamp((Number(print?.spread) || 0) * TOLERANCE_TIMES, TOLERANCE_MIN, TOLERANCE_MAX);

/** Whether a face's shape is the scanned face's. */
export function isTheirs(shape, print) {
  return !!print?.shape && Array.isArray(shape) && shapeDistance(shape, print.shape) <= tolerance(print);
}

/**
 * A scanned face, from its readings: the mean of their shapes, the worst fifth left out (a blink, a turn), and how
 * far from it they were, at the median. Null with too few to go on.
 * @param {number[][]} shapes
 * @returns {{shape:number[], spread:number, reads:number}|null}
 */
export function printFrom(shapes) {
  const usable = (shapes || []).filter((shape) => Array.isArray(shape) && shape.length === SHAPE_SIZE && shape.every(Number.isFinite));
  if (usable.length < SCAN_READS) return null;
  const meanOf = (list) => list[0].map((_, i) => list.reduce((sum, shape) => sum + shape[i], 0) / list.length);
  const first = meanOf(usable);
  const kept = usable
    .map((shape) => ({ shape, apart: shapeDistance(shape, first) }))
    .sort((a, b) => a.apart - b.apart)
    .slice(0, Math.max(SCAN_READS, Math.ceil(usable.length * 0.8)))
    .map(({ shape }) => shape);
  const shape = meanOf(kept).map((value) => Math.round(value * 1e4) / 1e4);
  const apart = kept.map((one) => shapeDistance(one, shape)).sort((a, b) => a - b);
  return { shape, spread: Math.round(quantile(apart, 0.5) * 1e4) / 1e4, reads: kept.length };
}

/** How far the mouth opened and shut: the spread of the middle 80% of its readings. */
export function mouthMotion(openings) {
  const values = (openings || []).filter(Number.isFinite).sort((a, b) => a - b);
  if (values.length < 3) return null;
  return quantile(values, 0.9) - quantile(values, 0.1);
}

/** Pearson's correlation of two series of the same length, over the places both have a number; null with too few. */
export function correlation(a, b) {
  const pairs = [];
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) if (Number.isFinite(a[i]) && Number.isFinite(b[i])) pairs.push([a[i], b[i]]);
  if (pairs.length < SYNC_PAIRS) return null;
  const mean = (k) => pairs.reduce((sum, pair) => sum + pair[k], 0) / pairs.length;
  const [ma, mb] = [mean(0), mean(1)];
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (const [x, y] of pairs) {
    ab += (x - ma) * (y - mb);
    aa += (x - ma) ** 2;
    bb += (y - mb) ** 2;
  }
  return aa > 1e-12 && bb > 1e-12 ? ab / Math.sqrt(aa * bb) : null;
}

/**
 * Whether the mouth moved with the sound: the mouth's opening and the mic's loudness, each in BIN_MS steps over
 * [from, to], correlated at the lag that agrees best, within LAG_MS either way (the camera's picture and the mic's
 * sound don't reach here at quite the same moment). Null when there's too little of either.
 * @param {{at:number, mouth:number|null}[]} reads  face readings, oldest first
 * @param {{at:number, level:number}[]} loudness  the mic's, oldest first
 */
export function moveWithSound(reads, loudness, from, to) {
  // The first SYNC_MOST_MS of a long line says as much as all of it.
  const bins = Math.floor((Math.min(to, from + SYNC_MOST_MS) - from) / BIN_MS);
  if (bins < SYNC_PAIRS) return null;
  const sounds = loudness.filter((frame) => frame.at >= from - LAG_MS - BIN_MS && frame.at <= to + LAG_MS + BIN_MS);
  const mouthAt = (time) => {
    // The nearest reading within READ_GAP_MS.
    let best = null;
    for (const read of reads) {
      if (!Number.isFinite(read.mouth)) continue;
      const gap = Math.abs(read.at - time);
      if (gap <= READ_GAP_MS && (!best || gap < best.gap)) best = { gap, value: read.mouth };
    }
    return best ? best.value : NaN;
  };
  const levelIn = (start) => {
    const inside = sounds.filter((frame) => frame.at >= start && frame.at < start + BIN_MS);
    return inside.length ? inside.reduce((sum, frame) => sum + frame.level, 0) / inside.length : NaN;
  };
  const mouth = Array.from({ length: bins }, (_, i) => mouthAt(from + (i + 0.5) * BIN_MS));
  let best = null;
  for (let lag = -LAG_MS; lag <= LAG_MS; lag += BIN_MS) {
    const sound = Array.from({ length: bins }, (_, i) => levelIn(from + i * BIN_MS + lag));
    const r = correlation(mouth, sound);
    if (r !== null && (best === null || r > best)) best = r;
  }
  return best;
}

/**
 * What the camera says of a line, from the readings and the mic's loudness kept: `verdict` is 'speaking' (the user's
 * face, talking with it), 'silent' (theirs, its mouth still: someone else said it), 'someone' (a face that isn't
 * theirs), 'unseen' (no face in view for most of it) or 'unclear'.
 * @param {{from:number, to:number}} line  when it was said, on this computer's clock
 * @param {{reads:object[], loudness:object[], print:object|null}} kept
 */
export function judgeLine({ from, to }, { reads, loudness, print }) {
  const lasted = to - from;
  if (!(lasted > 0) || !print) return { verdict: 'unclear', seen: 0 };
  const near = reads.filter((read) => read.at >= from - SLACK_MS && read.at <= to + SLACK_MS);
  const faces = near.filter((read) => read.face);
  // How much of the time a face was in view: every BIN_MS of the line, with a face read near it.
  const steps = Math.max(1, Math.floor(lasted / BIN_MS));
  let covered = 0;
  for (let i = 0; i < steps; i += 1) {
    const time = from + (i + 0.5) * BIN_MS;
    if (faces.some((read) => Math.abs(read.at - time) <= READ_GAP_MS + SLACK_MS / 2)) covered += 1;
  }
  const seen = covered / steps;
  const told = faces.filter((read) => Array.isArray(read.shape));
  const theirs = told.filter((read) => isTheirs(read.shape, print)).length;
  const share = told.length ? theirs / told.length : 0;
  const during = faces.filter((read) => read.at >= from - SLACK_MS / 2 && read.at <= to + SLACK_MS / 2);
  const motion = mouthMotion(during.map((read) => read.mouth));
  const sync = lasted >= SYNC_FROM_MS ? moveWithSound(during, loudness, from, to) : null;
  const facts = { seen: round(seen), theirs: round(share), told: told.length, motion: motion === null ? null : round(motion), sync: sync === null ? null : round(sync) };
  if (seen < SEEN_SHARE) return { verdict: 'unseen', ...facts };
  if (told.length < THEIRS_MIN || share < THEIRS_SHARE) return { verdict: told.length < THEIRS_MIN ? 'unclear' : 'someone', ...facts };
  if (motion !== null && motion <= STILL) return { verdict: 'silent', ...facts };
  if (motion === null || motion < MOVING) return { verdict: 'unclear', ...facts };
  // Long enough to tell, and the mic heard nothing with it, or the mouth moved out of time with what it heard.
  if (lasted >= SYNC_FROM_MS && (sync === null || sync < SYNC_MIN)) return { verdict: 'unclear', why: 'out of time', ...facts };
  return { verdict: 'speaking', ...facts };
}

/**
 * @param {object} [deps]
 * @param {() => number} [deps.now]
 * @param {(seen:'you'|'someone'|'turned'|'none') => void} [deps.onSeen]  who's in front of the camera changed
 */
export function createFaceWitness({ now = Date.now, onSeen = () => undefined } = {}) {
  /** The face's readings, oldest first: {at, face:false} or {at, face:true, shape, mouth, span, yaw, pitch}. */
  let reads = [];
  /** The mic's loudness, oldest first: {at, level}. */
  let loudness = [];
  let print = null;
  /** The scan going on: its readings, when it began, and what to tell. */
  let scan = null;
  let lastSeen = 'none';

  const trim = (list) => {
    const since = now() - KEEP_MS;
    let first = 0;
    while (first < list.length && list[first].at < since) first += 1;
    return first ? list.slice(first) : list;
  };

  /**
   * Who's in front of the camera, from the last NOW_MS of readings: 'you', 'someone' (a face that isn't the one
   * scanned, or any face before there's been a scan), 'turned' (a face turned too far away, or too far off, to tell
   * whose) or 'none'.
   */
  function seenNow() {
    const since = now() - NOW_MS;
    const faces = reads.filter((read) => read.at >= since && read.face);
    if (!faces.length) return 'none';
    const told = faces.filter((read) => Array.isArray(read.shape));
    if (!told.length) return 'turned';
    if (!print) return 'someone';
    return told.filter((read) => isTheirs(read.shape, print)).length / told.length >= 0.5 ? 'you' : 'someone';
  }

  function scanned(read) {
    if (!scan || !read.face || !Array.isArray(read.shape)) return;
    scan.shapes.push(read.shape);
    const lasted = now() - scan.startedAt;
    scan.onProgress(Math.min(1, Math.min(scan.shapes.length / SCAN_READS, lasted / SCAN_MIN_MS)));
    if (scan.shapes.length < SCAN_READS || lasted < SCAN_MIN_MS) return;
    const made = printFrom(scan.shapes);
    const done = scan;
    scan = null;
    clearTimeout(done.timer);
    if (made) done.resolve(made);
    else done.reject(new Error('He couldn’t get a clear look at your face. Face the camera in some light, and try again.'));
  }

  return {
    /** One reading from the engine: {at, face:false}, or a face (face-print.js faceReading) with `at`. */
    read(sample) {
      if (!sample || !Number.isFinite(sample.at)) return;
      const read = sample.face === false
        ? { at: sample.at, face: false }
        : { at: sample.at, face: true, shape: Array.isArray(sample.shape) && sample.shape.length === SHAPE_SIZE ? sample.shape : null, mouth: Number.isFinite(sample.mouth) ? sample.mouth : null, span: Number(sample.span) || 0, yaw: sample.yaw ?? null, pitch: sample.pitch ?? null };
      reads.push(read);
      reads = trim(reads);
      scanned(read);
      const seen = seenNow();
      if (seen !== lastSeen) {
        lastSeen = seen;
        onSeen(seen);
      }
    },
    /** What the always-on mic heard, as it reached here (`at`: when its last sample did): its loudness is kept. */
    audio(samples, at = now()) {
      const count = samples?.length || 0;
      if (!count) return;
      const added = [];
      for (let start = 0; start + FRAME <= count; start += FRAME) {
        let sum = 0;
        for (let i = start; i < start + FRAME; i += 1) sum += samples[i] * samples[i];
        added.push({ at: at - ((count - start - FRAME / 2) / RATE) * 1000, level: Math.sqrt(sum / FRAME) });
      }
      loudness.push(...added);
      loudness = trim(loudness);
    },
    /** The scanned face to compare with, or null. */
    setPrint(next) {
      print = next?.shape?.length === SHAPE_SIZE ? next : null;
    },
    get print() {
      return print;
    },
    /** Who's in front of the camera now: 'you', 'someone', 'turned' or 'none' (seenNow). */
    seen: () => seenNow(),
    /**
     * Scans the face in front of the camera: resolves with what's kept of it (printFrom), or rejects in words.
     * @param {{onProgress?: (share:number) => void}} [options]
     */
    scan({ onProgress = () => undefined } = {}) {
      scan?.reject(new Error('Scanning again.'));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (scan?.timer !== timer) return;
          scan = null;
          reject(new Error('He couldn’t see a face for long enough. Sit in front of the camera, in some light, and try again.'));
        }, SCAN_GIVE_UP_MS);
        scan = { shapes: [], startedAt: now(), onProgress, resolve, reject, timer };
        onProgress(0);
      });
    },
    get scanning() {
      return !!scan;
    },
    cancelScan() {
      if (!scan) return;
      const done = scan;
      scan = null;
      clearTimeout(done.timer);
      done.reject(Object.assign(new Error('Stopped.'), { cancelled: true }));
    },
    /** What the camera says of a line said over [from, to], on this computer's clock (judgeLine). */
    judge(line) {
      return judgeLine(line, { reads, loudness, print });
    },
    /**
     * The same, for a line a server heard, told as how long before now (its clock) it began and how long it lasted:
     * a server's clock may be off from this one, and how long ago isn't. Its sound took `delay` ms to get there.
     */
    judgeAgo({ ago, lasted, delay = 120 }) {
      const to = now() - (Number(ago) - Number(lasted)) - delay;
      return judgeLine({ from: to - Number(lasted), to }, { reads, loudness, print });
    }
  };
}
