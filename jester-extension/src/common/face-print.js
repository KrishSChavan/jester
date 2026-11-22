/**
 * A face, as the voice training reads it: roughly whose it is, and whether its mouth is moving. From MediaPipe's face
 * tracker alone (the same 478 landmarks the eye pointer reads, src/offscreen/eyes.js), never the picture's pixels.
 *
 * The desktop's training mode (desktop/src/main/face-witness.js) uses it to know that a voice it heard was the user's:
 * their own face was in front of the camera, and talking, while it was heard.
 *
 * Whose face it is goes by its shape: the distances between sixteen points that stay where they are as a face talks,
 * smiles or blinks (the eyes' corners, the bridge and tip of the nose and its wings, the brow, the forehead, and the
 * sides of the face), each over the average of them all, so it reads the same however near the face is, wherever it
 * is in the picture and, the distances being in 3D, however it's turned. It's no Face ID: two people of much the
 * same build can read alike. What it's for is telling the user from the friend beside them, and that matters less
 * than it sounds, as the mouth has to be moving with what's heard as well.
 *
 * Pure — no canvas, no DOM — so it is tested in Node.
 */

import { headPose } from './head.js';

/**
 * The points a face's shape is measured between, from MediaPipe's face-mesh annotations: the outer and inner corners
 * of each eye, down the nose from its bridge to its tip, the nose's wings, the forehead and between the brows, and
 * the sides of the face at the cheekbones. None of the lips, the jaw or the lids: those move as it talks.
 */
export const SHAPE_POINTS = Object.freeze([33, 133, 362, 263, 168, 6, 197, 195, 1, 98, 327, 10, 151, 9, 234, 454]);
/** How many numbers a shape is: every pair of those points. */
export const SHAPE_SIZE = (SHAPE_POINTS.length * (SHAPE_POINTS.length - 1)) / 2;
/** The inner lips, top and bottom, and the inner corners of the mouth: how far open it is. */
const LIPS = { top: 13, bottom: 14, left: 78, right: 308 };
/** The eyes' outer corners: how big the face is in the picture. */
const EYE_CORNERS = [33, 263];
/** Turned or tilted further than this (radians, about 26°) and the shape isn't compared: the tracker guesses at the far side. */
export const FRONTAL = 0.45;
/** A face smaller than this in the picture, eye corner to eye corner, is too far off for its shape to mean much (px). */
export const SPAN_MIN = 40;

const round = (value, places = 4) => Math.round(value * 10 ** places) / 10 ** places;

/** A landmark in pixels, its depth on the same scale as across (MediaPipe's z is in units of the picture's width). */
function at(point, width, height) {
  return point && Number.isFinite(point.x) && Number.isFinite(point.y) ? [point.x * width, point.y * height, (Number.isFinite(point.z) ? point.z : 0) * width] : null;
}

const between = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * A face's shape: the SHAPE_SIZE distances between SHAPE_POINTS, each over their mean (so about 1 on average), or
 * null when the landmarks can't give one.
 * @param {{x:number, y:number, z?:number}[]} points  the tracker's normalised landmarks for one face
 */
export function faceShape(points, width, height) {
  if (!Array.isArray(points) || points.length < 468 || !(width > 0) || !(height > 0)) return null;
  const xyz = SHAPE_POINTS.map((index) => at(points[index], width, height));
  if (xyz.some((point) => !point)) return null;
  const lengths = [];
  for (let i = 0; i < xyz.length; i += 1) for (let j = i + 1; j < xyz.length; j += 1) lengths.push(between(xyz[i], xyz[j]));
  const mean = lengths.reduce((sum, value) => sum + value, 0) / lengths.length;
  if (!(mean > 1e-6)) return null;
  return lengths.map((value) => round(value / mean));
}

/** How far open the mouth is: the inner lips' gap over the mouth's inner width, about 0 shut and 0.3 to 0.6 wide open. */
export function mouthOpening(points, width, height) {
  if (!Array.isArray(points) || points.length < 468) return null;
  const [top, bottom, left, right] = [LIPS.top, LIPS.bottom, LIPS.left, LIPS.right].map((index) => at(points[index], width, height));
  if (!top || !bottom || !left || !right) return null;
  const wide = between(left, right);
  return wide > 1e-6 ? round(between(top, bottom) / wide) : null;
}

/** How alike two shapes are, as how far apart: the root of their mean squared difference. 0 is the same face, exactly. */
export function shapeDistance(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum / a.length);
}

/**
 * One reading of a face, for the training: its shape (only when it faces the camera nearly enough, and is near
 * enough, to be compared), how far open its mouth is, how big it is, and which way it points.
 * @param points  the tracker's landmarks for one face, in the whole frame's coordinates
 * @param {{width:number, height:number, matrix?:ArrayLike<number>|{data:ArrayLike<number>}}} frame
 * @returns {{shape:number[]|null, mouth:number|null, span:number, yaw:number|null, pitch:number|null}|null}
 */
export function faceReading(points, { width, height, matrix = null } = {}) {
  if (!Array.isArray(points) || points.length < 468 || !(width > 0) || !(height > 0)) return null;
  const [a, b] = EYE_CORNERS.map((index) => at(points[index], width, height));
  if (!a || !b) return null;
  const span = Math.hypot(a[0] - b[0], a[1] - b[1]);
  const head = headPose(matrix?.data ?? matrix);
  const facing = !!head && Math.abs(head.yaw) <= FRONTAL && Math.abs(head.pitch) <= FRONTAL;
  return {
    shape: facing && span >= SPAN_MIN ? faceShape(points, width, height) : null,
    mouth: mouthOpening(points, width, height),
    span: round(span, 1),
    yaw: head ? round(head.yaw, 3) : null,
    pitch: head ? round(head.pitch, 3) : null
  };
}
