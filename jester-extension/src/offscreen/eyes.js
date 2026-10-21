/**
 * Reading the eyes and the head off MediaPipe's face tracker.
 *
 * Everything here comes from the tracker's own outputs — its 478 landmarks,
 * its blendshape scores and its head-pose matrix — and nothing from the
 * picture's pixels. That is the difference from the WebGazer model this
 * replaced, which regressed on two 10×6 grey thumbnails of the eyes: those
 * thumbnails shift a pixel whenever a landmark does, change with every flicker
 * of the light, and change completely when the head turns, so the cursor
 * wandered with all three. The measurements here are ratios of distances on
 * the face and angles of the head, which the light doesn't move, and the head's
 * pose is an input to the model rather than something it can't see.
 *
 * Pure — no canvas, no DOM — so it is tested in Node.
 */

import { headPose } from '../common/head.js';

/**
 * Each eye's outline: the lids' arcs from MediaPipe's face-mesh annotations.
 * "Left" and "right" are the subject's own, so the left eye is on the right of
 * an unmirrored frame. Only used to box the eye — for the preview, and to tell
 * when a hand is in front of it.
 */
const EYE_OUTLINE = {
  left: [466, 388, 387, 386, 385, 384, 398, 263, 249, 390, 373, 374, 380, 381, 382, 362],
  right: [246, 161, 160, 159, 158, 157, 173, 33, 7, 163, 144, 145, 153, 154, 155, 133]
};

/**
 * `[image-left corner, image-right corner, upper lid, lower lid, iris centre]`.
 * Corners run image-left to image-right for both eyes, so an iris moving right
 * in the picture reads the same way in each.
 */
const EYE = {
  right: [33, 133, 159, 145, 468],
  left: [362, 263, 386, 374, 473]
};

/**
 * The reading the gaze model is fitted on, in this order:
 *
 *   uR, vR, uL, vL   where each iris sits in its eye: along the corner-to-corner
 *                    line and across it, in eye widths from the corners' midpoint
 *   earR, earL       how open each eye is: lid gap over eye width — the lids
 *                    follow the eyes up and down, so this is vertical gaze too
 *   lookH, lookV     the face model's own gaze blendshapes, combined over both
 *                    eyes: + toward the subject's left, + up
 *   yaw, pitch, roll which way the head points, radians (src/common/head.js)
 *   headX, headY     where the head is, as seen from the camera (x/z, y/z)
 *   headZ            how far away, in units of 60 cm
 *
 * gaze-store.js's `BASE_FEATURE_COUNT` is its length.
 */
export const BASE_FEATURES = [
  'uR', 'vR', 'uL', 'vL', 'earR', 'earL', 'lookH', 'lookV',
  'yaw', 'pitch', 'roll', 'headX', 'headY', 'headZ'
];

const px = (point, width, height) => ({ x: point.x * width, y: point.y * height });

