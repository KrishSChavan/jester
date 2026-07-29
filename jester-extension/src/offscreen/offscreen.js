/**
 * The recognition engine.
 *
 * Runs in an offscreen document so the camera stream and the per-frame
 * inference loop have a stable home. Everything here is local: frames never
 * leave this document, only gesture *decisions* are messaged out.
 */

import { GestureRecognizer, FilesetResolver } from '../../vendor/tasks-vision/vision_bundle.mjs';
import { MSG, ENGINE, GESTURES, mergeSettings, post, clamp } from '../common/constants.js';

const WASM_PATH = chrome.runtime.getURL('vendor/tasks-vision/wasm');
const MODEL_PATH = chrome.runtime.getURL('models/gesture_recognizer.task');

/** Landmarks that together form a stable palm centre, ignoring finger flex. */
const PALM_LANDMARKS = [0, 5, 9, 13, 17];
/**
 * `[knuckle, tip]` for index, middle, ring and pinky. The thumb is left out on
 * purpose: it swings across to pinch, and would drag the reading of how open
 * the hand is along with it.
 */
const FINGERS = [
  [5, 8],
  [9, 12],
  [13, 16],
  [17, 20]
];
const THUMB_TIP = 4;
const INDEX_TIP = 8;
const TRAIL_MS = 700;
const SPEED_WINDOW_MS = 150;
const HAND_LOST_MS = 150;
const PREVIEW_GRACE_MS = 2000;
const PREVIEW_INTERVAL_MS = 100;
const TELEMETRY_INTERVAL_MS = 80;
const CAMERA_TIMEOUT_MS = 8000;
const MODEL_TIMEOUT_MS = 30000;
const TIMED_OUT = Symbol('timed-out');

/**
 * What `reach()` returns at each end of a finger's range. Everything in between
 * is scaled onto 0 (folded away) to 1 (straight out), and a hand steers when
 * every finger sits near the middle.
 */
const REACH_FIST = 0.95;
const REACH_FLAT = 1.9;

/**
 * Two independent tests, each `[strict, loose]` interpolated by the
 * `pointerTolerance` setting.
 *
 *   BAND   — how far the average of the four fingers may sit from half open.
 *            Rules out a flat palm and a fist.
 *   SPREAD — how far apart the most and least extended finger may be. Rules out
 *            ✌️, ☝️ and 🤟, which average out to half open while being nothing
 *            of the sort. Kept separate from the band because a relaxed hand
 *            genuinely curls unevenly — the pinky more than the index.
 */
const POINTER_BAND = [0.22, 0.33];
const POINTER_SPREAD = [0.35, 0.6];
const POINTER_HOLD_MARGIN = 0.1; // extra slack once you're already steering

const POINTER_MIN_PALM = 0.03; // below this the hand is too far away to judge
const POINTER_RELEASE_MS = 320; // shape may drop out this long without ending
const POINTER_PINCH_HYSTERESIS = 0.15; // gap between the click and release points

const GESTURE_LABELS = Object.fromEntries(GESTURES.map((g) => [g.id, g.label]));

const videoEl = document.getElementById('camera');
const previewCanvas = document.getElementById('preview');
const previewCtx = previewCanvas.getContext('2d', { willReadFrequently: false });

let settings = null;
let recognizer = null;
let stream = null;
let timer = null;
let running = false;
let starting = false;
let suspended = false;
let activeDelegate = null;

let lastVideoTime = -1;
let lastTimestamp = 0;
let lastResult = null;
let fps = 0;
let lastFrameAt = 0;
let previewWantedUntil = 0;
let lastPreviewAt = 0;
let lastTelemetryAt = 0;
let lastStatus = { state: ENGINE.OFF, detail: '' };

const rec = {
  candidate: null,
  candidateSince: 0,
  candidateSeenAt: 0,
  fired: false,
  lastFireAt: 0,
  lastActionAt: 0,
  lastHandAt: 0,
  trail: []
};

