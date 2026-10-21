/**
 * The stored eye-pointer calibration: what it is, whether it still applies,
 * and what to call how good it is.
 *
 * Deliberately free of the DOM and of the fitting code, so the service worker
 * and the options page can read a calibration without loading anything that
 * made it. The fitting and predicting live in gaze.js.
 */

/**
 * Bumped whenever the numbers a calibration is fitted on change meaning — a
 * different set of measurements, a different face model. A calibration is a
 * set of coefficients over these exact numbers, so it carries the version it
 * was fitted against and is retired rather than quietly misapplied.
 *
 * 1 was WebGazer's 120 grey levels of two eye thumbnails; 2 is what MediaPipe's
 * face tracker measures — iris positions, lids, gaze blendshapes, head pose.
 */
export const GAZE_FEATURE_VERSION = 2;

/** The model kind this version stores. */
export const MODEL_KIND = 'landmark-ridge';

/**
 * How many numbers one frame's reading is: see `BASE_FEATURES` in
 * src/offscreen/eyes.js, which is what fills them.
 */
export const BASE_FEATURE_COUNT = 14;

/**
 * How many inputs each of gaze.js's `FEATURE_SETS` expands one reading into.
 * A stored fit names its set: one this build doesn't know, or of another
 * length — from another build — can't be read, and is refused here rather
 * than thrown on at every frame. A test keeps the two in step.
 */
export const FEATURE_SET_SIZES = { linear: 11, curved: 18, perEye: 24 };

/** Correlation between consecutive readings is taken at most this high (gaze.js's `NOISE_RHO_MAX`). */
export const NOISE_RHO_LIMIT = 0.8;

/** Most dots a calibration's nearest-neighbour table can have: thirteen now, with room. */
const MAX_WARP_ROWS = 64;

const finiteArray = (values, length) =>
  Array.isArray(values) && (length === undefined || values.length === length) && values.every(Number.isFinite);

/**
 * The fitted ridge, as gaze.js stores it: which expansion of the reading it
 * was fitted on, and per input its mean and scale, per output (x, y) its
 * coefficients, and an intercept.
 */
function validFit(fit) {
  if (!fit || !Object.hasOwn(FEATURE_SET_SIZES, fit.set)) return false;
  const p = FEATURE_SET_SIZES[fit.set];
  return (
    finiteArray(fit.mean, p) &&
    finiteArray(fit.scale, p) &&
    fit.scale.every((s) => s > 0) &&
    Array.isArray(fit.coef) &&
    fit.coef.length === 2 &&
    fit.coef.every((row) => finiteArray(row, p)) &&
    finiteArray(fit.intercept, 2)
  );
}

/**
 * The nearest-neighbour step's table, if the calibration has one: per dot,
 * where the ridge reads it and how far off that is — four numbers each.
 */
const warpTable = (warp) =>
  warp == null ||
  (Array.isArray(warp) && warp.length >= 1 && warp.length <= MAX_WARP_ROWS && warp.every((row) => finiteArray(row, 4)));

/**
 * Whether a stored calibration can drive the cursor.
 *
 * Shape and version always. The camera too, when the engine knows which one is
 * actually open: the model is a picture of your face *through one lens*, and
 * another camera sees it from a different place, at a different size. Applying
 * it anyway wouldn't be a little off — it would take over ✋ and put a cursor
 * somewhere unrelated to where you look.
 */
export function usableModel(model, { cameraId } = {}) {
  if (
    model?.kind !== MODEL_KIND ||
    model.featureVersion !== GAZE_FEATURE_VERSION ||
    !validFit(model.fit) ||
    !warpTable(model.warp) ||
    (model.bias != null && !finiteArray(model.bias, 2)) ||
    (model.noisePx != null && !(model.noisePx > 0)) ||
    (model.noiseRho != null && !(model.noiseRho >= 0 && model.noiseRho <= NOISE_RHO_LIMIT)) ||
    !(model.screenW > 0) ||
    !(model.screenH > 0)
  ) {
    return false;
  }
  if (cameraId && model.cameraId && cameraId !== model.cameraId) return false;
  return true;
}

/**
 * Why a stored calibration should no longer be trusted, or null if it's fine.
 *
 * A calibration is a statement about one camera, one screen and one way of
 * sitting. The first two can be checked; the third is on the user, and the
 * options page says so.
 *
 * @param cameraId the camera the engine has open (`engine.cameraId` in
 *   `GET_STATE`), not the one picked in Settings: "Default camera" can mean a
 *   different device tomorrow, and a named one can fall back to another.
 */
export function calibrationStale(model, { screenW, screenH, cameraId } = {}) {
  if (!model) return 'No calibration yet.';
  if (!usableModel(model)) {
    return model.kind === MODEL_KIND
      ? "The stored calibration can't be read. Calibrate again."
      : 'Jester reads your eyes a new way now — calibrate again to use it.';
  }
  // The camera actually open, as the engine reports it — the same test the
  // engine applies. Nothing to say while the engine isn't running.
  if (cameraId && model.cameraId && cameraId !== model.cameraId) {
    return 'You calibrated with a different camera.';
  }
  if (screenW && (screenW !== model.screenW || screenH !== model.screenH)) {
    return 'You calibrated on a screen of a different size.';
  }
  return null;
}

/**
 * Validation error as a human verdict.
 *
 * Webcam eye tracking is far coarser than a mouse: around a tenth of the
 * screen's width is an honest target at a laptop's distance. That reaches the
 * video itself and big buttons like Skip or Next episode, and the head-steered
 * fine adjustment does the rest.
 *
 * `error` is measured on looks the fit never saw — each round read by a fit
 * made from the other two — so it is roughly what you will actually get, not
 * what the fit claims about itself.
 */
export function calibrationGrade(error) {
  if (!Number.isFinite(error)) return { grade: 'unusable', hint: 'The fit failed. Run calibration again.' };
  if (error <= 0.1) return { grade: 'good', hint: 'The video and large buttons are easy targets.' };
  if (error <= 0.15) {
    return { grade: 'usable', hint: 'Aim at big things — the video itself, large buttons — and nudge with your head.' };
  }
  return {
    grade: 'poor',
    hint:
      'Recalibrate: face the camera with light on your face, keep your head still, and keep ' +
      'looking at each dot while your hand closes.'
  };
}

// ---------------------------------------------------------------------------
// Storage
//
// Only numbers about the screen and the fit are kept: the ridge's coefficients
// and its inputs' means and scales, and for each dot where the ridge read it
// and how far off that was. The readings they were fitted from never leave the
// calibration page's memory.
// ---------------------------------------------------------------------------

export const STORE_KEY = 'gazeCalibration';
/** The finger pointer's calibration: a model of a hand, meaningless to eyes. */
const LEGACY_KEYS = ['pointerCalibration'];

/**
 * Returned even when out of date — a calibration from an older version
 * included — so Settings can say *why* it no longer applies; `usableModel()`
 * is what decides whether the engine may use it.
 */
export async function loadCalibration() {
  const stored = (await chrome.storage.local.get(STORE_KEY))[STORE_KEY];
  if (!stored || typeof stored !== 'object' || typeof stored.kind !== 'string') return null;
  return stored;
}

export async function saveCalibration(model) {
  await chrome.storage.local.set({ [STORE_KEY]: model });
}

export async function clearCalibration() {
  await chrome.storage.local.remove(STORE_KEY);
}

export async function forgetLegacyCalibration() {
  await chrome.storage.local.remove(LEGACY_KEYS);
}
