import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HEAD_SWEEP, headPose, makeHeadPointer, makeOneEuro } from '../jester-extension/src/common/head.js';

const deg = (r) => (r * 180) / Math.PI;

/**
 * `facialTransformationMatrixes[0].data` exactly as the bundled face model
 * returned it for MediaPipe's own test portrait (storage.googleapis.com/
 * mediapipe-assets/portrait.jpg), as it is, mirrored, and turned in the image
 * plane by ±15° (canvas `rotate()`, so + is clockwise on screen).
 */
const MEASURED = {
  original: [1, 0.01, -0.025, 0, -0.009, 0.999, 0.054, 0, 0.026, -0.053, 0.998, 0, -0.423, 22.427, -65.273, 1],
  mirrored: [0.999, -0.019, 0.026, 0, 0.017, 0.998, 0.062, 0, -0.027, -0.061, 0.998, 0, 0.34, 22.481, -65.566, 1],
  clockwise15: [0.97, -0.238, -0.05, 0, 0.241, 0.968, 0.072, 0, 0.031, -0.082, 0.996, 0, 5.479, 22.308, -66.771, 1],
  anticlockwise15: [0.957, 0.284, -0.051, 0, -0.28, 0.957, 0.079, 0, 0.071, -0.062, 0.996, 0, -6.287, 21.669, -65.484, 1]
};

/** A column-major pose matrix for a head turned `yaw` to the user's right and tilted `pitch` up. */
function matrixFor(yaw, pitch, t = [0, 0, -60]) {
  // Forward axis: the user's right is the camera's −x; up is +y.
  const f = [-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
  // Up axis: perpendicular to forward, in the plane of forward and camera +y.
  const upGuess = [0, 1, 0];
  const dot = f[0] * upGuess[0] + f[1] * upGuess[1] + f[2] * upGuess[2];
  const u = [upGuess[0] - dot * f[0], upGuess[1] - dot * f[1], upGuess[2] - dot * f[2]];
  const un = Math.hypot(...u);
  const up = u.map((v) => v / un);
  // Right axis (canonical +x, the subject's left): up × forward.
  const r = [up[1] * f[2] - up[2] * f[1], up[2] * f[0] - up[0] * f[2], up[0] * f[1] - up[1] * f[0]];
  return [...r, 0, ...up, 0, ...f, 0, ...t, 1];
}

test('reads the measured portrait as facing the camera, about 65 cm away', () => {
  const pose = headPose(MEASURED.original);
  assert.ok(Math.abs(deg(pose.yaw)) < 3, `yaw ${deg(pose.yaw)}`);
  assert.ok(Math.abs(deg(pose.pitch)) < 5, `pitch ${deg(pose.pitch)}`);
  assert.ok(Math.abs(deg(pose.roll)) < 2, `roll ${deg(pose.roll)}`);
  assert.ok(pose.z > 60 && pose.z < 70, `z ${pose.z}`);
});

test('mirroring the picture mirrors the yaw and the side the head is on', () => {
  const a = headPose(MEASURED.original);
  const b = headPose(MEASURED.mirrored);
  assert.ok(Math.sign(a.yaw) === -Math.sign(b.yaw));
  assert.ok(Math.sign(a.x) === -Math.sign(b.x));
});

test('an in-plane tilt is roll, not yaw', () => {
  const cw = headPose(MEASURED.clockwise15);
  const acw = headPose(MEASURED.anticlockwise15);
  // Clockwise on screen: the top of the head goes to the picture's right, the user's left.
  assert.ok(deg(cw.roll) < -10 && deg(cw.roll) > -20, `cw roll ${deg(cw.roll)}`);
  assert.ok(deg(acw.roll) > 10 && deg(acw.roll) < 20, `acw roll ${deg(acw.roll)}`);
  for (const pose of [cw, acw]) assert.ok(Math.abs(deg(pose.yaw)) < 5, `yaw leaked: ${deg(pose.yaw)}`);
});

test('turning right and tilting up read as positive yaw and pitch', () => {
  const pose = headPose(matrixFor((10 * Math.PI) / 180, (5 * Math.PI) / 180));
  assert.ok(Math.abs(deg(pose.yaw) - 10) < 1e-6);
  assert.ok(Math.abs(deg(pose.pitch) - 5) < 1e-6);
  assert.ok(Math.abs(pose.roll) < 1e-9);
  assert.equal(pose.z, 60);
});

test('a lean reads as roll while turned and tilted', () => {
  // Turned 10° right, tilted 5° up, then leaning 12° toward the right shoulder: rotate up about forward.
  const m = matrixFor((10 * Math.PI) / 180, (5 * Math.PI) / 180);
  const f = m.slice(8, 11);
  const up = m.slice(4, 7);
  const right = m.slice(0, 3);
  const a = (12 * Math.PI) / 180;
  // Leaning to the user's right moves the top of the head toward the user's right, the canonical −x.
  const up2 = up.map((v, i) => Math.cos(a) * v - Math.sin(a) * right[i]);
  const right2 = right.map((v, i) => Math.cos(a) * v + Math.sin(a) * up[i]);
  const pose = headPose([...right2, 0, ...up2, 0, ...f, 0, 0, 0, -60, 1]);
  assert.ok(Math.abs(deg(pose.roll) - 12) < 1e-6, `roll ${deg(pose.roll)}`);
  assert.ok(Math.abs(deg(pose.yaw) - 10) < 1e-6 && Math.abs(deg(pose.pitch) - 5) < 1e-6);
});

test('refuses what is not a pose matrix', () => {
  assert.equal(headPose(null), null);
  assert.equal(headPose([1, 2, 3]), null);
  assert.equal(headPose(new Array(16).fill(0)), null);
  const bad = [...MEASURED.original];
  bad[9] = NaN;
  assert.equal(headPose(bad), null);
});

test('the One Euro filter holds a constant, quiets noise and follows a ramp', () => {
  let seed = 5;
  const noise = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32 - 0.5;
  };
  const steady = makeOneEuro({ minCutoff: 0.6, beta: 6 });
  let t = 0;
  for (let i = 0; i < 50; i += 1) steady.next(0.2, (t += 50));
  assert.ok(Math.abs(steady.value - 0.2) < 1e-12);

  const quiet = makeOneEuro({ minCutoff: 0.6, beta: 6 });
  t = 0;
  let inSq = 0;
  let outSq = 0;
  for (let i = 0; i < 400; i += 1) {
    const raw = 0.01 * noise();
    const out = quiet.next(raw, (t += 50));
    if (i > 50) {
      inSq += raw * raw;
      outSq += out * out;
    }
  }
  assert.ok(outSq < inSq / 4, `noise only reduced to ${Math.sqrt(outSq / inSq)}`);

  // A deliberate 30°/s turn: within a quarter of a second the filter has caught most of it up.
  const ramp = makeOneEuro({ minCutoff: 0.6, beta: 6 });
  t = 0;
  let value = 0;
  for (let i = 0; i < 20; i += 1) ramp.next(0, (t += 50));
  for (let i = 0; i < 10; i += 1) ramp.next((value += ((30 * Math.PI) / 180) * 0.05), (t += 50));
  for (let i = 0; i < 5; i += 1) ramp.next(value, (t += 50));
  assert.ok(Math.abs(ramp.value - value) < 0.1 * value, `lagging: ${ramp.value} vs ${value}`);
});