const ptr = {
  poseSince: 0,
  lastPoseAt: 0,
  active: false,
  x: 0.5,
  y: 0.5,
  raw: null, // un-mirrored frame coordinates, for the preview overlay only
  lastAt: 0,
  pinched: false,
  filterX: null,
  filterY: null
};

// ---------------------------------------------------------------------------
// Status reporting
// ---------------------------------------------------------------------------

function report(state, detail = '') {
  lastStatus = { state, detail };
  post({ type: MSG.ENGINE_STATUS, state, detail });
}

// ---------------------------------------------------------------------------
// Engine start / stop
// ---------------------------------------------------------------------------

async function createRecognizer(preferredDelegate) {
  const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
  const order = preferredDelegate === 'CPU' ? ['CPU'] : ['GPU', 'CPU'];
  let lastError = null;

  for (const delegate of order) {
    try {
      const instance = await GestureRecognizer.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_PATH, delegate },
        runningMode: 'VIDEO',
        numHands: settings.numHands,
        minHandDetectionConfidence: settings.minHandDetectionConfidence,
        minHandPresenceConfidence: settings.minHandDetectionConfidence,
        minTrackingConfidence: settings.minTrackingConfidence,
        // Keep the model's own threshold low; our own hysteresis in
        // `processHand` is what actually decides when something fires.
        cannedGesturesClassifierOptions: { scoreThreshold: 0.2 }
      });
      activeDelegate = delegate;
      return instance;
    } catch (err) {
      lastError = err;
      console.warn(`[jester] ${delegate} delegate unavailable:`, err);
    }
  }
  throw lastError || new Error('Could not create the gesture recognizer');
}

/**
 * An offscreen document has no UI, so Chrome has nowhere to show a camera
 * prompt. When permission is still in the `prompt` state `getUserMedia` does
 * not reject — it simply never settles. Check first, and time out regardless.
 */
async function cameraPermissionState() {
  try {
    const status = await navigator.permissions.query({ name: 'camera' });
    return status.state;
  } catch {
    return 'unknown';
  }
}

function openCameraGuarded() {
  const pending = openCamera();
  pending.catch(() => undefined); // the race below may leave this unobserved

  const timeout = new Promise((resolve) => setTimeout(() => resolve(TIMED_OUT), CAMERA_TIMEOUT_MS));

  return Promise.race([pending, timeout]).then((result) => {
    if (result !== TIMED_OUT) return result;
    // Don't leak a stream that arrives after we've given up.
    pending.then((s) => s.getTracks().forEach((t) => t.stop())).catch(() => undefined);
    const error = new Error(
      'The camera did not respond — this almost always means access has not been granted. ' +
        'Open the Jester options page and click "Allow camera access".'
    );
    error.name = 'JesterCameraTimeout';
    throw error;
  });
}

async function openCamera() {
  const video = {
    width: { ideal: 640 },
    height: { ideal: 480 },
    frameRate: { ideal: 30 }
  };
  if (settings.cameraDeviceId) video.deviceId = { exact: settings.cameraDeviceId };

  try {
    return await navigator.mediaDevices.getUserMedia({ video, audio: false });
  } catch (err) {
    // A saved device can disappear (unplugged dock, etc.) — retry with any camera.
    if (settings.cameraDeviceId && err?.name === 'OverconstrainedError') {
      return navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }
    throw err;
  }
}

function describeCameraError(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return { state: ENGINE.NO_PERMISSION, detail: 'Camera access has not been granted yet.' };
    case 'JesterCameraTimeout':
      return { state: ENGINE.NO_PERMISSION, detail: err.message };
    case 'NotFoundError':
    case 'OverconstrainedError':
      return { state: ENGINE.ERROR, detail: 'No camera matched — check the camera picker in Options.' };
    case 'NotReadableError':
      return { state: ENGINE.ERROR, detail: 'The camera is already in use by another app.' };
    default:
      return { state: ENGINE.ERROR, detail: String(err?.message || err) };
  }
}

