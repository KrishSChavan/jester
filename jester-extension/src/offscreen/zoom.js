/**
 * Zoom: what part of the camera's picture each model is shown.
 *
 * MediaPipe's detectors shrink whatever they're given to a small square — 192
 * pixels across for the palm detector, 128 for the face — and a hand or a face
 * that is a small part of the picture ends up a few pixels in that square,
 * where nothing is found. Measured with the bundled models on a 1920×1080
 * frame: a hand under about a tenth of the frame's height and a face whose eyes
 * are under about a twentieth of its width apart were missed outright, and a
 * 1080p frame did *worse* than a 640×480 one, because shrinking it ten times
 * over loses small hands to aliasing. Shown a crop where the hand is a fifth of
 * the picture, or the face a sixth, every one tested was found — down to 12 px
 * hands and 8 px eye spacings.
 *
 * So the engine never hands MediaPipe the raw camera frame. Up close, it gets
 * the whole frame, shrunk smoothly to a size its detectors read well. Across a
 * room, it gets crops that follow the person: one round the face, one round
 * where hands go when they are raised. Nobody in view, it searches — the whole
 * frame, then zoomed-in pieces of it in turn — until a face or a hand turns up.
 *
 * Pure: the engine draws the crops; this only decides them. Every rectangle is
 * in camera pixels; `null` means the whole frame.
 */

/** A face crop is this many eye spacings across: the face about a sixth of it, as the detector wants. */
export const FACE_CROP_SPANS = 12;
/**
 * The hands' crop is this many eye spacings across, centred this many below
 * the eyes: room for a hand raised beside either shoulder (about ±42 cm from
 * the face) or in front of the chest, with the hand a little over a fifth of
 * the picture. MediaPipe's palm detector is at its limit for a hand across a
 * room, and that share is what decides it: measured on a ✌️ at sofa distance,
 * 16 spacings found it in no frame and 12–14 in every one.
 */
export const HAND_CROP_SPANS = 13;
export const HAND_CROP_DROP = 1.5;
/** A crop never narrower than this many camera pixels: below it there is nothing left to enlarge. */
export const MIN_CROP = 160;
/**
 * A crop wider than this share of the frame's height is no zoom worth having:
 * the whole frame is used instead.
 */
export const FULL_FRAME_SHARE = 0.9;
/** The hands' crop gives way to the whole frame only once it would be this share of the frame's width. */
export const FULL_WIDTH_SHARE = 0.95;
/**
 * Between the whole frame and a crop, a margin, so someone sitting where one
 * gives way to the other — their landmarks jittering across the line — isn't
 * switched between them every few frames: each switch costs a tracker its
 * lock for a frame, and flips whether the eyes were read zoomed-in.
 *
 * For the face the margin is all on the way back, and is set by what the
 * detector can find. Measured with the bundled model on a 1080p frame, the
 * whole frame finds a face from scratch only with its eyes 86 px apart or
 * more — just past where the crop takes over, at 81 — and a face moved there
 * from a crop any smaller was never found again. So a face in a crop stays in
 * one, as tall as the frame, until its crop would be this share of the frame's
 * height: eyes about 92 px apart.
 */
export const FACE_RETURN_SHARE = 1.02;
/** The hands' crop takes over this far inside the width it gives way at. */
export const HAND_ENTER_MARGIN = 0.1;
/**
 * A crop is only moved or resized once the one wanted differs by this much —
 * a share of its side — so the picture the models see doesn't shift with
 * every tremor of the landmarks. Moving it costs MediaPipe its tracking for a
 * frame.
 */
export const CROP_SLACK = 0.18;
/** Without a sighting of the person this long, the crop they had is given up and the search begins. */
export const PERSON_LOST_MS = 1500;
/**
 * A hand this many eye spacings from where the face was is over it, or about
 * to be — the usual reason a face goes missing — and keeps the person tracked.
 * A hand farther off, resting in a lap, says nothing about the face.
 */
export const KEEPALIVE_SPANS = 3;
/** Each place the search looks is held this many frames: a detector shown a new picture needs a frame or two. */
export const SEARCH_FRAMES = 3;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * A square of `side` camera pixels centred on (cx, cy), slid back inside the
 * frame where it would hang over an edge. `null` — the whole frame — when it
 * would be most of the frame anyway.
 */
export function squareCrop(cx, cy, side, W, H) {
  if (!(W > 0 && H > 0) || !Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(side)) return null;
  const s = Math.max(MIN_CROP, side);
  if (s >= FULL_FRAME_SHARE * Math.min(W, H)) return null;
  return rectCrop(cx, cy, s, s, W, H);
}

