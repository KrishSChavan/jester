import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BASE_FEATURES, readEyes } from '../jester-extension/src/offscreen/eyes.js';
import { BASE_FEATURE_COUNT } from '../jester-extension/src/common/gaze-store.js';

/**
 * The bundled face model's own output — landmarks, blendshapes and pose
 * matrix — for MediaPipe's test portrait (storage.googleapis.com/
 * mediapipe-assets/portrait.jpg), as it is and mirrored. Numbers only.
 */
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/portrait-face.json', import.meta.url)));
const read = (face, overrides = {}) =>
  readEyes(face.points, { blendshapes: face.blendshapes, matrix: face.matrix, width: face.width, height: face.height, ...overrides });

test('a real face reads as fourteen finite numbers, with eyes and head where they are', () => {
  assert.equal(BASE_FEATURES.length, BASE_FEATURE_COUNT);
  const eyes = read(FIXTURE.portrait);
  assert.ok(eyes);
  assert.equal(eyes.features.length, BASE_FEATURE_COUNT);
  assert.ok(eyes.features.every(Number.isFinite));
  // Open eyes: lid gap a quarter or so of the eye's width.
  assert.ok(eyes.openness > 0.15 && eyes.openness < 0.45, `openness ${eyes.openness}`);
  // A head-and-shoulders portrait 820 px wide: eyes a few dozen pixels across, about 80 px apart.
  assert.ok(eyes.eyeWidth > 20 && eyes.eyeWidth < 60, `eye width ${eyes.eyeWidth}`);
  assert.ok(eyes.span > 60 && eyes.span < 110, `span ${eyes.span}`);
  // Each iris sits within its eye.
  for (const u of [eyes.features[0], eyes.features[2]]) assert.ok(Math.abs(u) < 0.3);
  // Facing the camera.
  assert.ok(Math.abs(eyes.head.yaw) < 0.1 && Math.abs(eyes.head.pitch) < 0.15);
  for (const box of [eyes.boxes.left, eyes.boxes.right]) {
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.w <= FIXTURE.portrait.width && box.y + box.h <= FIXTURE.portrait.height);
  }
});

test('the mirror image reads as the mirror: head turn and sideways gaze flip, eyes stay symmetric', () => {
  const a = read(FIXTURE.portrait);
  const b = read(FIXTURE.mirrored);
  const yaw = BASE_FEATURES.indexOf('yaw');
  assert.ok(Math.sign(a.features[yaw]) === -Math.sign(b.features[yaw]));
  // The irises sit symmetrically in both: the two eyes' offsets along their corner lines cancel.
  for (const eyes of [a, b]) assert.ok(Math.abs(eyes.features[0] + eyes.features[2]) < 0.05);
  // The head's position across the picture flips too.
  const headX = BASE_FEATURES.indexOf('headX');
  assert.ok(Math.sign(a.features[headX]) === -Math.sign(b.features[headX]));
});

test('an eye off the edge of the picture is a guess, not a reading', () => {
  const face = FIXTURE.portrait;
  // Slide the whole face left until the right eye (image-left) hangs off the edge.
  const shifted = face.points.map((p) => ({ ...p, x: p.x - 0.45 }));
  assert.equal(readEyes(shifted, { blendshapes: face.blendshapes, matrix: face.matrix, width: face.width, height: face.height }), null);
});

test('without the blendshapes or the pose matrix there is nothing to read', () => {
  const face = FIXTURE.portrait;
  assert.equal(read(face, { blendshapes: null }), null);
  assert.equal(read(face, { matrix: null }), null);
  assert.equal(read(face, { width: 0 }), null);
  assert.equal(readEyes(face.points.slice(0, 400), { blendshapes: face.blendshapes, matrix: face.matrix, width: 820, height: 1024 }), null);
});