async function start() {
  if (running || starting) return;
  starting = true;

  // Cheapest and by far the most common failure — check it before spending 8MB
  // of model load on a run that can't succeed.
  const permission = await cameraPermissionState();
  if (permission === 'denied' || permission === 'prompt') {
    starting = false;
    report(
      ENGINE.NO_PERMISSION,
      permission === 'denied'
        ? 'Camera access is blocked for this extension. Re-allow it from the padlock icon on the options page.'
        : 'Camera access has not been granted yet. Open the options page and click "Allow camera access".'
    );
    return;
  }

  report(ENGINE.STARTING, 'Loading model…');
  try {
    if (!recognizer) {
      recognizer = await Promise.race([
        createRecognizer(settings.delegate),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('model load timed out')), MODEL_TIMEOUT_MS)
        )
      ]);
    }
  } catch (err) {
    starting = false;
    report(ENGINE.ERROR, `Model failed to load: ${err?.message || err}`);
    return;
  }

  report(ENGINE.STARTING, 'Opening camera…');
  try {
    stream = await openCameraGuarded();
  } catch (err) {
    starting = false;
    const { state, detail } = describeCameraError(err);
    report(state, detail);
    return;
  }

  videoEl.srcObject = stream;
  try {
    await videoEl.play();
  } catch {
    /* muted MediaStream playback is allowed; ignore spurious rejections */
  }

  resetRecognitionState();
  running = true;
  starting = false;
  lastVideoTime = -1;
  report(ENGINE.RUNNING, `${activeDelegate} delegate`);
  scheduleTick(0);
}

function stop(nextState = ENGINE.OFF, detail = '') {
  running = false;
  starting = false;
  clearTimeout(timer);
  timer = null;
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }
  videoEl.srcObject = null;
  resetRecognitionState();
  report(nextState, detail);
}

function resetRecognitionState() {
  rec.candidate = null;
  rec.candidateSince = 0;
  rec.candidateSeenAt = 0;
  rec.fired = false;
  rec.lastFireAt = 0;
  rec.lastActionAt = 0;
  rec.lastHandAt = 0;
  rec.trail.length = 0;
  endPointer();
  ptr.poseSince = 0;
  ptr.lastPoseAt = 0;
}

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------

function scheduleTick(elapsed = 0) {
  if (!running) return;
  const interval = 1000 / clamp(settings.targetFps, 5, 60);
  timer = setTimeout(tick, Math.max(0, interval - elapsed));
}

function tick() {
  if (!running) return;
  const startedAt = performance.now();

  try {
    if (!suspended) step(startedAt);
  } catch (err) {
    console.error('[jester] inference failed', err);
    stop(ENGINE.ERROR, String(err?.message || err));
    return;
  }

  scheduleTick(performance.now() - startedAt);
}

function step(now) {
  if (videoEl.readyState < 2 || !videoEl.videoWidth) return;

  if (videoEl.currentTime !== lastVideoTime) {
    lastVideoTime = videoEl.currentTime;
    // MediaPipe requires strictly increasing timestamps in VIDEO mode.
    lastTimestamp = Math.max(lastTimestamp + 1, Math.round(now));
    lastResult = recognizer.recognizeForVideo(videoEl, lastTimestamp);

    const delta = now - lastFrameAt;
    if (lastFrameAt && delta > 0) fps = fps ? fps * 0.85 + (1000 / delta) * 0.15 : 1000 / delta;
    lastFrameAt = now;
  }

  const hand = readHand(lastResult);
  const view = processHand(now, hand);
  emitTelemetry(now, view);
  drawPreview(now, hand, view);
}

