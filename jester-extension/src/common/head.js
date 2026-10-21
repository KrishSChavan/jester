/**
 * The head: which way it points, read off MediaPipe's face transformation
 * matrix — and the head pointer that turns that into a cursor.
 *
 * Why a head pointer at all: across a room the eyes are a few pixels wide in
 * the camera's picture, and no webcam gaze model reads anything from that. The
 * head is a whole face's worth of landmarks, and which way it points is read
 * from all of them at once — steady enough to aim with from the sofa, and
 * steady enough at a desk to fine-tune a cursor the eyes have put roughly in
 * place. Pure: no DOM, no Chrome, so it is tested in Node.
 */

/**
 * Head pose from one `facialTransformationMatrixes[i].data`.
 *
 * The matrix is column-major 4×4 and maps MediaPipe's canonical face (x
 * toward the subject's left, y up, z out of the face) into camera space: x
 * toward the image's right, y up, z toward the viewer, so the face sits at
 * negative z; translation in centimetres. Measured on the bundled model: a
 * face square to the camera has a forward axis (the third column) of about
 * (0, 0, 1), mirroring the picture flips its x, and an in-plane tilt leaves it
 * where it was — which is why this, and not the nose's offset from between the
 * eyes in the picture, is what says which way the head points.
 *
 * In the user's own terms:
 *   `yaw`   radians, + when the head turns to the user's right;
 *   `pitch` radians, + when it tilts up;
 *   `roll`  radians, + when it leans toward the user's right shoulder;
 *   `x`, `y` where the head is, cm, in the camera's axes (x toward the image's right);
 *   `z`     how far it is from the camera, cm (positive).
 *
 * @returns the pose, or null for a matrix that isn't one.
 */
export function headPose(data) {
  if (!data || data.length < 16) return null;
  for (let i = 0; i < 16; i += 1) if (!Number.isFinite(data[i])) return null;
  const fn = Math.hypot(data[8], data[9], data[10]);
  const un = Math.hypot(data[4], data[5], data[6]);
  if (!(fn > 1e-6) || !(un > 1e-6)) return null;
  const f = [data[8] / fn, data[9] / fn, data[10] / fn];
  const u = [data[4] / un, data[5] / un, data[6] / un];
  // Roll is measured about the forward axis, from where "up" would be with no
  // lean at all — the camera's up, laid flat against the face. Read off the
  // up axis's sideways part alone, a head both turned and tilted would read
  // as leaning.
  const level = [-f[1] * f[0], 1 - f[1] * f[1], -f[1] * f[2]];
  const ln = Math.hypot(level[0], level[1], level[2]);
  let roll = 0;
  if (ln > 1e-6) {
    const r = level.map((v) => v / ln);
    const cross = [r[1] * u[2] - r[2] * u[1], r[2] * u[0] - r[0] * u[2], r[0] * u[1] - r[1] * u[0]];
    roll = Math.atan2(cross[0] * f[0] + cross[1] * f[1] + cross[2] * f[2], r[0] * u[0] + r[1] * u[1] + r[2] * u[2]);
  }
  // The user's right is the camera's left (−x): the camera faces them.
  return {
    yaw: Math.atan2(-f[0], f[2]),
    pitch: Math.atan2(f[1], Math.hypot(f[0], f[2])),
    roll,
    x: data[12],
    y: data[13],
    z: -data[14]
  };
}

// ---------------------------------------------------------------------------
// The One Euro filter
//
// Casiez, Roussel & Vogel (CHI 2012): a low-pass filter whose cut-off rises
// with the signal's speed. Still, it smooths hard, so a resting head holds the
// cursor still; moving, it lets go, so turning the head isn't followed by a
// lag. The standard filter for exactly this — a pointer driven by a noisy
// tracker.
// ---------------------------------------------------------------------------

const smoothingFactor = (cutoff, dt) => {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
};

/**
 * @param minCutoff Hz: how hard it smooths at rest — lower is steadier.
 * @param beta how fast the cut-off rises with speed — higher lags less.
 * @param dCutoff Hz: smoothing of the speed estimate itself.
 */