/** A `w` × `h` rectangle centred on (cx, cy), cut to the frame and slid back inside it. */
function rectCrop(cx, cy, w, h, W, H) {
  const cw = Math.min(W, w);
  const ch = Math.min(H, h);
  const x = clamp(cx - cw / 2, 0, W - cw);
  const y = clamp(cy - ch / 2, 0, H - ch);
  return { x: Math.round(x), y: Math.round(y), w: Math.round(cw), h: Math.round(ch) };
}

/** A point given in a crop's own 0–1 coordinates, in the whole frame's 0–1 coordinates. */
export function fromCrop(point, crop, W, H) {
  if (!crop) return point;
  const out = {
    x: (crop.x + point.x * crop.w) / W,
    y: (crop.y + point.y * crop.h) / H
  };
  // MediaPipe's z is in units of the picture's width: the crop's, here.
  if (point.z !== undefined) out.z = (point.z * crop.w) / W;
  if (point.visibility !== undefined) out.visibility = point.visibility;
  if (point.presence !== undefined) out.presence = point.presence;
  return out;
}

/** Every landmark of a result list (`[[{x, y, z}…]…]`) mapped from a crop to the whole frame. */
export function landmarksFromCrop(lists, crop, W, H) {
  if (!crop || !lists) return lists;
  return lists.map((list) => list.map((p) => fromCrop(p, crop, W, H)));
}

/**
 * Where the person is, from one face's landmarks in whole-frame 0–1
 * coordinates: the point between the eyes and how far apart the eyes are, in
 * camera pixels — the scale everything else is sized by.
 */
export function personFromFace(points, W, H) {
  if (!points || points.length < 468) return null;
  const mid = (a, b) => ({ x: ((points[a].x + points[b].x) / 2) * W, y: ((points[a].y + points[b].y) / 2) * H });
  const right = mid(33, 133);
  const left = mid(362, 263);
  const span = Math.hypot(left.x - right.x, left.y - right.y);
  if (!(span > 1)) return null;
  return { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2, span };
}

/**
 * The crop a face wants: the face about a sixth of it — or the whole frame,
 * up close. `current` is the face's crop now (null for the whole frame), which
 * decides which side of the margin applies (see `FACE_RETURN_SHARE`).
 */
export function faceCropFor(person, W, H, current = null) {
  if (!person || !(W > 0 && H > 0)) return null;
  const side = Math.max(MIN_CROP, FACE_CROP_SPANS * person.span);
  const limit = (current ? FACE_RETURN_SHARE : FULL_FRAME_SHARE) * Math.min(W, H);
  if (!Number.isFinite(side) || !(side < limit)) return null;
  // Square, as the tracker is shown it, and never more than the frame holds.
  const s = Math.min(side, W, H);
  return rectCrop(person.x, person.y + 0.4 * person.span, s, s, W, H);
}

/**
 * The crop raised hands want: beside the shoulders, in front of the chest — a
 * square where the frame has room for one, and in the middle distance, where
 * it hasn't, the frame's full height and only as wide as the hands need.
 * Measured, a hand a metre away in the whole 16:9 frame shrunk for the
 * recogniser was found but its pose misread; cut down to the person, it read
 * right. Only someone so close that the crop would span the frame's width gets
 * the whole frame.
 */
export function handCropFor(person, W, H, current = null) {
  if (!person) return null;
  const side = Math.max(MIN_CROP, HAND_CROP_SPANS * person.span);
  // From the whole frame, a crop only once well inside the line; from a crop,
  // the whole frame only once past it (see `FACE_RETURN_SHARE`).
  if (side >= FULL_WIDTH_SHARE * W * (current ? 1 : 1 - HAND_ENTER_MARGIN)) return null;
  return rectCrop(person.x, person.y + HAND_CROP_DROP * person.span, side, side, W, H);
}

/** Whether `next` is close enough to `current` to keep `current`: same size and place, within the slack. */
export function closeEnough(current, next) {
  if (!current || !next) return current === next;
  const side = Math.max(current.w, current.h, 1);
  return (
    Math.abs(next.w - current.w) <= CROP_SLACK * side &&
    Math.abs(next.h - current.h) <= CROP_SLACK * side &&
    Math.abs(next.x + next.w / 2 - (current.x + current.w / 2)) <= CROP_SLACK * side &&
    Math.abs(next.y + next.h / 2 - (current.y + current.h / 2)) <= CROP_SLACK * side
  );
}

/**
 * The places the search looks, in order, for a frame of W × H: the whole
 * frame (anyone near), then squares zoomed in on where someone sitting in front
 * of the camera usually is — the middle, a little above centre — then either
 * side, then closer in still. The tightest are for a face across a room: about
 * a third of the frame's height, where a face eight to ten feet away is a
 * sixth of the picture, as the detector wants.
 */