/** Pick the most confident hand and reduce it to what the state machine needs. */
function readHand(result) {
  if (!result?.landmarks?.length) return null;

  let bestIndex = 0;
  let bestScore = -1;
  for (let i = 0; i < result.gestures.length; i += 1) {
    const score = result.gestures[i]?.[0]?.score ?? 0;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  const landmarks = result.landmarks[bestIndex];
  if (!landmarks) return null;
  const top = result.gestures[bestIndex]?.[0] || null;

  let x = 0;
  let y = 0;
  for (const index of PALM_LANDMARKS) {
    x += landmarks[index].x;
    y += landmarks[index].y;
  }
  x /= PALM_LANDMARKS.length;
  y /= PALM_LANDMARKS.length;

  return {
    gesture: top?.categoryName || 'None',
    score: top?.score ?? 0,
    // Mirror X so "moved to the user's right" means "increasing x", matching
    // the selfie-view preview.
    palm: { x: 1 - x, y },
    landmarks
  };
}

// ---------------------------------------------------------------------------
// Gesture state machine
// ---------------------------------------------------------------------------

function speedOverWindow(now) {
  const window = rec.trail.filter((p) => now - p.t <= SPEED_WINDOW_MS);
  if (window.length < 2) return 0;
  const a = window[0];
  const b = window[window.length - 1];
  const dt = (b.t - a.t) / 1000;
  if (dt <= 0) return 0;
  return Math.hypot(b.x - a.x, b.y - a.y) / dt;
}

function detectSwipe(now) {
  const window = rec.trail.filter((p) => now - p.t <= settings.swipeMaxDurationMs);
  if (window.length < 4) return null;

  const a = window[0];
  const b = window[window.length - 1];
  if (b.t - a.t < 80) return null;

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);

  if (adx >= settings.swipeMinDistance && adx >= settings.swipeAxisRatio * ady) {
    return dx > 0 ? 'right' : 'left';
  }
  if (ady >= settings.swipeMinDistance && ady >= settings.swipeAxisRatio * adx) {
    return dy > 0 ? 'down' : 'up';
  }
  return null;
}

function fire(action, source, gesture) {
  if (!action || action === 'NONE') return;
  post({ type: MSG.TRIGGER, action, source, gesture });
}

// ---------------------------------------------------------------------------
// Pointer shapes — a half-open hand steers, a thumb-to-index pinch clicks
//
// Neither is a model gesture, so both are measured straight off the landmarks.
// Every measurement is a ratio, so the same numbers work whether your hand is
// 30cm or 1m from the lens.
// ---------------------------------------------------------------------------

const lerp = (a, b, t) => a + (b - a) * t;

const dist2d = (landmarks, a, b) =>
  Math.hypot(landmarks[a].x - landmarks[b].x, landmarks[a].y - landmarks[b].y);

/**
 * How far a finger reaches: the tip's distance from the wrist over its own
 * knuckle's. ~1.9 straight out, ~0.95 folded back into the palm.
 *
 * Measuring from the wrist rather than within the finger is deliberate. Most of
 * what changes between a flat palm and a relaxed hand is flexion at the
 * knuckle, which leaves the finger itself straight — a curl measured along the
 * finger's own bones can't see it at all. Both distances share an origin, so
 * hand size and in-plane rotation cancel.
 */
function reach(landmarks, mcp, tip) {
  const base = dist2d(landmarks, 0, mcp);
  if (base < 1e-4) return 1;
  return dist2d(landmarks, 0, tip) / base;
}

/**
 * @returns `{ posed, openness, pinch }`, or `null` if the hand can't be read.
 *          `posed` is whether the hand is half open enough to steer and `pinch`
 *          is the thumb-to-index gap in palm widths. `openness` is the 0…1
 *          average behind `posed`, carried out for diagnostics — the state
 *          machine doesn't read it, but it's what the shape tests assert on.
 * @param engaged whether the cursor is already up — it takes a looser hand to
 *          keep it than to raise it, because your hand drifts while steering.
 */
function pointerReading(landmarks, tolerance, engaged) {
  if (!landmarks || landmarks.length < 21) return null;

  const palmWidth = dist2d(landmarks, 5, 17);
  if (palmWidth < POINTER_MIN_PALM) return null;

  const t = clamp(tolerance, 0, 1);
  let band = lerp(POINTER_BAND[0], POINTER_BAND[1], t);
  let spread = lerp(POINTER_SPREAD[0], POINTER_SPREAD[1], t);
  if (engaged) {
    band += POINTER_HOLD_MARGIN;
    spread += POINTER_HOLD_MARGIN;
  }

  let total = 0;
  let least = 1;
  let most = 0;
  for (const [mcp, tip] of FINGERS) {
    const value = clamp(
      (reach(landmarks, mcp, tip) - REACH_FIST) / (REACH_FLAT - REACH_FIST),
      0,
      1
    );
    total += value;
    least = Math.min(least, value);
    most = Math.max(most, value);
  }
  const openness = total / FINGERS.length;

  return {
    posed: Math.abs(openness - 0.5) <= band && most - least <= spread,
    openness,
    pinch: dist2d(landmarks, THUMB_TIP, INDEX_TIP) / palmWidth
  };
}

