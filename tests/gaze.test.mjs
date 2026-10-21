import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CALIBRATION_DOTS,
  FEATURE_SETS,
  GazeModel,
  chooseModel,
  crossValidateRounds,
  fitCalibration,
  fitGazeCalibration,
  gradeHold,
  holdSamples,
  inconsistentHold,
  makeGazeFilter,
  poseDrift,
  screenToViewport,
  summariseHold,
  viewportToScreen,
  warpCorrection
} from '../jester-extension/src/common/gaze.js';
import { BASE_FEATURE_COUNT, FEATURE_SET_SIZES, calibrationStale, usableModel } from '../jester-extension/src/common/gaze-store.js';

const W = 1512;
const H = 982;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/**
 * A synthetic face looking at (x, y) on the screen: the eye-in-head angle is
 * the gaze direction less the head's turn, and the iris offset is a saturating
 * function of it (it travels less near the edges); blendshapes, lids and head
 * follow suit, with noise. Not MediaPipe — a stand-in with the same shape of
 * relation, to check the fitting machinery learns it.
 */
function face(x, y, head, r, noise = 0.004, bend = 1.6) {
  const gx = ((x / W - 0.5) * 30 * Math.PI) / 180; // the screen spans ~30° across
  const gy = ((y / H - 0.5) * 20 * Math.PI) / 180;
  const eyeYaw = gx - head.yaw;
  const eyePitch = gy + head.pitch;
  const u = (0.32 * Math.tanh(eyeYaw * bend)) / (bend / 1.6);
  const v = (0.22 * Math.tanh(eyePitch * bend)) / (bend / 1.6);
  const n = () => (r() - 0.5) * 2 * noise;
  const ear = 0.3 - 0.25 * v;
  return [
    -u + n(), v + n(), -u + n(), v + n(), ear + n(), ear + n(),
    // The face model's blendshapes saturate too, and are noisier than the iris.
    -0.8 * Math.tanh(eyeYaw * bend * 1.5) + n() * 10, -0.8 * Math.tanh(eyePitch * bend * 1.5) + n() * 10,
    head.yaw, head.pitch, 0.01, head.x, head.y, 1
  ];
}

/** Three rounds of thirteen holds of `frames` frames each, the head wandering a little between rounds. */
function calibrationHolds(seed = 1, { frames = 9, wander = 0.03, bend = 1.6 } = {}) {
  const r = rng(seed);
  const holds = [];
  for (let round = 0; round < 3; round += 1) {
    CALIBRATION_DOTS.forEach((dot, index) => {
      const head = { yaw: (r() - 0.5) * wander, pitch: (r() - 0.5) * wander, x: (r() - 0.5) * 0.02, y: (r() - 0.5) * 0.02 };
      const x = dot.x * W;
      const y = dot.y * H;
      const rows = Array.from({ length: frames }, () => face(x, y, head, r, 0.004, bend));
      holds.push({ rows, index: rows.map((_, i) => i), x, y, dot: index, round });
    });
  }
  return holds;
}

const meta = { screenW: W, screenH: H, cameraId: 'cam' };

test('a calibration learns where the synthetic eyes look, and grades itself honestly', () => {
  const holds = calibrationHolds(3);
  assert.equal(holds[0].rows[0].length, BASE_FEATURE_COUNT);
  const fitted = fitCalibration(holds, meta);
  assert.ok(fitted.ok, fitted.detail);
  const model = fitted.model;
  assert.ok(usableModel(model, { cameraId: 'cam' }), 'the result is storable and usable');
  assert.equal(calibrationStale(model, { screenW: W, screenH: H, cameraId: 'cam' }), null);
  assert.equal(model.errorMethod, 'rounds');
  assert.ok(model.error < 0.05, `held-out error ${model.error}`);

  // Fresh looks, with the head turned 4° — within what the model can allow for.
  const live = new GazeModel(model);
  const r = rng(99);
  let worst = 0;
  for (let i = 0; i < 40; i += 1) {
    const x = (0.1 + 0.8 * r()) * W;
    const y = (0.1 + 0.8 * r()) * H;
    const head = { yaw: 0.07 * (r() - 0.5), pitch: 0.07 * (r() - 0.5), x: 0, y: 0 };
    const p = live.predict(face(x, y, head, r));
    worst = Math.max(worst, Math.hypot(p.x - x, p.y - y));
  }
  assert.ok(worst < 0.12 * W, `worst miss ${Math.round(worst)} px`);
});