export function makeOneEuro({ minCutoff = 1, beta = 0, dCutoff = 1 } = {}) {
  let x = null;
  let dx = 0;
  let at = 0;
  return {
    reset() {
      x = null;
      dx = 0;
      at = 0;
    },
    /** One reading at time `t` (ms); returns the filtered value. */
    next(value, t) {
      if (!Number.isFinite(value)) return x;
      if (x === null || !(t > at)) {
        // First reading, or a clock that didn't move: nothing to filter against.
        if (x === null) x = value;
        at = t;
        return x;
      }
      const dt = Math.min(1, (t - at) / 1000);
      at = t;
      const speed = (value - x) / dt;
      dx += smoothingFactor(dCutoff, dt) * (speed - dx);
      const cutoff = minCutoff + beta * Math.abs(dx);
      x += smoothingFactor(cutoff, dt) * (value - x);
      return x;
    },
    get value() {
      return x;
    }
  };
}

// ---------------------------------------------------------------------------
// The head pointer
// ---------------------------------------------------------------------------

/**
 * How far the head turns to sweep the cursor across the whole screen, at the
 * default speed: ±12° side to side, ±8° up and down (people turn their heads
 * more freely than they nod). Comfortable at a desk and from a sofa alike:
 * it's an angle, and the screen's own size in the view doesn't enter into it.
 */
export const HEAD_SWEEP = { yaw: (24 * Math.PI) / 180, pitch: (16 * Math.PI) / 180 };

/**
 * The filter for the head's angles: steady at rest, quick on the move. A head
 * at rest reads a few tenths of a degree of jitter at a desk, more across a
 * room; with these, a still head holds the cursor to within a pixel or two
 * while a deliberate turn is followed within a frame or two.
 */
export const HEAD_FILTER = { minCutoff: 0.6, beta: 6, dCutoff: 1 };

/**
 * A cursor steered by the head, relative to an anchor: where the cursor was
 * put, and which way the head pointed at that moment. Turning the head moves
 * the cursor from there, `speed` × the screen per `HEAD_SWEEP`.
 *
 * Pushing the cursor against the screen's edge drags the anchor along — the
 * way a mouse works against the edge — so turning back moves it back at once
 * rather than after the head has unwound the overshoot.
 *
 * @param screenW, screenH the screen, px.
 * @param speed the Settings slider: 1 is `HEAD_SWEEP`, 2 needs half the turn.
 * @param filter One Euro parameters for both angles.
 */
export function makeHeadPointer({ screenW, screenH, speed = 1, filter = HEAD_FILTER } = {}) {
  const gainX = (screenW * Math.max(0.1, speed)) / HEAD_SWEEP.yaw;
  const gainY = (screenH * Math.max(0.1, speed)) / HEAD_SWEEP.pitch;
  const yaw = makeOneEuro(filter);
  const pitch = makeOneEuro(filter);
  let anchor = null;

  const raw = () => ({
    x: anchor.x + gainX * (yaw.value - anchor.yaw),
    y: anchor.y - gainY * (pitch.value - anchor.pitch)
  });

  return {
    gainX,
    gainY,
    /** Forget everything: the next `update()` starts afresh. */
    reset() {
      yaw.reset();
      pitch.reset();
      anchor = null;
    },
    /** Feed one head reading (`headPose()`), at `t` ms. Returns false if there was nothing to read. */
    update(pose, t) {
      if (!pose || !Number.isFinite(pose.yaw) || !Number.isFinite(pose.pitch)) return false;
      yaw.next(pose.yaw, t);
      pitch.next(pose.pitch, t);
      return true;
    },
    /** Whether a head reading has arrived since the last reset. */
    get ready() {
      return yaw.value !== null && pitch.value !== null;
    },
    /** Put the cursor at (x, y) px, wherever the head points now. */
    anchorAt(x, y) {
      if (yaw.value === null) return;
      anchor = { x, y, yaw: yaw.value, pitch: pitch.value };
    },
    get anchored() {
      return anchor !== null;
    },
    /**
     * Where the cursor is, px — clamped to the screen widened by `margin` on
     * each side (a fraction of it), with the anchor dragged along at the edge.
     */
    position(margin = 0) {
      if (!anchor || yaw.value === null) return null;
      const p = raw();
      const x0 = -margin * screenW;
      const x1 = (1 + margin) * screenW;
      const y0 = -margin * screenH;
      const y1 = (1 + margin) * screenH;
      const cx = Math.min(x1, Math.max(x0, p.x));
      const cy = Math.min(y1, Math.max(y0, p.y));
      anchor.x += cx - p.x;
      anchor.y += cy - p.y;
      return { x: cx, y: cy };
    },
    /** The filtered angles, radians — null until a reading has arrived. */
    get angles() {
      return { yaw: yaw.value, pitch: pitch.value };
    }
  };
}