/**
 * One Euro filter. A plain moving average has to choose between jitter at rest
 * and lag while moving; this one widens its own cutoff with speed, so the
 * cursor sits still when your hand does and still keeps up when it doesn't.
 */
function makeFilter(minCutoff, beta) {
  let value = null;
  let derivative = 0;
  const alpha = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));

  return (next, dt) => {
    if (value === null) {
      value = next;
      return value;
    }
    const rate = (next - value) / dt;
    derivative += alpha(1, dt) * (rate - derivative);
    const cutoff = minCutoff + beta * Math.abs(derivative);
    value += alpha(cutoff, dt) * (next - value);
    return value;
  };
}

/**
 * Palm centre -> viewport fractions, via the configured active area. Takes the
 * mirrored palm `readHand` already computes, so moving your hand to *your*
 * right moves the cursor right.
 */
function mapToViewport(palm) {
  const rangeX = clamp(settings.pointerRangeX, 0.2, 1);
  const rangeY = clamp(settings.pointerRangeY, 0.2, 1);
  return {
    x: clamp((palm.x - (0.5 - rangeX / 2)) / rangeX, 0, 1),
    y: clamp((palm.y - (0.5 - rangeY / 2)) / rangeY, 0, 1)
  };
}

function startPointer(now, palm, reading) {
  const smoothing = clamp(settings.pointerSmoothing, 0, 1);
  // Snappy at 0 (4 Hz cutoff), heavily damped at 1 (0.6 Hz).
  const minCutoff = lerp(4, 0.6, smoothing);
  const beta = lerp(0.9, 0.1, smoothing);
  ptr.filterX = makeFilter(minCutoff, beta);
  ptr.filterY = makeFilter(minCutoff, beta);

  const target = mapToViewport(palm);
  ptr.active = true;
  ptr.x = ptr.filterX(target.x, 0.05);
  ptr.y = ptr.filterY(target.y, 0.05);
  ptr.lastAt = now;
  // Adopt the pinch as it stands rather than counting it as a fresh click —
  // raising the cursor with your fingers already together shouldn't click.
  ptr.pinched = reading.pinch <= pinchThresholds().close;
}

function endPointer() {
  if (!ptr.active) return;
  ptr.active = false;
  ptr.poseSince = 0;
  ptr.pinched = false;
  ptr.raw = null;
  ptr.filterX = null;
  ptr.filterY = null;
  post({ type: MSG.CURSOR, cursor: { active: false } });
}

/**
 * The gap that closes a pinch and the wider one that releases it. Two separate
 * points, or a hand hovering on the threshold would fire clicks continuously.
 */
function pinchThresholds() {
  const close = clamp(settings.pointerPinchDistance, 0.1, 0.9);
  return { close, open: close + POINTER_PINCH_HYSTERESIS };
}

/**
 * Runs every frame, hand or no hand, so the cursor can time itself out.
 *
 * @returns `{ active, arming, armProgress, pinch }` — the two truthy states
 *          both mean the pointer owns this hand and nothing else may act on it.
 */