test('the chosen fit bends where the relation bends, and is never worse than a straight one', () => {
  // Strongly saturating: at the screen's edges the iris travels a quarter less than a straight line says.
  const holds = calibrationHolds(5, { bend: 4 });
  const spec = chooseModel(holds, meta);
  assert.notEqual(spec.set, 'linear', 'a saturating iris needs the curved terms');
  const errorOf = (s) => crossValidateRounds(holds, (samples) => fitGazeCalibration(samples, { ...meta, spec: s })).errorPx;
  assert.ok(errorOf(spec) <= errorOf({ set: 'linear', lambda: spec.lambda, warp: true }) + 1e-9);
});

test('a round that cannot be graded makes the grade partial, not silently smaller', () => {
  const holds = calibrationHolds(7).filter((h) => h.round === 0 || h.dot < 3);
  const score = crossValidateRounds(holds, (samples) => fitGazeCalibration(samples, meta));
  assert.ok(score);
  assert.equal(score.partial, true);
  const fitted = fitCalibration(holds, meta);
  assert.equal(fitted.model.errorMethod, 'rounds-partial');
});

test("a dot's only look, taken with the eyes on another dot, is dropped — with or without the nearest-neighbour step", () => {
  // The right-middle dot kept one look, and the fist closed on it while the eyes were still on the centre.
  const holds = calibrationHolds(11).filter((h) => !(h.dot === 4 && h.round !== 0));
  const wrong = holds.find((h) => h.dot === 4);
  const r = rng(12);
  wrong.rows = wrong.rows.map(() => face(0.5 * W, 0.5 * H, { yaw: 0, pitch: 0, x: 0, y: 0 }, r));
  for (const warp of [false, true]) {
    const spec = { set: 'curved', lambda: 0.01, warp };
    const score = crossValidateRounds(holds, (samples) => fitGazeCalibration(samples, { ...meta, spec }));
    assert.equal(inconsistentHold(holds, score, W), wrong, `warp ${warp}`);
  }
  const fitted = fitCalibration(holds, meta);
  assert.ok(fitted.ok, fitted.detail);
  assert.deepEqual(fitted.dropped, [wrong]);
  // A last look that is merely poor, not at another dot, is kept: it may be all there is of that corner.
  const poor = calibrationHolds(11).filter((h) => !(h.dot === 4 && h.round !== 0));
  const lone = poor.find((h) => h.dot === 4);
  lone.rows = lone.rows.map(() => face(0.75 * W, 0.5 * H, { yaw: 0, pitch: 0, x: 0, y: 0 }, r));
  assert.ok(!fitCalibration(poor, meta).dropped.includes(lone));
});

test('the nearest-neighbour correction never jumps', () => {
  const r = rng(11);
  const warp = Array.from({ length: 13 }, () => [r() * W, r() * H, (r() - 0.5) * 200, (r() - 0.5) * 200]);
  let worst = 0;
  for (let y = 0; y < H; y += 7) {
    let prev = warpCorrection(warp, 0, y);
    for (let x = 0.5; x < W; x += 0.5) {
      const c = warpCorrection(warp, x, y);
      worst = Math.max(worst, Math.hypot(c.x - prev.x, c.y - prev.y));
      prev = c;
    }
  }
  assert.ok(worst < 5, `largest change over half a pixel: ${worst.toFixed(1)} px`);
  // A calibrated dot's own reading still lands exactly on its dot.
  const own = warpCorrection(warp, warp[4][0], warp[4][1]);
  assert.ok(Math.abs(own.x - warp[4][2]) < 1e-6 && Math.abs(own.y - warp[4][3]) < 1e-6);
});

test('a stored calibration with a malformed offset is refused, not crashed on', () => {
  const model = fitCalibration(calibrationHolds(2), meta).model;
  assert.ok(usableModel(model));
  assert.equal(usableModel({ ...model, bias: { x: 0, y: 0 } }), false);
  assert.equal(usableModel({ ...model, bias: [3] }), false);
  // An old WebGazer calibration is out of date, and says so.
  assert.equal(usableModel({ kind: 'webgazer-ridge', featureVersion: 1, cx: [], cy: [], screenW: W, screenH: H }), false);
  assert.match(calibrationStale({ kind: 'webgazer-ridge' }), /new way/);
});