test('the head pointer moves the cursor the way the head turns, and drags its anchor at the edge', () => {
  const W = 1512;
  const H = 982;
  // A filter that passes everything at once, so positions can be checked exactly.
  const pointer = makeHeadPointer({ screenW: W, screenH: H, filter: { minCutoff: 1e6, beta: 0, dCutoff: 1 } });
  let t = 0;
  const feed = (yaw, pitch) => pointer.update({ yaw, pitch }, (t += 50));
  feed(0, 0);
  feed(0, 0);
  pointer.anchorAt(W / 2, H / 2);

  feed(HEAD_SWEEP.yaw / 4, 0);
  let p = pointer.position();
  assert.ok(Math.abs(p.x - (W / 2 + W / 4)) < 0.01, `turning right: ${p.x}`);
  assert.ok(Math.abs(p.y - H / 2) < 0.01);

  feed(0, HEAD_SWEEP.pitch / 4);
  p = pointer.position();
  assert.ok(Math.abs(p.y - (H / 2 - H / 4)) < 0.01, `tilting up: ${p.y}`);

  // Overshoot the right edge by a lot, then turn back a little: the cursor leaves the edge at once.
  feed(HEAD_SWEEP.yaw, 0);
  p = pointer.position();
  assert.equal(p.x, W);
  feed(HEAD_SWEEP.yaw - HEAD_SWEEP.yaw / 10, 0);
  p = pointer.position();
  assert.ok(Math.abs(p.x - (W - W / 10)) < 0.01, `after turning back: ${p.x}`);
});

test('a faster speed needs a smaller turn', () => {
  const slow = makeHeadPointer({ screenW: 1000, screenH: 1000, speed: 1 });
  const fast = makeHeadPointer({ screenW: 1000, screenH: 1000, speed: 2 });
  assert.ok(Math.abs(fast.gainX - 2 * slow.gainX) < 1e-9);
});