function updatePointer(now, hand) {
  const reading =
    hand && settings.pointerEnabled
      ? pointerReading(hand.landmarks, settings.pointerTolerance, ptr.active)
      : null;

  // Pinching deforms the hand, so once you are steering a held pinch keeps the
  // cursor up on its own. Clicking must never cost you the cursor.
  const holding = !!reading && (reading.posed || (ptr.active && ptr.pinched));

  if (!holding) {
    // Detection flickers; one dropped frame shouldn't drop the cursor.
    if (now - ptr.lastPoseAt > POINTER_RELEASE_MS) {
      endPointer();
      ptr.poseSince = 0;
      return { active: false, arming: false };
    }
    const armMs = Math.max(1, settings.pointerArmMs);
    return {
      active: ptr.active,
      arming: !ptr.active && ptr.poseSince > 0,
      armProgress: ptr.poseSince ? clamp((now - ptr.poseSince) / armMs, 0, 1) : 0
    };
  }

  ptr.lastPoseAt = now;
  if (!ptr.poseSince) ptr.poseSince = now;

  const armMs = Math.max(0, settings.pointerArmMs);
  if (!ptr.active && now - ptr.poseSince < armMs) {
    return {
      active: false,
      arming: true,
      armProgress: clamp((now - ptr.poseSince) / Math.max(1, armMs), 0, 1)
    };
  }

  if (!ptr.active) startPointer(now, hand.palm, reading);
  else {
    const dt = clamp((now - ptr.lastAt) / 1000, 0.005, 0.2);
    const target = mapToViewport(hand.palm);
    ptr.x = ptr.filterX(target.x, dt);
    ptr.y = ptr.filterY(target.y, dt);
    ptr.lastAt = now;
  }
  // Frame coordinates, un-mirrored again, purely for the preview overlay.
  ptr.raw = { x: 1 - hand.palm.x, y: hand.palm.y };

  // The click is the *closing* edge. Holding the pinch does nothing more, and
  // the fingers have to separate past `open` before another click can fire.
  const { close, open } = pinchThresholds();
  let click = false;
  if (!ptr.pinched && reading.pinch <= close) {
    ptr.pinched = true;
    click = true;
  } else if (ptr.pinched && reading.pinch >= open) {
    ptr.pinched = false;
  }

  // 0 when the fingers are apart, 1 when they meet — the cursor's pinch ring,
  // and the readout to tune `pointerPinchDistance` against.
  const pinch = clamp((open - reading.pinch) / Math.max(0.01, open - close), 0, 1);

  post({
    type: MSG.CURSOR,
    cursor: { active: true, x: ptr.x, y: ptr.y, pinch, down: ptr.pinched, click }
  });
  return { active: true, arming: false, armProgress: 1, pinch, down: ptr.pinched };
}