test('a stored fit is read only with a feature set this build has, at its length', () => {
  assert.deepEqual(Object.keys(FEATURE_SET_SIZES).sort(), Object.keys(FEATURE_SETS).sort());
  for (const [name, expand] of Object.entries(FEATURE_SETS)) {
    assert.equal(expand(new Array(BASE_FEATURE_COUNT).fill(0.1)).length, FEATURE_SET_SIZES[name], name);
  }
  const { model } = fitCalibration(calibrationHolds(4), meta);
  assert.ok(usableModel(model));
  // From another build: a set this one doesn't have, or the same name at another length.
  assert.equal(usableModel({ ...model, fit: { ...model.fit, set: 'quadratic' } }), false);
  const other = model.fit.set === 'linear' ? 'curved' : 'linear';
  assert.equal(usableModel({ ...model, fit: { ...model.fit, set: other } }), false);
  assert.equal(usableModel({ ...model, fit: { ...model.fit, set: 'constructor' } }), false);
});

test('a hold read from too far away says so, rather than blaming the light', () => {
  const r = rng(21);
  const frame = (far) => ({ face: true, occluded: false, far, features: face(W / 2, H / 2, { yaw: 0, pitch: 0, x: 0, y: 0 }, r), ear: 0.3, iris: [0, 0] });
  const tooFar = summariseHold(Array.from({ length: 12 }, (_, i) => frame(i % 4 !== 0)));
  assert.equal(tooFar.far, 9);
  assert.equal(tooFar.unreadable, 0);
  assert.deepEqual(gradeHold(tooFar), { verdict: 'reject', reason: 'too-far' });
  // Near enough throughout: a good hold, as before.
  assert.equal(gradeHold(summariseHold(Array.from({ length: 12 }, () => frame(false)))).verdict, 'ok');
});

test('the filter says when the eyes jumped', () => {
  const filter = makeGazeFilter({ noisePx: 10, screenW: W, fps: 20 });
  const r = rng(4);
  let jumped = false;
  for (let i = 0; i < 20; i += 1) filter.next(300 + (r() - 0.5) * 10, 300 + (r() - 0.5) * 10);
  for (let i = 0; i < 4 && !jumped; i += 1) jumped = !!filter.next(1100 + (r() - 0.5) * 10, 600 + (r() - 0.5) * 10).jumped;
  assert.ok(jumped);
});

test('a head turned or moved far beyond calibration is flagged; a small one is not', () => {
  const ref = { yaw: 0, pitch: 0, x: 0.5, y: 0.3, span: 0.06 };
  assert.equal(poseDrift(ref, { ...ref, yaw: 0.05 }), null);
  assert.equal(poseDrift(ref, { ...ref, yaw: 0.3 }), 'turned');
  assert.equal(poseDrift(ref, { ...ref, x: 0.5 + 0.2 }), 'moved');
  assert.equal(poseDrift(ref, { ...ref, span: 0.04 }), 'distance');
});

test('fullscreen page coordinates allow for page zoom', () => {
  const screen = { width: 1920, height: 1080, isExtended: false };
  // 125% zoom: the viewport is 1536 × 864 CSS px.
  const win = { screen, innerWidth: 1536, innerHeight: 864, document: { fullscreenElement: {} } };
  const s = viewportToScreen(win, 768, 432);
  assert.ok(Math.abs(s.x - 960) < 1e-9 && Math.abs(s.y - 540) < 1e-9, JSON.stringify(s));
  const back = screenToViewport(win, 960, 540);
  assert.ok(Math.abs(back.x - 768) < 1e-9 && Math.abs(back.y - 432) < 1e-9);
  // 100% zoom with a notch band: the page starts below it.
  const notched = { screen: { width: 1512, height: 982 }, innerWidth: 1512, innerHeight: 950, document: { fullscreenElement: {} } };
  assert.equal(viewportToScreen(notched, 0, 0).y, 32);
});

test('a windowed page on the main display ignores the menu bar as a display offset', () => {
  const win = {
    screen: { width: 1512, height: 982, isExtended: true, availLeft: 0, availTop: 34 },
    outerWidth: 1512, innerWidth: 1512, outerHeight: 948, innerHeight: 860, screenX: 0, screenY: 34,
    document: { fullscreenElement: null }
  };
  const p = viewportToScreen(win, 0, 0);
  assert.equal(p.y, 34 + (948 - 860));
});

test('holds become samples labelled by round and hold', () => {
  const samples = holdSamples([{ rows: [[1], [2]], x: 1, y: 2, dot: 3, round: 1 }, null]);
  assert.equal(samples.length, 2);
  assert.equal(samples[0].hold, '1:3');
});