export function searchPlan(W, H) {
  const plan = [null];
  const add = (cx, cy, side) => {
    const crop = squareCrop(cx * W, cy * H, side, W, H);
    if (crop && !plan.some((c) => c && c.x === crop.x && c.y === crop.y && c.w === crop.w)) plan.push(crop);
  };
  add(0.5, 0.5, 0.75 * H);
  add(0.5, 0.42, 0.5 * H);
  add(0.5, 0.38, 0.33 * H);
  add(0.33, 0.42, 0.5 * H);
  add(0.67, 0.42, 0.5 * H);
  add(0.35, 0.38, 0.33 * H);
  add(0.65, 0.38, 0.33 * H);
  add(0.5, 0.36, 0.25 * H);
  return plan;
}

/**
 * The zoom's state: which crops the face and the hands get this frame.
 *
 * Call `crops(now)` before running the models and `observe(…)` after. The
 * person is found by their face, and only by their face: a hand says nothing
 * reliable about where its owner is — it may be resting in a lap, on an
 * armrest, or be somebody else's — and a zoom that followed one would park the
 * face's crop where no face is. While the person is tracked each model's crop
 * follows them, with slack, and a hand over the face keeps them tracked while
 * the face is hidden — that is the usual reason it is, and only that: measured,
 * a hand resting in a lap kept a person "seen" who had moved away, and the
 * search that would have found them never began. Lost for longer than `PERSON_LOST_MS`, the search takes over: the
 * face is shown one place after another, a few frames at a time, until it
 * turns up. The hands go along with it — unless a hand doing something (a
 * pose, not a hand at rest) has been seen in one of those places, in which
 * case the hands stay looking there while the face's search goes on: a face
 * that can't be found (turned away, masked, in shadow) mustn't take the hands'
 * view with it. `hold(true)` pins the crops where they are — a cursor steered
 * by the head must not have the picture shift under it.
 */
export function makeZoom({ width, height }) {
  const W = width;
  const H = height;
  const plan = searchPlan(W, H);
  let person = null;
  let seenAt = -Infinity;
  let face = null;
  let hands = null;
  let held = false;
  let step = 0;
  let stepFrames = 0;
  /** While searching: where an active hand was last seen, and when. */
  let handLock = null;

  const searching = (now) => now - seenAt > PERSON_LOST_MS;
  /** Whether a hand (whole-frame 0–1 landmarks) is over, or right by, the face last seen. */
  const overFace = (landmarks) =>
    !!person &&
    Array.isArray(landmarks) &&
    landmarks.some((p) => p && Math.hypot(p.x * W - person.x, p.y * H - person.y) <= KEEPALIVE_SPANS * person.span);

  return {
    /** The crops to use now: `{ face, hands, searching }`, each a rectangle or null for the whole frame. */
    crops(now) {
      if (!held && searching(now)) {
        const place = plan[step % plan.length];
        stepFrames += 1;
        if (stepFrames >= SEARCH_FRAMES) {
          stepFrames = 0;
          step += 1;
        }
        const locked = handLock && now - handLock.seenAt <= PERSON_LOST_MS;
        // Where the models are looking now: whoever turns up is judged against
        // that — a face found in a crop isn't sent straight to a whole frame
        // that can't find it.
        face = place;
        hands = locked ? handLock.crop : place;
        return { face, hands, searching: true };
      }
      return { face, hands, searching: false };
    },
    /**
     * What the models found this frame, in whole-frame 0–1 coordinates: one
     * face's landmarks (or null) and the hands' landmark lists — plus, while
     * searching, whether any of those hands was doing something, and which
     * crop the hands were read from.
     */
    observe(now, { facePoints = null, handLandmarks = [], handsActive = false, handCrop = null } = {}) {
      const next = personFromFace(facePoints, W, H);
      if (!next && searching(now) && handsActive) handLock = { crop: handCrop, seenAt: now };
      if (!next) {
        // No face. A hand over where it was keeps the person tracked; anything
        // else leaves the clock running.
        if (person && now - seenAt <= PERSON_LOST_MS && (handLandmarks || []).some(overFace)) seenAt = now;
        return;
      }
      person = next;
      seenAt = now;
      step = 0;
      stepFrames = 0;
      handLock = null;
      if (held) return;
      const wantFace = faceCropFor(person, W, H, face);
      const wantHands = handCropFor(person, W, H, hands);
      if (!closeEnough(face, wantFace)) face = wantFace;
      if (!closeEnough(hands, wantHands)) hands = wantHands;
    },
    hold(on) {
      held = !!on;
    },
    /** Forget the person: the next frame starts searching. */
    reset() {
      person = null;
      seenAt = -Infinity;
      face = null;
      hands = null;
      step = 0;
      stepFrames = 0;
      handLock = null;
    },
    get person() {
      return person;
    },
    /** How far away the person is, as the eyes' spacing in camera pixels — null when nobody is tracked. */
    get span() {
      return person ? person.span : null;
    }
  };
}