function processHand(now, hand) {
  // Runs even with no hand and even when the pointer is switched off, so a
  // cursor that is already up always gets its release timer.
  const pointer = updatePointer(now, hand);

  // Steering owns the hand outright: sweeping across the screen must not read
  // as a swipe, and a half-open hand must not read as a pose on the way past.
  if (pointer.active || pointer.arming) {
    rec.candidate = null;
    rec.fired = false;
    rec.trail.length = 0;
    rec.lastHandAt = now;
    return {
      gesture: null,
      score: hand?.score ?? 0,
      progress: pointer.active ? 1 : pointer.armProgress,
      handPresent: !!hand,
      pointer
    };
  }

  if (!hand) {
    if (now - rec.lastHandAt > HAND_LOST_MS) rec.trail.length = 0;
    if (rec.candidate && now - rec.candidateSeenAt > settings.releaseMs) {
      rec.candidate = null;
      rec.fired = false;
    }
    return { gesture: null, score: 0, progress: 0, handPresent: false };
  }

  rec.lastHandAt = now;
  rec.trail.push({ t: now, x: hand.palm.x, y: hand.palm.y });
  while (rec.trail.length && now - rec.trail[0].t > TRAIL_MS) rec.trail.shift();

  // --- swipes win over poses: they're deliberate and short-lived ---
  if (settings.swipeEnabled && now - rec.lastActionAt >= settings.cooldownMs) {
    const direction = detectSwipe(now);
    if (direction) {
      rec.trail.length = 0;
      rec.lastActionAt = now;
      rec.candidate = null;
      rec.fired = false;
      fire(settings.swipeBindings[direction], 'swipe', direction);
      return { gesture: null, score: 0, progress: 0, handPresent: true, swipe: direction };
    }
  }

  // --- held poses ---
  const name = hand.gesture;
  const recognised = name && name !== 'None' && hand.score >= settings.minGestureScore;

  if (!recognised) {
    if (rec.candidate && now - rec.candidateSeenAt > settings.releaseMs) {
      rec.candidate = null;
      rec.fired = false;
    }
    return { gesture: null, score: hand.score, progress: 0, handPresent: true };
  }

  if (rec.candidate !== name) {
    rec.candidate = name;
    rec.candidateSince = now;
    rec.fired = false;
  }
  rec.candidateSeenAt = now;

  // A moving hand is mid-swipe, not holding a pose — keep restarting the timer.
  if (speedOverWindow(now) > settings.maxHoldSpeed) {
    rec.candidateSince = now;
    return { gesture: name, score: hand.score, progress: 0, handPresent: true };
  }

  const binding = settings.bindings[name] || { action: 'NONE', repeat: false };
  const held = now - rec.candidateSince;
  const progress = clamp(held / Math.max(1, settings.holdMs), 0, 1);

  if (binding.action && binding.action !== 'NONE') {
    if (!rec.fired && held >= settings.holdMs && now - rec.lastActionAt >= settings.cooldownMs) {
      fire(binding.action, 'pose', name);
      rec.fired = true;
      rec.lastFireAt = now;
      rec.lastActionAt = now;
    } else if (rec.fired && binding.repeat && now - rec.lastFireAt >= settings.repeatMs) {
      fire(binding.action, 'pose', name);
      rec.lastFireAt = now;
      rec.lastActionAt = now;
    }
  }

  return {
    gesture: name,
    score: hand.score,
    progress: rec.fired ? 1 : progress,
    handPresent: true
  };
}

// ---------------------------------------------------------------------------
// Telemetry + preview (only produced while something is watching)
// ---------------------------------------------------------------------------

function emitTelemetry(now, view) {
  // Nobody is listening: no popup open and the on-page HUD is switched off.
  if (!settings.showHud && now > previewWantedUntil) return;
  if (now - lastTelemetryAt < TELEMETRY_INTERVAL_MS) return;
  lastTelemetryAt = now;
  post({
    type: MSG.TELEMETRY,
    telemetry: {
      gesture: view.gesture,
      label: view.gesture ? GESTURE_LABELS[view.gesture] || view.gesture : null,
      score: view.score,
      progress: view.progress,
      handPresent: view.handPresent,
      swipe: view.swipe || null,
      pointer: view.pointer?.active
        ? { active: true, pinch: view.pointer.pinch || 0, down: !!view.pointer.down }
        : view.pointer?.arming
          ? { active: false, arming: true }
          : null,
      fps: Math.round(fps),
      delegate: activeDelegate
    }
  });
}