/** A box round some landmarks, in pixels. */
function box(points, indices, width, height) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const i of indices) {
    const p = px(points[i], width, height);
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** How open one eye is: lid gap over eye width. Around 0.25–0.35 open, toward 0 through a blink. */
function aspect(points, [a, b, upper, lower], width, height) {
  const inner = px(points[a], width, height);
  const outer = px(points[b], width, height);
  const top = px(points[upper], width, height);
  const bottom = px(points[lower], width, height);
  const across = Math.hypot(outer.x - inner.x, outer.y - inner.y);
  if (across < 1e-6) return 0;
  return Math.hypot(bottom.x - top.x, bottom.y - top.y) / across;
}

/**
 * Where the iris sits in the eye: its offset from the midpoint between the
 * corners, along the corner-to-corner line (`u`) and across it (`v`, + toward
 * the lower lid), both in eye widths — and the eye's width in pixels.
 */
function irisOffset(points, [a, b, , , iris], width, height) {
  const start = px(points[a], width, height);
  const end = px(points[b], width, height);
  const centre = px(points[iris], width, height);
  const ax = end.x - start.x;
  const ay = end.y - start.y;
  const length2 = ax * ax + ay * ay;
  if (length2 < 1e-6) return null;
  const dx = centre.x - (start.x + end.x) / 2;
  const dy = centre.y - (start.y + end.y) / 2;
  return { u: (dx * ax + dy * ay) / length2, v: (ax * dy - ay * dx) / length2, width: Math.sqrt(length2) };
}

/** Blendshape scores by name, from one face's `faceBlendshapes[i]`. */
function scores(blendshapes) {
  const out = {};
  for (const c of blendshapes?.categories || []) out[c.categoryName] = c.score;
  return out;
}

/**
 * Everything the gaze model and the checks around it need from one frame.
 *
 * @param points FaceLandmarker's normalised landmarks for one face (478 of
 *   them), in the whole camera frame's coordinates.
 * @param blendshapes that face's `faceBlendshapes[i]`.
 * @param matrix that face's `facialTransformationMatrixes[i]` (or its `data`).
 * @param width, height the camera frame, pixels.
 * @returns `null` when the eyes can't be read — a face turned so far an eye
 *   is guessed at off the edge of the picture, say. Otherwise:
 *   `features`  — the 14 numbers of `BASE_FEATURES`;
 *   `boxes`     — `{ left, right }`, each eye's outline box in pixels;
 *   `openness`  — mean lid gap over eye width, for spotting blinks;
 *   `blinkScore` — the face model's own blink score, 0–1, both eyes averaged
 *                 (the engine makes its own blink call from `openness`);
 *   `eyeWidth`, `eyeHeight` — the smaller eye's corner-to-corner width and
 *                 outline height, pixels: small means far away;
 *   `iris`      — `[u, v]` averaged over both eyes;
 *   `head`      — `headPose()`: yaw, pitch, roll, x, y, z;
 *   `span`      — how far apart the eyes are, pixels (corner midpoints);
 *   `pose`      — where the head is, for "you've moved since calibrating":
 *                 `yaw`, `pitch` (radians), `x`, `y` (the eyes' midpoint) and
 *                 `span` as fractions of the frame's width.
 */
export function readEyes(points, { blendshapes = null, matrix = null, width, height } = {}) {
  if (!points || points.length < 478 || !(width > 0) || !(height > 0)) return null;

  const boxes = {
    left: box(points, EYE_OUTLINE.left, width, height),
    right: box(points, EYE_OUTLINE.right, width, height)
  };
  // The tracker carries on placing an eye it can no longer see — a face half
  // out of the picture, or turned far away. A guess is not a reading.
  for (const b of [boxes.left, boxes.right]) {
    if (!(b.w >= 2) || !(b.h >= 1) || b.x < 0 || b.y < 0 || b.x + b.w > width || b.y + b.h > height) return null;
  }

  const right = irisOffset(points, EYE.right, width, height);
  const left = irisOffset(points, EYE.left, width, height);
  const head = headPose(matrix?.data ?? matrix);
  if (!right || !left || !head || !(head.z > 1)) return null;

  const s = scores(blendshapes);
  const has = (name) => Number.isFinite(s[name]);
  const look = [
    'eyeLookInLeft', 'eyeLookOutLeft', 'eyeLookUpLeft', 'eyeLookDownLeft',
    'eyeLookInRight', 'eyeLookOutRight', 'eyeLookUpRight', 'eyeLookDownRight'
  ];
  if (!look.every(has)) return null;
  // Looking toward the subject's left is the left eye looking out and the right eye looking in.
  const lookH = (s.eyeLookOutLeft - s.eyeLookInLeft + (s.eyeLookInRight - s.eyeLookOutRight)) / 2;
  const lookV = (s.eyeLookUpLeft - s.eyeLookDownLeft + (s.eyeLookUpRight - s.eyeLookDownRight)) / 2;

  const earR = aspect(points, EYE.right, width, height);
  const earL = aspect(points, EYE.left, width, height);

  // Where the head is, off the eye *corners* — they move with the skull, the
  // irises with the gaze, and looking at the screen's edge must not read as
  // the head having moved.
  const cornerMid = ([a, b]) => {
    const p = px(points[a], width, height);
    const q = px(points[b], width, height);
    return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
  };
  const centreL = cornerMid(EYE.left);
  const centreR = cornerMid(EYE.right);
  const mid = { x: (centreL.x + centreR.x) / 2, y: (centreL.y + centreR.y) / 2 };
  const span = Math.hypot(centreL.x - centreR.x, centreL.y - centreR.y);
  if (!(span > 1e-6)) return null;

  const features = [
    right.u, right.v, left.u, left.v, earR, earL, lookH, lookV,
    head.yaw, head.pitch, head.roll, head.x / head.z, head.y / head.z, head.z / 60
  ];
  if (!features.every(Number.isFinite)) return null;

  return {
    features,
    boxes,
    openness: (earR + earL) / 2,
    blinkScore: has('eyeBlinkLeft') && has('eyeBlinkRight') ? (s.eyeBlinkLeft + s.eyeBlinkRight) / 2 : 0,
    eyeWidth: Math.min(right.width, left.width),
    eyeHeight: Math.min(boxes.left.h, boxes.right.h),
    iris: [(right.u + left.u) / 2, (right.v + left.v) / 2],
    head,
    span,
    pose: {
      yaw: head.yaw,
      pitch: head.pitch,
      x: mid.x / width,
      y: mid.y / width,
      span: span / width
    }
  };
}