function drawPreview(now, hand, view) {
  if (now > previewWantedUntil) return;
  if (now - lastPreviewAt < PREVIEW_INTERVAL_MS) return;
  lastPreviewAt = now;

  const { width, height } = previewCanvas;
  previewCtx.save();
  if (settings.mirrorPreview) {
    previewCtx.translate(width, 0);
    previewCtx.scale(-1, 1);
  }
  previewCtx.drawImage(videoEl, 0, 0, width, height);
  previewCtx.restore();

  if (hand?.landmarks) {
    const toX = (lm) => (settings.mirrorPreview ? 1 - lm.x : lm.x) * width;
    const toY = (lm) => lm.y * height;

    previewCtx.lineWidth = 2;
    previewCtx.strokeStyle = 'rgba(126, 231, 135, 0.9)';
    previewCtx.beginPath();
    for (const { start, end } of GestureRecognizer.HAND_CONNECTIONS) {
      const a = hand.landmarks[start];
      const b = hand.landmarks[end];
      if (!a || !b) continue;
      previewCtx.moveTo(toX(a), toY(a));
      previewCtx.lineTo(toX(b), toY(b));
    }
    previewCtx.stroke();

    previewCtx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    for (const lm of hand.landmarks) {
      previewCtx.beginPath();
      previewCtx.arc(toX(lm), toY(lm), 2.5, 0, Math.PI * 2);
      previewCtx.fill();
    }
  }

  // While steering, show the active area and the hot spot inside it — the only
  // practical way to see why the cursor stops short of a screen edge.
  if (view?.pointer?.active && ptr.raw) {
    const rangeX = clamp(settings.pointerRangeX, 0.2, 1);
    const rangeY = clamp(settings.pointerRangeY, 0.2, 1);
    previewCtx.strokeStyle = 'rgba(125, 211, 252, 0.75)';
    previewCtx.setLineDash([5, 4]);
    previewCtx.lineWidth = 1.5;
    // The active area is symmetric about the centre, so mirroring can't move it.
    previewCtx.strokeRect(
      ((1 - rangeX) / 2) * width,
      ((1 - rangeY) / 2) * height,
      rangeX * width,
      rangeY * height
    );
    previewCtx.setLineDash([]);

    const hotX = (settings.mirrorPreview ? 1 - ptr.raw.x : ptr.raw.x) * width;
    const hotY = ptr.raw.y * height;
    previewCtx.fillStyle = 'rgba(125, 211, 252, 0.95)';
    previewCtx.beginPath();
    previewCtx.arc(hotX, hotY, 6, 0, Math.PI * 2);
    previewCtx.fill();
  }

  post({ type: MSG.PREVIEW_FRAME, dataUrl: previewCanvas.toDataURL('image/jpeg', 0.6) });
}

// ---------------------------------------------------------------------------
// Settings + messaging
// ---------------------------------------------------------------------------

const RESTART_KEYS = [
  'cameraDeviceId',
  'delegate',
  'numHands',
  'minHandDetectionConfidence',
  'minTrackingConfidence'
];

async function applySettings(next) {
  const previous = settings;
  settings = next;

  if (!settings.enabled) {
    if (running || starting) stop(ENGINE.OFF);
    return;
  }

  const needsRestart =
    previous && RESTART_KEYS.some((key) => previous[key] !== settings[key]);

  if (needsRestart) {
    stop(ENGINE.STARTING, 'Applying new settings…');
    recognizer?.close?.();
    recognizer = null;
    await start();
    return;
  }

  if (!running && !starting) await start();
}

/**
 * Offscreen documents are only granted `chrome.runtime` — `chrome.storage` is
 * undefined here, so settings are requested from (and pushed by) the worker.
 */
async function requestSettings() {
  const response = await chrome.runtime.sendMessage({ type: MSG.SETTINGS_REQUEST });
  return mergeSettings(response?.settings);
}

chrome.runtime.onMessage.addListener((message) => {
  switch (message?.type) {
    case MSG.PREVIEW_PING:
      previewWantedUntil = performance.now() + PREVIEW_GRACE_MS;
      return false;
    case MSG.ENGINE_SETTINGS:
      applySettings(mergeSettings(message.settings)).catch((err) =>
        report(ENGINE.ERROR, String(err?.message || err))
      );
      return false;
    case MSG.ENGINE_CONFIG:
      if (typeof message.suspend === 'boolean' && message.suspend !== suspended) {
        suspended = message.suspend;
        if (running) report(suspended ? ENGINE.SUSPENDED : ENGINE.RUNNING, `${activeDelegate} delegate`);
      }
      return false;
    case MSG.ENGINE_QUERY:
      // The worker restarted and lost its copy of our state.
      post({ type: MSG.ENGINE_STATUS, ...lastStatus });
      return false;
    case MSG.ENGINE_STOP:
      stop(ENGINE.OFF);
      return false;
    default:
      return false;
  }
});

window.addEventListener('pagehide', () => stop(ENGINE.OFF));

(async () => {
  try {
    settings = await requestSettings();
  } catch (err) {
    report(ENGINE.ERROR, `Could not read settings: ${err?.message || err}`);
    return;
  }
  if (settings.enabled) await start();
  else report(ENGINE.OFF);
})();
