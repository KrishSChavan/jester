/**
 * The recognition engine.
 *
 * Runs in an offscreen document so the camera stream and the per-frame
 * inference loop have a stable home. Everything here is local: frames never
 * leave this document, only gesture *decisions* are messaged out.
 */

import {
  FaceLandmarker,
  FilesetResolver,
  GestureRecognizer
} from '../../vendor/tasks-vision/vision_bundle.mjs';
import {
  MSG,
  ENGINE,
  GESTURES,
  bindingsFor,
  swipeBindingsFor,
  mergeSettings,
  resumeGlyphs,
  resumesStandby,
  post,
  clamp
} from '../common/constants.js';
import { GazeModel, makeGazeFilter, makeNoiseTracker, poseDrift, poseSummary } from '../common/gaze.js';
import { usableModel } from '../common/gaze-store.js';
import { headPose, makeHeadPointer } from '../common/head.js';
import { readEyes } from './eyes.js';
import { landmarksFromCrop, makeZoom } from './zoom.js';
import { fromJester } from '../common/senders.js';
import { createVoice, MIC } from './voice.js';

const WASM_PATH = chrome.runtime.getURL('vendor/tasks-vision/wasm');
const MODEL_PATH = chrome.runtime.getURL('models/gesture_recognizer.task');
const FACE_MODEL_PATH = chrome.runtime.getURL('models/face_landmarker.task');

/** Landmarks that together form a stable palm centre, ignoring finger flex. */
const PALM_LANDMARKS = [0, 5, 9, 13, 17];
/**
 * `[knuckle, tip]` for index, middle, ring and pinky. The thumb is left out on
 * purpose: it folds across the palm in a fist and sticks out in a thumbs-up,
 * and would drag the reading of how open the hand is along with it.
 */
const FINGERS = [
  [5, 8],
  [9, 12],
  [13, 16],
  [17, 20]
];
/**
 * While the popup or calibration preview is open but nobody is using the
 * pointer, the face is read every Nth frame — enough to draw it, and no more.
 */
const GAZE_PREVIEW_EVERY = 3;
/**
 * With the zoom on, the face is followed even when nothing reads the eyes — it
 * is how the hands' crop knows where the person is — but every Nth frame is
 * plenty for that. Searching for a face, every frame.
 */
const FACE_FOLLOW_EVERY = 3;
/** A gaze reading older than this is no longer evidence of where you are looking. */
const GAZE_STALE_MS = 600;
const TRAIL_MS = 700;
const SPEED_WINDOW_MS = 150;
const HAND_LOST_MS = 150;
const PREVIEW_GRACE_MS = 2000;
const PREVIEW_INTERVAL_MS = 100;
const TELEMETRY_INTERVAL_MS = 80;
/** Telemetry that hasn't changed is still sent this often, so a popup that has just opened catches up. */
const TELEMETRY_HEARTBEAT_MS = 1000;
const CAMERA_TIMEOUT_MS = 8000;
const MODEL_TIMEOUT_MS = 30000;
/**
 * A camera that has sent nothing new for this long has stalled: what it last
 * showed is no longer now, and nothing is treated as in view until it sends
 * another picture. Replaying the last one would keep a held pose firing.
 */
const STALE_FRAME_MS = 400;
/**
 * How long a start waits for the camera's video to begin playing. A camera
 * that opens but never sends a picture leaves `play()` pending for good — and
 * the start, and every settings change queued behind it, with it. The frame
 * loop waits for the picture itself, and says when none comes.
 */
const PLAY_WAIT_MS = 4000;
/** Running this long without a single picture, the popup is told the camera has stalled. */
const NO_PICTURE_MS = 2000;
const TIMED_OUT = Symbol('timed-out');

/**
 * What MediaPipe is shown. Its detectors shrink whatever they're given to a
 * small square, and measured on the bundled models a 1080p frame shrunk ten
 * times over lost hands a 640-pixel one kept — so the whole frame goes to the
 * hand recogniser already shrunk, smoothly, to this width. Crops are drawn at
 * these sizes. See src/offscreen/zoom.js.
 */
const HAND_FULL_WIDTH = 640;
/**
 * A crop is drawn at its own size, within these bounds: shrinking it would
 * throw away the pixels the zoom is for, and the models' own inputs are
 * smaller than the low end anyway.
 */
const HAND_CROP_SIZE = [512, 768];
const FACE_CROP_SIZE = [384, 768];
const NO_CROPS = { face: null, hands: null, searching: false };

/**
 * Hand movements are measured in hand sizes, not frame widths, so a swipe is
 * the same arm movement at the desk and across the room. A palm — wrist to
 * middle knuckle — this share of a 4:3 frame's width counts movements at face
 * value: a hand at a laptop's distance in the 640×480 picture the settings'
 * numbers were tuned on. Bounded, so a hand foreshortened to nothing can't
 * blow its jitter up into a swipe.
 */
const REFERENCE_PALM = 0.13;
const REFERENCE_FRAME_BOUNDS = [0.1, 2];

/**
 * What `reach3d()` returns at each end of a finger's range. Everything in
 * between is scaled onto 0 (folded away) to 1 (straight out).
 */
const REACH_FIST = 0.95;
const REACH_FLAT = 1.9;

/**
 * The click hand: an open palm arms it, closing to a fist fires.
 *
 * Two widely separated thresholds rather than one, so a half-curled hand
 * resting between them can't chatter. Arming on the *open* state is what makes
 * this an edge rather than a level — a hand that simply arrives as a fist
 * clicks nothing. Measured off the test imagery the same way: an open hand
 * reads 0.70, a thumbs-up fist 0.20.
 */
const PALM_OPEN = 0.62;
const FIST_CLOSED = 0.28;

/** The hand may drop out of view this long without ending the cursor. */
const POINTER_RELEASE_MS = 320;

/**
 * A raised palm faces the camera within about 60°. Measured: 0.76 for an open
 * hand reaching toward the lens, 0.98 for the back of a hand held up to it.
 */
const PALM_FACING = 0.5;
/**
 * Squarely enough to be *meant*: what the popup's "this palm would raise the
 * cursor if…" hint waits for, so a hand resting open in front of the chest —
 * which can face the camera at half that — doesn't keep it on.
 */
const PALM_SHOWN = 0.7;

/**
 * Poses the model can name that are not a palm and not a fist. Made with the
 * hand that is holding the cursor, they mean the user wants that pose, not the
 * cursor: held steady, the cursor stands down and the pose does its job.
 */
const OTHER_POSES = new Set(['Victory', 'Thumb_Up', 'Thumb_Down', 'Pointing_Up', 'ILoveYou']);
/**
 * Of those, the ones that fold the four fingers the way a fist does — so
 * openness alone takes them for the fist that clicks, and the model in turn
 * sometimes names a real fist as one of them. Each is believed only when its
 * one straight digit really is straight.
 */
const FOLDED_POSES = new Set(['Thumb_Up', 'Thumb_Down', 'Pointing_Up']);
/**
 * Where that digit has to be. Measured on the test imagery: a thumbs-up's
 * thumb tip stands 1.07–1.11 palm lengths from the middle finger's second
 * knuckle and a fist's 0.13–0.29; a pointing index reads 0.98 straight, a
 * fist's 0.
 */
const THUMB_OUT = 0.7;
const INDEX_OUT = 0.6;
/**
 * How long a pose must hold, with the hand no longer closing, to take the hand
 * back from the cursor: a close passes through shapes the model will name for
 * a frame or two on its way to the fist, and those must not cancel the click.
 */
const POSE_TAKEOVER_MS = 250;
/** Openness lost since a pose appeared that says the hand is still closing, not holding it. */
const POSE_SLIP = 0.08;

const GESTURE_LABELS = Object.fromEntries(GESTURES.map((g) => [g.id, g.label]));

const videoEl = document.getElementById('camera');
const previewCanvas = document.getElementById('preview');
const previewCtx = previewCanvas.getContext('2d', { willReadFrequently: false });
/** The current camera frame, copied once per camera frame so every model reads the same picture. */
const frameCanvas = document.createElement('canvas');
const frameCtx = frameCanvas.getContext('2d', { alpha: false });
/** What the hand recogniser is shown: the whole frame shrunk, or a crop enlarged. */
const handCanvas = document.createElement('canvas');
const handCtx = handCanvas.getContext('2d', { alpha: false });
/** What the face tracker is shown when it is zoomed in. */
const faceCanvas = document.createElement('canvas');
const faceCtx = faceCanvas.getContext('2d', { alpha: false });

let settings = null;
let recognizer = null;
let stream = null;
let timer = null;
let running = false;
let starting = false;
/**
 * Bumped by every start() and every stop(). A start() whose number is no
 * longer current has been superseded — a restart came in while it was waiting
 * on the model or the camera — and gives back whatever it was given.
 */
let startGen = 0;
let suspended = false;
/**
 * Paused by a gesture (SLEEP), camera still on. Every pose, swipe and
 * the eye pointer stand down except the gestures that resume Jester — ✌️ out
 * of the box — which are all the engine still watches for. Unlike `suspended`,
 * inference keeps running: it has to, to see them.
 *
 * Kept here rather than in the worker because it changes how the very next
 * frame is read. It lives and dies with this document, so switching Jester off
 * and on, or Restart, starts it listening again.
 */
let standby = false;
let activeDelegate = null;
/**
 * Which binding set is live. Only the service worker can see whether the front
 * window is fullscreen, so it owns this and pushes changes here.
 *
 * Starts at `fullscreen` because that is the set everything falls back to —
 * a boot that raced the first push must not quietly run the *other* bindings.
 */
let viewContext = 'fullscreen';

/**
 * The face tracker, created the first time anything needs the face — so
 * someone who never uses the pointer or the zoom never pays for loading it.
 * `failed` sticks until the engine restarts: it is a missing capability, not a
 * flicker.
 */
let faceLandmarker = null;
let landmarkerState = 'idle'; // 'idle' | 'loading' | 'ready' | 'failed'
let landmarkerError = '';
let landmarkerLoading = null;
/**
 * Bumped whenever the engine's models are thrown away, so a tracker that
 * finishes loading afterwards knows it belongs to an engine that no longer
 * exists.
 */
let modelGeneration = 0;

let lastVideoTime = -1;
let lastTimestamp = 0;
let frameCount = 0;
/** Pushed by the service worker; this document has no chrome.storage. */
let calibration = null;
/**
 * The camera actually open — not the one asked for in Settings, which may be
 * "whatever the default is" or may have gone missing and been replaced. A
 * calibration belongs to the camera it was made through.
 */
let liveCameraId = null;
/** The screen size of the tab in front, from the worker; null when unknown. */
let pageScreen = null;
/** `calibration`, ready to predict from — or null if there is none it can use. */
let gazeModel = null;
/**
 * How noisy `gazeModel`'s readings are, learnt from calibration and then from
 * use — one per calibration, shared by every cursor, so it keeps learning.
 */
let gazeNoise = null;
/** The calibration `gazeModel` was last decided for, so it's only rebuilt when that changes. */
let gazeModelFor = undefined;
/**
 * Calibration is a *lease*, not a latch.
 *
 * It used to be a boolean that only a message could clear — and if the
 * calibration tab closed before that message landed (`pagehide` fires
 * `sendMessage` asynchronously, and the page can die first), the engine stayed
 * in calibration mode forever, silently suppressing every pose, every swipe and
 * the pointer. Same shape as `previewWantedUntil`: the screen has to keep
 * asking, and silence ends it.
 */
let calibrationUntil = 0;
const CALIBRATION_LEASE_MS = 2500;
/** The recogniser's latest result, landmarks in whole-frame coordinates — or null when nothing current. */
let lastResult = null;
/** `readHands(lastResult)`, worked out once per camera frame. */
let lastHands = [];
let fps = 0;
let lastFrameAt = 0;
let previewWantedUntil = 0;
let lastPreviewAt = 0;
let lastTelemetryAt = 0;
let lastTelemetryKey = '';
let lastStatus = { state: ENGINE.OFF, detail: '' };

/** Where the zoom looks: see src/offscreen/zoom.js. Remade whenever the camera's frame size changes. */
let zoom = null;
/** This frame's crops: `{ face, hands, searching }`. */
let crops = NO_CROPS;
/** The face's landmarks if it was read this camera frame, in whole-frame coordinates. */
let facePointsNow = null;

const rec = {
  candidate: null,
  candidateSince: 0,
  candidateSeenAt: 0,
  fired: false,
  lastFireAt: 0,
  lastActionAt: 0,
  lastHandAt: 0,
  /** A different pose taking over from one that already fired: which, and since when. */
  switchTo: null,
  switchSince: 0,
  /** The read hand's palm path: `{ t, x, y, palm }`, pixels, x mirrored. */
  trail: []
};

/** What `updatePointer()` last said, for telemetry — whichever way the frame went after it. */
let pointerView = null;

const ptr = {
  /** When the palm went up, while the cursor is still arming. */
  palmSince: 0,
  lastOpenAt: 0,
  /** What the eyes said while the palm was arming; the cursor starts from their median. */
  armReadings: [],
  active: false,
  /** How it is aimed: 'hybrid' (the eyes, then the head), 'eyes', or 'head'. */
  mode: null,
  /** The screen it is placed on, px: `{ w, h }`. */
  screen: null,
  /** When the cursor was last put on screen — engaged, or back from hiding under a held fist. */
  shownAt: 0,
  hidden: false,
  /** Where the cursor is, as fractions of `screen`. */
  x: 0.5,
  y: 0.5,
  lastPointAt: 0,
  lastHeadAt: 0,
  lastHandAt: 0,
  /** True while the hand is holding the fist it just clicked with. */
  down: false,
  downSince: 0,
  /** The eyes' fixation filter (eyes and hybrid), and its latest answer. */
  filter: null,
  gazeAt: null,
  /** The head pointer (hybrid and head). */
  head: null,
  /** The head's recent angles, to tell steering from drift: `{ t, yaw, pitch }`. */
  headTrail: [],
  /** Hybrid: until when a fresh look settles the cursor onto the eyes' average, and when that look landed. */
  settleUntil: 0,
  anchoredAt: 0,
  /** Hybrid: the head hasn't come to rest since that look landed — its turning is follow-through, not steering. */
  following: false,
  /** Hybrid: where the eyes were when the hand began to close, until it opens and they've been read again. */
  closedGaze: null,
  /** Whether the latest reading, and the one before it, landed past the screen's edge. */
  pastEdge: false,
  offscreen: false,
  /** Whether the head has moved since calibration, as `poseDrift()` put it. */
  drift: null,
  /** Where the last cursor was when it went down, for a head-steered one coming back. */
  lastCursor: null,
  /**
   * What clicking has taught about where the eyes' reading lands this session:
   * px added to it. Each click in hybrid mode is a look at a known point — the
   * user steered the cursor onto what they meant — so the gap between that and
   * what the eyes read there is the calibration's error here and now. Kept for
   * the session only, and bounded.
   */
  sessionBias: [0, 0]
};

const gaze = {
  /**
   * The latest reading of the face: `{ at, seq, face }`, plus everything
   * `readEyes()` returns and the `occluded`, `blink` and `cropped` flags when
   * the eyes could be read.
   */
  last: null,
  seq: 0,
  /** The latest usable prediction, in screen pixels: `{ x, y, at }`. */
  point: null,
  /** The latest head pose: `{ pose, at }`. */
  head: null,
  /** Recent eyelid readings, `{ at, value }` — how open this person's eyes normally are. */
  ear: [],
  blinkTail: 0
};

// ---------------------------------------------------------------------------
// Status reporting
// ---------------------------------------------------------------------------

function report(state, detail = '') {
  // The camera actually open rides along, so Settings can judge a calibration
  // against the same camera the engine does — not the one merely picked.
  lastStatus = { state, detail, cameraId: liveCameraId, mic: micStatus };
  post({ type: MSG.ENGINE_STATUS, ...lastStatus });
}

/** What a running engine is doing. Suspended outranks paused: suspended, nothing is read at all. */
function reportRunning() {
  if (suspended) report(ENGINE.SUSPENDED, `${activeDelegate} delegate`);
  else if (standby) report(ENGINE.SLEEPING, `Hold ${resumeGlyphs(settings)} to resume — the camera stays on to watch for it.`);
  else report(ENGINE.RUNNING, `${activeDelegate} delegate`);
}

// ---------------------------------------------------------------------------
// Engine start / stop
// ---------------------------------------------------------------------------

/**
 * A model load that might never finish. If it takes longer than `ms` the
 * caller gives up — and whatever arrives afterwards is closed, not leaked: a
 * MediaPipe task holds a WASM heap and a GPU context.
 */
function loadWithin(pending, ms, message) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([pending, timeout]).then((result) => {
    clearTimeout(timer);
    if (result !== TIMED_OUT) return result;
    pending.then((late) => (late?.instance || late)?.close?.()).catch(() => undefined);
    throw new Error(message);
  });
}

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
      return { instance, delegate };
    } catch (err) {
      lastError = err;
      console.warn(`[jester] ${delegate} delegate unavailable:`, err);
    }
  }
  throw lastError || new Error('Could not create the gesture recognizer');
}

/**
 * The face tracker: the eyes for the gaze model, the head for the head
 * pointer, and the person for the zoom. Its blendshapes and pose matrix are
 * read too — the gaze blendshapes and which way the head points — and cost
 * little next to the landmarks themselves.
 */
async function createFaceLandmarker(preferredDelegate) {
  const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
  let lastError = null;
  for (const delegate of preferredDelegate === 'CPU' ? ['CPU'] : ['GPU', 'CPU']) {
    try {
      return await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: FACE_MODEL_PATH, delegate },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true
      });
    } catch (err) {
      lastError = err;
      console.warn(`[jester] face tracker unavailable on ${delegate}:`, err);
    }
  }
  throw lastError || new Error('Could not create the face tracker');
}

/**
 * A MediaPipe graph that has thrown once is broken for good — every later call
 * throws too, whatever the timestamp — so a failure closes it, and it gets one
 * fresh start after a pause. Failing again soon after is a tracker that isn't
 * going to work, and the pointer stands down until the engine restarts or
 * calibration is opened again.
 */
const TRACKER_RETRY_MS = 5000;
const TRACKER_GIVE_UP_MS = 60000;
let trackerBrokeAt = 0;
let trackerRetryAfter = 0;
/** The last timestamp the face tracker was given; it must never see one twice. */
let lastFaceTs = 0;
/** The first detect on a new tracker is slow; it is spent on a frame nobody is waiting for. */
let trackerWarm = false;

function trackerBroke(err) {
  try {
    faceLandmarker?.close?.();
  } catch {
    /* already broken; closing is only to hand back its memory */
  }
  faceLandmarker = null;
  lastFaceTs = 0;
  trackerWarm = false;
  const now = performance.now();
  if (trackerBrokeAt && now - trackerBrokeAt < TRACKER_GIVE_UP_MS) {
    landmarkerState = 'failed';
    landmarkerError = String(err?.message || err);
  } else {
    landmarkerState = 'idle';
    trackerRetryAfter = now + TRACKER_RETRY_MS;
  }
  trackerBrokeAt = now;
  console.warn('[jester] the face tracker failed', err);
}

/** A fresh chance for a tracker that gave up: a restart, or calibration being opened. */
function forgiveTracker() {
  if (landmarkerState === 'failed') landmarkerState = 'idle';
  landmarkerError = '';
  trackerBrokeAt = 0;
  trackerRetryAfter = 0;
}

/**
 * Start loading the face tracker if nothing has yet. Returns at once: the
 * frame loop is synchronous and must not wait on a 4 MB model, so until it
 * lands the face simply reads as "not yet".
 *
 * Deliberately non-fatal, and deliberately never an unhandled rejection —
 * boot.js reports those as the whole engine failing, and losing the face is
 * not that. A load that never finishes is given up on like one that fails.
 */
function ensureFaceLandmarker() {
  if (faceLandmarker || landmarkerLoading || landmarkerState === 'failed') return;
  // Never alongside the recognizer's own load, and not straight after a break.
  if (starting || performance.now() < trackerRetryAfter) return;
  landmarkerState = 'loading';
  const generation = modelGeneration;
  const pending = loadWithin(createFaceLandmarker(settings.delegate), MODEL_TIMEOUT_MS, 'the face tracker took too long to load')
    .then(
      (instance) => {
        if (generation !== modelGeneration) {
          instance.close?.();
          return;
        }
        faceLandmarker = instance;
        landmarkerState = 'ready';
        lastFaceTs = 0;
        trackerWarm = false;
      },
      (err) => {
        if (generation !== modelGeneration) return;
        landmarkerState = 'failed';
        landmarkerError = String(err?.message || err);
        console.warn('[jester] the face tracker is unavailable:', err);
      }
    )
    .finally(() => {
      if (landmarkerLoading === pending) landmarkerLoading = null;
    });
  landmarkerLoading = pending;
}

/** Throw the face tracker away: a restart of the models, or an engine stopping for good. */
function dropFaceLandmarker() {
  modelGeneration += 1;
  try {
    faceLandmarker?.close?.();
  } catch {
    /* it is being given up on either way */
  }
  faceLandmarker = null;
  landmarkerState = 'idle';
  landmarkerError = '';
  landmarkerLoading = null;
  lastFaceTs = 0;
  trackerWarm = false;
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

/**
 * Full HD where the camera has it. More pixels don't help MediaPipe find a
 * hand in the whole frame — it shrinks the frame first — but they are what the
 * zoom enlarges when you're across the room, where a hand is a few dozen
 * pixels tall even at 1080p. 16:9 is also wider than 4:3, so a hand raised
 * beside the shoulder stays in view.
 */
async function openCamera() {
  const video = {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 30 }
  };
  if (settings.cameraDeviceId) video.deviceId = { exact: settings.cameraDeviceId };

  try {
    return await navigator.mediaDevices.getUserMedia({ video, audio: false });
  } catch (err) {
    // A saved device can disappear (unplugged dock, etc.) — retry with any camera.
    if (settings.cameraDeviceId && err?.name === 'OverconstrainedError') {
      return navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
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
  const gen = ++startGen;
  // A restart (or a stop) while this was waiting makes everything it got stale.
  const superseded = () => gen !== startGen;

  // Cheapest and by far the most common failure — check it before spending 8MB
  // of model load on a run that can't succeed.
  const permission = await cameraPermissionState();
  if (superseded()) return;
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
      const loaded = await loadWithin(createRecognizer(settings.delegate), MODEL_TIMEOUT_MS, 'model load timed out');
      if (superseded()) {
        loaded.instance.close?.();
        return;
      }
      recognizer = loaded.instance;
      activeDelegate = loaded.delegate;
    }
  } catch (err) {
    if (superseded()) return;
    starting = false;
    report(ENGINE.ERROR, `Model failed to load: ${err?.message || err}`);
    return;
  }

  // The face tracker is not loaded here: it loads itself the first time the
  // face is wanted (see `ensureFaceLandmarker()`), so gestures are never kept
  // waiting on it.

  report(ENGINE.STARTING, 'Opening camera…');
  let opened;
  try {
    opened = await openCameraGuarded();
  } catch (err) {
    if (superseded()) return;
    starting = false;
    const { state, detail } = describeCameraError(err);
    report(state, detail);
    return;
  }
  if (superseded()) {
    opened.getTracks().forEach((track) => track.stop());
    return;
  }
  stream = opened;
  const track = stream.getVideoTracks()[0];
  // A camera unplugged, or taken by another app, ends the track: say so,
  // rather than sit on its last picture.
  track?.addEventListener('ended', () => {
    if (stream === opened && running) stop(ENGINE.ERROR, 'The camera stopped — it was unplugged or another app took it. Hit Restart.');
  });

  videoEl.srcObject = stream;
  await Promise.race([
    // Muted MediaStream playback is allowed; a rejection here is spurious.
    videoEl.play().catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, PLAY_WAIT_MS))
  ]);
  if (superseded()) {
    opened.getTracks().forEach((t) => t.stop());
    return;
  }
  liveCameraId = track?.getSettings?.().deviceId || '';

  resetRecognitionState();
  running = true;
  starting = false;
  lastVideoTime = -1;
  lastFrameAt = performance.now();
  zoom = null;
  ptr.sessionBias = [0, 0];
  reportRunning();
  // A tracker that gave up gets another chance with a fresh start, and the
  // calibration is re-decided against the camera that actually opened.
  forgiveTracker();
  refreshGazeModel();
  if (settings.longRange) ensureFaceLandmarker();
  scheduleTick(0);
}

function stop(nextState = ENGINE.OFF, detail = '') {
  startGen += 1;
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
  // Eyes read before the camera closed are not evidence of where anyone is
  // looking now — nor of how open they are, if the light has changed since.
  gaze.last = null;
  gaze.point = null;
  gaze.head = null;
  gaze.ear = [];
  gaze.blinkTail = 0;
  gazeFailures = 0;
  lastResult = null;
  lastHands = [];
  zoom = null;
  crops = NO_CROPS;
  liveCameraId = null;
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
  rec.switchTo = null;
  rec.switchSince = 0;
  rec.trail.length = 0;
  endPointer();
  forgetClickHand();
}

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------

/**
 * Calibration learns from the frames in the moment before each fist, and at
 * the lowest inference rates there are too few of them to learn from. So while
 * calibration holds its lease the engine runs at least this fast, whatever the
 * setting; it drops back the moment the lease ends.
 */
const CALIBRATION_FPS = 20;

function scheduleTick(elapsed = 0) {
  if (!running) return;
  const rate = performance.now() < calibrationUntil
    ? Math.max(settings.targetFps, CALIBRATION_FPS)
    : settings.targetFps;
  const interval = 1000 / clamp(rate, 5, 60);
  timer = setTimeout(tick, Math.max(0, interval - elapsed));
}

function tick() {
  if (!running) return;
  const startedAt = performance.now();

  try {
    if (!suspended) step(startedAt);
  } catch (err) {
    console.error('[jester] inference failed', err);
    // A MediaPipe graph that has thrown is broken for good: the next start
    // must build a new one, not reuse this.
    try {
      recognizer?.close?.();
    } catch {
      /* already broken */
    }
    recognizer = null;
    stop(ENGINE.ERROR, String(err?.message || err));
    return;
  }

  scheduleTick(performance.now() - startedAt);
}

/** Make a canvas this size if it isn't, and (re)set the smoothing a resize throws away. */
function fit(canvas, ctx, w, h) {
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
}

/** The hand recogniser's picture: the whole frame shrunk, or a crop enlarged. */
function handInput(crop, W, H) {
  if (!crop) {
    const scale = Math.min(1, HAND_FULL_WIDTH / W);
    fit(handCanvas, handCtx, Math.round(W * scale), Math.round(H * scale));
    handCtx.drawImage(frameCanvas, 0, 0, handCanvas.width, handCanvas.height);
  } else {
    // At its own size, within bounds, keeping its shape: a middle-distance
    // crop is the frame's full height and narrower than it.
    const long = Math.max(crop.w, crop.h);
    const scale = clamp(long, HAND_CROP_SIZE[0], HAND_CROP_SIZE[1]) / long;
    fit(handCanvas, handCtx, Math.round(crop.w * scale), Math.round(crop.h * scale));
    handCtx.drawImage(frameCanvas, crop.x, crop.y, crop.w, crop.h, 0, 0, handCanvas.width, handCanvas.height);
  }
  return handCanvas;
}

/**
 * The face tracker's picture: the full-resolution frame — the face is big
 * there, and its landmarks are sharpest read from it — or a crop, enlarged.
 */
function faceInput(crop) {
  if (!crop) return frameCanvas;
  const side = Math.round(clamp(crop.w, FACE_CROP_SIZE[0], FACE_CROP_SIZE[1]));
  fit(faceCanvas, faceCtx, side, side);
  faceCtx.drawImage(frameCanvas, crop.x, crop.y, crop.w, crop.h, 0, 0, side, side);
  return faceCanvas;
}

const NO_VIEW = { gesture: null, score: 0, progress: 0, handPresent: false };

function step(now) {
  if (videoEl.readyState < 2 || !videoEl.videoWidth) {
    // No picture yet — or none coming, from a camera that opened but sends
    // nothing: the popup hears that it has stalled rather than nothing at all.
    if (running && now - lastFrameAt > NO_PICTURE_MS) emitTelemetry(now, NO_VIEW);
    return;
  }
  const W = videoEl.videoWidth;
  const H = videoEl.videoHeight;
  // The zoom finds people by their face. With no face tracker to find one —
  // still loading, broken, given up on — it would search for ever, cycling
  // the hands' view round the room: the whole frame instead, until there is.
  const zoomOn = settings.longRange && !!faceLandmarker && landmarkerState === 'ready';

  let fresh = false;
  facePointsNow = null;
  if (videoEl.currentTime !== lastVideoTime) {
    fresh = true;
    lastVideoTime = videoEl.currentTime;
    // MediaPipe requires strictly increasing timestamps in VIDEO mode — per
    // task, so the face tracker can share this one.
    lastTimestamp = Math.max(lastTimestamp + 1, Math.round(now));
    if (!zoom || zoom.width !== W || zoom.height !== H) zoom = Object.assign(makeZoom({ width: W, height: H }), { width: W, height: H });
    // One copy of this camera frame, read by everything below: the hands, the
    // face and the preview all see the same picture.
    fit(frameCanvas, frameCtx, W, H);
    frameCtx.drawImage(videoEl, 0, 0, W, H);
    crops = zoomOn ? zoom.crops(now) : NO_CROPS;
    const raw = recognizer.recognizeForVideo(handInput(crops.hands, W, H), lastTimestamp);
    lastResult = crops.hands ? { ...raw, landmarks: landmarksFromCrop(raw.landmarks, crops.hands, W, H) } : raw;
    lastHands = readHands(lastResult);

    frameCount += 1;
    const delta = now - lastFrameAt;
    if (lastFrameAt && delta > 0) fps = fps ? fps * 0.85 + (1000 / delta) * 0.15 : 1000 / delta;
    lastFrameAt = now;
  } else if (now - lastFrameAt > STALE_FRAME_MS && lastResult) {
    // The camera has stopped sending pictures. What it last showed isn't now:
    // nothing is in view until it sends another.
    lastResult = null;
    lastHands = [];
    fps = 0;
  }

  const hands = lastHands;
  // Once per camera frame, ahead of everything that reads it: it counts frames
  // of fist, and a tick that re-reads the same frame must not count twice.
  if (fresh) lastClick = readClickHand(now, hands);
  else if (!lastResult) lastClick = readClickHand(now, hands);
  const click = fresh ? lastClick : { ...lastClick, fired: false };
  if (fresh && faceWanted(now, click)) readFace(now, hands, W, H);
  const view = processHand(now, click, W, H);
  // After the pointer, not before: a cursor raised this frame was decided and
  // anchored through this frame's pictures, and it is those the zoom must
  // hold — not ones it would switch to on what it has just seen.
  if (fresh && zoomOn) {
    zoom.observe(now, {
      facePoints: facePointsNow,
      handLandmarks: lastResult?.landmarks || [],
      // A hand making a pose, not one at rest: what the hands' search may lock onto.
      handsActive: hands.some((h) => h.gesture !== 'None' && h.score >= settings.minGestureScore),
      handCrop: crops.hands
    });
  }
  emitTelemetry(now, view);
  drawPreview(now, hands, W, H);
}

/**
 * Every hand in the frame, with its 3D world landmarks.
 *
 * Separate from `readHand()` on purpose: the pose and swipe state machines have
 * always acted on a single best hand and still should, while the click reads
 * every hand in view, so the one making the gesture wins whoever else is there.
 */
function readHands(result) {
  const hands = [];
  const count = result?.landmarks?.length || 0;
  for (let i = 0; i < count; i += 1) {
    const landmarks = result.landmarks[i];
    const world = result.worldLandmarks?.[i];
    // No world landmarks means no 3D, and the openness measure is 3D.
    if (!landmarks || !world) continue;
    hands.push({
      landmarks,
      world,
      gesture: result.gestures?.[i]?.[0]?.categoryName || 'None',
      score: result.gestures?.[i]?.[0]?.score ?? 0,
      // Which hand this is, as far as the model can tell. Only ever a
      // tie-breaker: it can flip for a frame as a hand turns.
      side: (result.handedness || result.handednesses)?.[i]?.[0]?.categoryName || null,
      facing: palmFacing(world)
    });
  }
  return hands;
}

/**
 * How big a hand is in the picture, px: its palm, wrist to middle knuckle, or
 * its width across the knuckles scaled to match, whichever is longer — so a
 * palm tilted toward the camera, foreshortened top to bottom, still reads
 * about the size it is.
 */
function palmPixels(landmarks, W, H) {
  const d = (a, b) => Math.hypot((landmarks[a].x - landmarks[b].x) * W, (landmarks[a].y - landmarks[b].y) * H);
  return Math.max(d(0, 9), 1.6 * d(5, 17));
}

/**
 * Pick the hand the pose machine should read and reduce it to what it needs.
 *
 * A hand making a pose beats one that isn't, however sure the model is of the
 * other: a hand resting in a lap or on an armrest reads "None" with near
 * certainty (0.97, measured), and would otherwise hide the 👍 the raised hand
 * is making at 0.7. And among hands making poses, one held up to the camera
 * beats one that isn't: a hand lying open in a lap can read as ✋, more surely
 * than the ✌️ being made with the other — measured, a lap hand faces the
 * camera at 0.3–0.5, a pose made at it at 0.8–0.95. Between two held up, a
 * deliberate pose beats ✋, the shape a hand at rest falls into most often.
 * Then the most confident.
 *
 * `exclude` is one hand's landmarks to pass over — the one holding the cursor.
 * `palmTaken` says ✋ can't press its binding right now (it belongs to the
 * pointer), so a hand merely showing it counts as making no pose. In standby
 * the same goes for every pose but the ones that resume Jester.
 */
function readHand(result, W, H, exclude = null, palmTaken = false) {
  if (!result?.landmarks?.length) return null;

  let bestIndex = -1;
  let bestScore = -1;
  let poseIndex = -1;
  let poseRank = -1;
  let resumeIndex = -1;
  let resumeScore = -1;
  for (let i = 0; i < result.gestures.length; i += 1) {
    if (exclude && result.landmarks[i] === exclude) continue;
    const top = result.gestures[i]?.[0];
    const score = top?.score ?? 0;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
    const name = top?.categoryName;
    if (name && name !== 'None' && !(palmTaken && name === 'Open_Palm') && score >= settings.minGestureScore) {
      // Held up to the camera first, then a deliberate pose over ✋, then how sure the model is.
      const rank = (palmFacing(result.worldLandmarks?.[i]) >= PALM_FACING ? 2 : 0) + (name === 'Open_Palm' ? 0 : 1) + score;
      if (rank > poseRank) {
        poseRank = rank;
        poseIndex = i;
      }
    }
    if (standby && score >= settings.minGestureScore && score > resumeScore && resumesStandby(settings, 'pose', name)) {
      resumeScore = score;
      resumeIndex = i;
    }
  }
  if (bestIndex < 0) return null;
  // Whatever the most confident hand is doing: a hand in a lap read surely as
  // ✋ or ✊ mustn't hide the ✌️ being held up to the camera.
  if (poseIndex >= 0) bestIndex = poseIndex;
  // Paused, a pose that resumes Jester is the only one that can do anything,
  // so no other hand in view may hide it, however sure the model is of that one.
  if (resumeIndex >= 0) bestIndex = resumeIndex;

  const landmarks = result.landmarks[bestIndex];
  if (!landmarks) return null;
  const top = result.gestures[bestIndex]?.[0] || null;

  return {
    gesture: top?.categoryName || 'None',
    score: top?.score ?? 0,
    palm: palmCentre(landmarks, W, H),
    size: palmPixels(landmarks, W, H),
    landmarks
  };
}

/**
 * The middle of a hand's palm in pixels, x mirrored so "moved to the user's
 * right" means "increasing x", matching the selfie-view preview.
 */
function palmCentre(landmarks, W, H) {
  let x = 0;
  let y = 0;
  for (const index of PALM_LANDMARKS) {
    x += landmarks[index].x;
    y += landmarks[index].y;
  }
  return { x: (1 - x / PALM_LANDMARKS.length) * W, y: (y / PALM_LANDMARKS.length) * H };
}

// ---------------------------------------------------------------------------
// Gesture state machine
// ---------------------------------------------------------------------------

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * The frame a path is measured against: a 4:3 frame in which this hand's palm
 * is `REFERENCE_PALM` of the width — the picture the settings' distances and
 * speeds were tuned on, wherever the hand actually is. So a swipe is the same
 * movement of the arm at the desk and from the sofa.
 */
function referenceFrame(samples, W) {
  const palm = median(samples.map((p) => p.palm).filter((v) => v > 0));
  const w = clamp((palm > 0 ? palm : REFERENCE_PALM * W) / REFERENCE_PALM, REFERENCE_FRAME_BOUNDS[0] * W, REFERENCE_FRAME_BOUNDS[1] * W);
  return { w, h: w * 0.75 };
}

function speedOverWindow(now, W) {
  const window = rec.trail.filter((p) => now - p.t <= SPEED_WINDOW_MS);
  if (window.length < 2) return 0;
  const a = window[0];
  const b = window[window.length - 1];
  const dt = (b.t - a.t) / 1000;
  if (dt <= 0) return 0;
  const frame = referenceFrame(window, W);
  return Math.hypot((b.x - a.x) / frame.w, (b.y - a.y) / frame.h) / dt;
}

/** More of a swipe than this, in a single step between two frames, is a leap and not a swipe. */
const SWIPE_LEAP_SHARE = 0.85;

function detectSwipe(now, W) {
  // Nothing from before the last action's cooldown ended: the hand coming back
  // from one swipe must not read as the opposite swipe the moment it can.
  const since = Math.max(now - settings.swipeMaxDurationMs, rec.lastActionAt + settings.cooldownMs);
  const window = rec.trail.filter((p) => p.t >= since);
  if (window.length < 4) return null;

  const a = window[0];
  const b = window[window.length - 1];
  if (b.t - a.t < 80) return null;

  const frame = referenceFrame(window, W);
  const dx = (b.x - a.x) / frame.w;
  const dy = (b.y - a.y) / frame.h;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  // A swipe is a movement, made over several frames — not one leap, which is a
  // hand lost and another found where the trail can't tell them apart.
  let leap = 0;
  for (let i = 1; i < window.length; i += 1) {
    leap = Math.max(leap, Math.hypot((window[i].x - window[i - 1].x) / frame.w, (window[i].y - window[i - 1].y) / frame.h));
  }
  if (leap > SWIPE_LEAP_SHARE * Math.hypot(dx, dy)) return null;

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
  const message = { type: MSG.TRIGGER, action, source, gesture, context: viewContext };
  // The one action carried out here, and on the spot: which gestures count at
  // all depends on it from the very next frame, and a round trip through the
  // worker would read that frame the old way. The worker is told which way it
  // went, for the toast and the history.
  if (action === 'SLEEP') {
    setStandby(!standby);
    message.sleeping = standby;
    message.hint = resumeGlyphs(settings);
  }
  post(message);
}

const NO_BINDING = { action: 'NONE', repeat: false };
const RESUME_BINDING = { action: 'SLEEP', repeat: false };

/**
 * What a pose does right now. In standby, nothing — unless it resumes Jester,
 * which it does whichever binding set it was bound to that in.
 */
function poseBinding(name) {
  if (standby) return resumesStandby(settings, 'pose', name) ? RESUME_BINDING : NO_BINDING;
  return bindingsFor(settings, viewContext)[name] || NO_BINDING;
}

/** @see poseBinding */
function swipeAction(direction) {
  if (standby) return resumesStandby(settings, 'swipe', direction) ? 'SLEEP' : 'NONE';
  return swipeBindingsFor(settings, viewContext)[direction];
}

/**
 * Pause or resume.
 *
 * The hold machine is left exactly as it is: the pose that did this is still
 * held and already counted as fired, so it has to be let go of before it can
 * do anything again — or holding ✌️ would flick Jester off and on.
 */
function setStandby(on) {
  if (on === standby) return;
  standby = on;
  if (on) { endPointer(); voice.stop(); }
  // The pointer is usable again: have its tracker ready before the next palm.
  else if (running && pointerUsable()) ensureFaceLandmarker();
  if (running) reportRunning();
}

// ---------------------------------------------------------------------------
// The click hand — an open palm, closing into a fist
//
// Not a model gesture: measured straight off the 3D landmarks, as a ratio, so
// the same numbers work whether your hand is 30cm or 3m from the lens and
// whichever way it is turned.
// ---------------------------------------------------------------------------

const dist3d = (world, a, b) =>
  Math.hypot(world[a].x - world[b].x, world[a].y - world[b].y, world[a].z - world[b].z);

/**
 * How far a fingertip reaches from the wrist, relative to its knuckle, in 3D.
 *
 * 3D because a finger pointed at the lens foreshortens to almost nothing in
 * the image and would read as folded; off MediaPipe's metric world landmarks,
 * its length is its length whichever way it is turned.
 */
function reach3d(world, mcp, tip) {
  const base = dist3d(world, 0, mcp);
  if (base < 1e-6) return 1;
  return dist3d(world, 0, tip) / base;
}

/**
 * How squarely the palm faces the camera: 1 held up flat to it (palm or back,
 * either way), 0 edge-on. Off the 3D landmarks, so hand size and distance don't
 * enter into it. What it is for: a hand lying flat on a desk or an armrest is
 * open and still — everything that raises the cursor — but it lies edge-on to
 * a camera at eye height, where a palm raised to it doesn't.
 */
function palmFacing(world) {
  if (!world || world.length < 21) return 0;
  const a = [world[5].x - world[0].x, world[5].y - world[0].y, world[5].z - world[0].z];
  const b = [world[17].x - world[0].x, world[17].y - world[0].y, world[17].z - world[0].z];
  const n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const length = Math.hypot(n[0], n[1], n[2]);
  return length > 1e-9 ? Math.abs(n[2]) / length : 0;
}

/** How straight one finger is: 0 folded away, 1 straight out. */
function fingerOut(world, [mcp, tip]) {
  return clamp((reach3d(world, mcp, tip) - REACH_FIST) / (REACH_FLAT - REACH_FIST), 0, 1);
}

/** 0 = fist, 1 = flat palm. Averaged over the four fingers, in 3D. */
function handOpenness(world) {
  if (!world || world.length < 21) return null;
  let total = 0;
  for (const finger of FINGERS) total += fingerOut(world, finger);
  return total / FINGERS.length;
}

/**
 * How far the thumb tip stands from the folded fingers — from the middle
 * finger's second knuckle — in palm lengths. Tucked into a fist it rests
 * against them; in a thumbs-up it stands well clear.
 */
function thumbOut(world) {
  const palm = dist3d(world, 0, 9);
  return palm > 1e-6 ? dist3d(world, 4, 10) / palm : 0;
}

/**
 * The pose the click hand is making, if it is one the cursor should give way
 * to — or null. The folded ones must also measure as what they are named.
 */
function namedPose(hand) {
  if (!OTHER_POSES.has(hand.gesture) || hand.score < settings.minGestureScore) return null;
  switch (hand.gesture) {
    case 'Thumb_Up':
    case 'Thumb_Down':
      return thumbOut(hand.world) >= THUMB_OUT ? hand.gesture : null;
    case 'Pointing_Up':
      return fingerOut(hand.world, FINGERS[0]) >= INDEX_OUT ? hand.gesture : null;
    default:
      return hand.gesture;
  }
}

/** Whether a pose does anything here: one bound to nothing is no reason to drop the cursor. */
function poseBound(pose) {
  const { action } = poseBinding(pose);
  return !!action && action !== 'NONE';
}

/**
 * A hand doesn't travel this many of its own palm lengths between two camera
 * frames, even mid-swipe: one that far from where the tracked one was is
 * another hand. Measured in palms, not frame widths, because a person's two
 * hands are five or six palms apart at the desk but under a tenth of the
 * frame apart from the sofa — where a fixed share of the frame took both for
 * one, and the gap between them for a swipe.
 */
const HAND_STEP_PALMS = 3;
/**
 * Tighter for the click hand, which is held still while it holds a cursor:
 * from the sofa a person's other hand can be under three palms away (palms as
 * `palmPixels()` measures them, a little over a palm's length), and a frame of
 * this one dropping out mustn't hand the click to it.
 */
const CLICK_STEP_PALMS = 2;
/** How much of the click hand's recent path is kept, to say how fast it's moving. */
const HAND_TRAIL_MS = 200;
/**
 * A fist counts once it has held for this many camera frames: one frame of a
 * hand blurring or curling on its way out of view is not a decision.
 */
const FIST_FRAMES = 2;

/**
 * The hand the click belongs to. `wrist` is where it was last seen; null while
 * no hand has opened.
 */
const clickHand = {
  armed: false,
  wrist: null,
  side: null,
  /** Its palm's length in pixels when last seen: the yardstick it is followed by. */
  palm: 0,
  /** When the followed hand went missing; it is looked for where it was until POINTER_RELEASE_MS later. */
  lostAt: 0,
  /** `{ t, x, y, palm }` in pixels, for its speed in hand sizes. */
  trail: [],
  fistFrames: 0,
  lastOpenAt: 0,
  /** The named pose it is making (see `namedPose()`), since when, and how open it has been since. */
  pose: null,
  poseSince: 0,
  posePeak: 0,
  /** The folded pose every frame of the current fist has been, or null for a plain fist. */
  fistPose: null
};
const NO_HAND = {
  state: null,
  fired: false,
  armed: false,
  openness: 0,
  facing: 0,
  speed: 0,
  closeMs: 0,
  lastOpenAt: 0,
  pose: null,
  poseMs: 0,
  foldedFist: null,
  wrist: null,
  landmarks: null,
  followed: false
};
/** The last reading, repeated on ticks that run between camera frames. */
let lastClick = NO_HAND;

function forgetClickHand() {
  clickHand.armed = false;
  clickHand.wrist = null;
  clickHand.side = null;
  clickHand.palm = 0;
  clickHand.lostAt = 0;
  clickHand.trail.length = 0;
  clickHand.fistFrames = 0;
  clickHand.lastOpenAt = 0;
  clickHand.pose = null;
  clickHand.poseSince = 0;
  clickHand.posePeak = 0;
  clickHand.fistPose = null;
  lastClick = NO_HAND;
}

/** How fast the click hand is moving, in reference frames a second — the units of `maxHoldSpeed`. */
function clickHandSpeed(W) {
  const trail = clickHand.trail;
  if (trail.length < 2) return 0;
  const a = trail[0];
  const b = trail[trail.length - 1];
  const dt = (b.t - a.t) / 1000;
  if (!(dt > 0)) return 0;
  const frame = referenceFrame(trail, W);
  return Math.hypot((b.x - a.x) / frame.w, (b.y - a.y) / frame.h) / dt;
}

/** Open, and held up to the camera: the shape that raises the cursor. */
const raisedOpen = (candidate) => candidate.openness >= PALM_OPEN && candidate.hand.facing >= PALM_FACING;

/**
 * The click hand's state, and whether it just closed.
 *
 * Until a hand opens, the best candidate in view is the one raised open to the
 * camera, else the most open — with two in frame, the one making the gesture
 * should win, and a hand lying open on an armrest must not beat one held up.
 * Once a raised hand opens it is *the* hand: followed frame to frame by where
 * its wrist is (its side breaking ties), and only its fist counts. Otherwise a
 * second hand resting open on the desk would hold the reading open forever,
 * and one holding a mug would be mistaken for a fist.
 *
 * Called once per camera frame: the fist has to hold for `FIST_FRAMES` of
 * them, and a tick that re-reads the same frame must not count twice.
 */
function readClickHand(now, hands) {
  const W = videoEl.videoWidth || 1;
  const H = videoEl.videoHeight || 1;
  const readable = [];
  for (const hand of hands) {
    const openness = handOpenness(hand.world);
    if (openness !== null) readable.push({ hand, openness });
  }

  let chosen = null;
  if (clickHand.wrist) {
    // In its own palm lengths, a palm more for the other side: from the sofa
    // the other hand is only a tenth of the frame away.
    const palm = Math.max(clickHand.palm, 1);
    let best = Infinity;
    for (const candidate of readable) {
      const wrist = candidate.hand.landmarks[0];
      const distance =
        Math.hypot((wrist.x - clickHand.wrist.x) * W, (wrist.y - clickHand.wrist.y) * H) / palm +
        (candidate.hand.side === clickHand.side ? 0 : 1);
      if (distance < best) {
        best = distance;
        chosen = candidate;
      }
    }
    if (best > CLICK_STEP_PALMS) chosen = null;
    // The followed hand has been lowered — no longer raised open — while
    // another is raised open to the camera, and nothing is using the cursor:
    // the other hand is the one asking for it now.
    if (chosen && !ptr.active && !ptr.palmSince && !raisedOpen(chosen)) {
      const other = readable.find((c) => c !== chosen && raisedOpen(c));
      if (other) {
        forgetClickHand();
        chosen = other;
      }
    }
  } else {
    const rank = (c) => (raisedOpen(c) ? 2 : 0) + c.openness;
    for (const candidate of readable) {
      if (!chosen || rank(candidate) > rank(chosen)) chosen = candidate;
    }
  }

  if (!chosen) {
    // Losing the hand disarms: a hand that vanishes open and returns closed did
    // not make the gesture, and must not be credited with it. But the hand
    // being *followed* is still looked for where it was, for as long as the
    // cursor waits for it — so a frame of dropout doesn't hand the cursor to
    // whichever other hand happens to be in view.
    if (clickHand.wrist) {
      clickHand.armed = false;
      clickHand.fistFrames = 0;
      clickHand.fistPose = null;
      if (!clickHand.lostAt) clickHand.lostAt = now;
      if (now - clickHand.lostAt <= POINTER_RELEASE_MS) {
        clickHand.trail.length = 0;
        lastClick = NO_HAND;
        return NO_HAND;
      }
    }
    forgetClickHand();
    return NO_HAND;
  }

  // Whether this reading is the hand already being followed, as opposed to a
  // candidate picked from whatever is in view.
  const followed = !!clickHand.wrist;
  clickHand.lostAt = 0;
  const { hand, openness } = chosen;
  const wrist = hand.landmarks[0];
  const last = clickHand.trail[clickHand.trail.length - 1];
  const at = { t: now, x: wrist.x * W, y: wrist.y * H, palm: palmPixels(hand.landmarks, W, H) };
  if (last && Math.hypot(at.x - last.x, at.y - last.y) > HAND_STEP_PALMS * Math.max(last.palm, at.palm, 1)) {
    clickHand.trail.length = 0;
  }
  clickHand.trail.push(at);
  while (clickHand.trail.length && now - clickHand.trail[0].t > HAND_TRAIL_MS) clickHand.trail.shift();

  const state = openness >= PALM_OPEN ? 'open' : openness <= FIST_CLOSED ? 'fist' : 'between';

  // A named pose, and how long it has held steady. A hand still closing —
  // openness slipping below the most open it has been since the pose appeared —
  // restarts the clock: a close passes through shapes the model will name on
  // its way.
  const pose = namedPose(hand);
  if (pose !== clickHand.pose || (pose && openness < clickHand.posePeak - POSE_SLIP)) {
    clickHand.poseSince = pose ? now : 0;
    clickHand.posePeak = openness;
  } else if (pose) {
    clickHand.posePeak = Math.max(clickHand.posePeak, openness);
  }
  clickHand.pose = pose;

  let fired = false;
  let closeMs = 0;
  let foldedFist = null;
  if (state === 'open') {
    // A hand starts being followed only once it is raised to the camera; one
    // already followed re-arms however it is turned.
    if (followed || hand.facing >= PALM_FACING) {
      clickHand.armed = true;
      clickHand.lastOpenAt = now;
    }
    clickHand.fistFrames = 0;
    clickHand.fistPose = null;
  } else if (state === 'fist') {
    // Whether this "fist" has really been 👍, 👎 or ☝️ on every frame of it.
    const folded = FOLDED_POSES.has(pose) ? pose : null;
    clickHand.fistPose = clickHand.fistFrames === 0 || clickHand.fistPose === folded ? folded : null;
    clickHand.fistFrames += 1;
    if (clickHand.armed && clickHand.fistFrames >= FIST_FRAMES) {
      fired = true;
      clickHand.armed = false;
      closeMs = now - clickHand.lastOpenAt;
      foldedFist = clickHand.fistPose;
    }
  } else {
    clickHand.fistFrames = 0;
    clickHand.fistPose = null;
  }
  // Follow it from the moment it opens, through the click, for as long as it
  // stays in view — so it can open again and click again.
  if (clickHand.armed || clickHand.wrist) {
    clickHand.wrist = { x: wrist.x, y: wrist.y };
    clickHand.side = hand.side;
    clickHand.palm = at.palm;
  }
  return {
    state,
    fired,
    openness,
    facing: hand.facing,
    armed: clickHand.armed,
    speed: clickHandSpeed(W),
    closeMs,
    lastOpenAt: clickHand.lastOpenAt,
    pose,
    poseMs: pose ? now - clickHand.poseSince : 0,
    foldedFist,
    wrist: { x: wrist.x, y: wrist.y },
    // Which of this frame's hands it is. `readHand()` reads the same result,
    // so the two can be told apart exactly rather than by where they are.
    landmarks: hand.landmarks,
    followed
  };
}

// ---------------------------------------------------------------------------
// The face — the eyes for the gaze model, the head for the head pointer
// ---------------------------------------------------------------------------

/**
 * An eye narrower than this in the camera's picture, corner to corner, is a
 * few pixels of iris: its reading is noise, and the pointer aims with the head
 * instead. About a metre and a half from a 1080p laptop camera — though with
 * the zoom on, the face is read from a crop, and the eyes go unused, from
 * about a metre (zoom.js's `FACE_CROP_SPANS`).
 */
const EYES_MIN_PX = 22;

/** Whether the screen in front is one the calibration wasn't made for. */
function otherScreen() {
  return !!pageScreen && !!gazeModel && (pageScreen.w !== gazeModel.screenW || pageScreen.h !== gazeModel.screenH);
}

/**
 * Whether the eyes, as last read, can aim: the gaze model applies here; the
 * eyes are big enough in the picture; they were read from the whole frame —
 * a zoomed-in face's head pose is measured against a different picture than
 * calibration's, and isn't comparable with it — and the head is no nearer or
 * farther than calibration saw it.
 */
function eyesReadable(now) {
  if (!gazeModel || otherScreen()) return false;
  const last = gaze.last;
  if (!last?.features || now - last.at > GAZE_STALE_MS || last.cropped) return false;
  if (!(last.eyeWidth >= EYES_MIN_PX)) return false;
  return poseDrift(gazeModel.pose, last.pose) !== 'distance';
}

/**
 * How a cursor raised now would aim: 'hybrid' (put where the eyes look, then
 * steered by the head), 'eyes' alone, or 'head' alone — or null if it can't
 * be raised at all (`pointerBlocker()` says why).
 *
 * 'auto' is the eyes and head together wherever the eyes can be read, and the
 * head alone where they can't: across a room, on a screen the calibration
 * wasn't made for, or with a calibration from an older version of Jester.
 */
function aimMode(now) {
  const aim = settings.pointerAim || 'auto';
  if (aim === 'head') return 'head';
  if (aim === 'eyes') return gazeModel && !otherScreen() ? 'eyes' : null;
  if (!calibration) return null;
  return eyesReadable(now) ? 'hybrid' : 'head';
}

/** Why a cursor is aimed with the head rather than the eyes, for the popup. */
function headReason() {
  if ((settings.pointerAim || 'auto') === 'head') return 'setting';
  if (!gazeModel) return 'stale';
  if (otherScreen()) return 'screen';
  // Eyes big enough to read, from the whole frame, but the head is nearer or
  // farther than calibration saw it: "too far" would send someone who leaned
  // in closer still.
  const last = gaze.last;
  if (last?.features && !last.cropped && last.eyeWidth >= EYES_MIN_PX && poseDrift(gazeModel.pose, last.pose) === 'distance') {
    return 'distance';
  }
  return 'far';
}

/** The screen a cursor aimed this way is placed on, px — or null if there's none to place it on. */
function screenFor(mode) {
  if (mode !== 'head') return gazeModel ? { w: gazeModel.screenW, h: gazeModel.screenH } : null;
  if (pageScreen) return { w: pageScreen.w, h: pageScreen.h };
  if (calibration?.screenW > 0 && calibration?.screenH > 0) return { w: calibration.screenW, h: calibration.screenH };
  return null;
}

/**
 * Why an open palm can't raise the cursor right now, or null if it can. Any
 * answer but null hands ✋ back to its pose binding.
 *
 * Aiming with the head needs no calibration. Aiming with the eyes, or 'auto',
 * does: calibrating is also how someone says they want ✋ to raise a cursor
 * rather than press Play, and 'auto' shouldn't take ✋ from anyone who never
 * asked.
 */
function pointerBlocker() {
  // Paused: no cursor, and ✋ is just a pose — one that does nothing, unless
  // it is what resumes Jester.
  if (standby) return 'standby';
  if (!settings.pointerEnabled || settings.pointerInput === 'voice') return 'disabled';
  if (landmarkerState === 'failed') return 'tracker-failed';
  const aim = settings.pointerAim || 'auto';
  if (aim === 'eyes') {
    if (!calibration) return 'uncalibrated';
    // A calibration from another camera, or an older way of reading the eyes.
    if (!gazeModel) return 'stale';
    // Made for a screen of another size than the one in front: the page
    // couldn't place a cursor, so ✋ stays its pose rather than raise one.
    if (otherScreen()) return 'screen';
  } else if (aim === 'auto' && !calibration) {
    return 'uncalibrated';
  }
  if (!screenFor(aim === 'eyes' ? 'eyes' : 'head')) return 'no-screen';
  return null;
}

const pointerUsable = () => pointerBlocker() === null;

/**
 * Face tracking costs about as much again as hand tracking, so it runs only
 * when something is going to use it: calibration; a raised open palm, or a
 * cursor already up; the zoom — every few frames to follow the person, every
 * frame while it searches for them; or, at a third of the rate, a preview
 * someone is watching of a pointer that can be used.
 */
function faceWanted(now, click) {
  if (now < calibrationUntil) return true;
  const usable = pointerUsable();
  if (usable) {
    // A tracker that just loaded spends its slow first frame now, not in the
    // middle of the next palm going up.
    if (faceLandmarker && !trackerWarm) return true;
    // A raised open palm, still or not: by the time one has been held still
    // long enough to raise the cursor, the face has already been read for a while.
    if (ptr.active || ptr.palmSince || (click.state === 'open' && click.facing >= PALM_FACING)) return true;
  }
  if (settings.longRange) return crops.searching || frameCount % FACE_FOLLOW_EVERY === 0;
  return usable && now <= previewWantedUntil && frameCount % GAZE_PREVIEW_EVERY === 0;
}

/**
 * Blinks, at runtime.
 *
 * A lid only a quarter closed already moves the reading a long way, so the
 * threshold is tighter than a blink detector's would be, and the frames after
 * the blink — the lid still travelling — are held too. The baseline is the
 * 90th percentile of the last ten seconds rather than the median, because
 * looking at the bottom of the screen lowers the lids on its own, and the
 * baseline shouldn't sink with it. Worked out every few readings, not every
 * frame.
 */
const EAR_WINDOW_MS = 10000;
const BLINK_RATIO = 0.7;
const BLINK_TAIL_FRAMES = 2;
const EAR_REFRESH = 8;
let earBaselineValue = 0;
let earSinceRefresh = EAR_REFRESH;

function earBaseline(now) {
  earSinceRefresh += 1;
  if (earSinceRefresh >= EAR_REFRESH) {
    earSinceRefresh = 0;
    gaze.ear = gaze.ear.filter((e) => now - e.at <= EAR_WINDOW_MS);
    if (gaze.ear.length < 5) {
      earBaselineValue = 0;
    } else {
      const sorted = gaze.ear.map((e) => e.value).sort((a, b) => a - b);
      earBaselineValue = sorted[Math.floor(sorted.length * 0.9)];
    }
  }
  return earBaselineValue;
}

/** Whether this frame's reading should be held back: a blink, or the tail of one. */
function blinkHold(now, ear) {
  const baseline = earBaseline(now);
  gaze.ear.push({ at: now, value: ear });
  if (baseline > 0 && ear < baseline * BLINK_RATIO) {
    gaze.blinkTail = BLINK_TAIL_FRAMES;
    return true;
  }
  if (gaze.blinkTail > 0) {
    gaze.blinkTail -= 1;
    return true;
  }
  return false;
}

/**
 * A hand across the eyes. The face tracker still finds the whole face behind
 * it — so nothing else notices — but the eyes it reports are guesses, and the
 * head's pose bends with them.
 */
function handOverEyes(hands, boxes, width, height) {
  for (const hand of hands) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const lm of hand.landmarks) {
      x0 = Math.min(x0, lm.x * width);
      y0 = Math.min(y0, lm.y * height);
      x1 = Math.max(x1, lm.x * width);
      y1 = Math.max(y1, lm.y * height);
    }
    // A little wider than the landmarks, which run down the middle of each
    // finger rather than along its edges.
    const padX = (x1 - x0) * 0.15;
    const padY = (y1 - y0) * 0.15;
    x0 -= padX;
    y0 -= padY;
    x1 += padX;
    y1 += padY;
    for (const eye of [boxes.left, boxes.right]) {
      if (x0 < eye.x + eye.w && x1 > eye.x && y0 < eye.y + eye.h && y1 > eye.y) return true;
    }
  }
  return false;
}

/**
 * Consecutive frames on which reading the face threw *after* it was found —
 * the measurements, the model. A few is a bad frame; this many is something
 * that isn't going to work, and the face tracker stands down rather than keep
 * failing twenty times a second.
 */
const GAZE_FAILURE_LIMIT = 30;
let gazeFailures = 0;

function readFace(now, hands, W, H) {
  if (!faceLandmarker) {
    ensureFaceLandmarker();
    return;
  }
  // One detect per camera frame, ever: a tracker handed the same timestamp
  // twice breaks for good.
  if (lastTimestamp <= lastFaceTs) return;
  lastFaceTs = lastTimestamp;

  let result;
  try {
    result = faceLandmarker.detectForVideo(faceInput(crops.face), lastTimestamp);
  } catch (err) {
    trackerBroke(err);
    return;
  }
  trackerWarm = true;

  // Past the tracker, a throw is this frame's problem, and must not take the
  // engine down with it: tick() turns any throw into a stopped engine, and
  // gestures and swipes don't depend on the face at all.
  try {
    readFaceFrom(result, now, W, H, hands);
    gazeFailures = 0;
  } catch (err) {
    gazeFailures += 1;
    // The face was found; it's what came after that failed — not "no face",
    // which would send calibration's advice the wrong way.
    gaze.last = { at: now, seq: gaze.seq, face: true, error: true };
    if (gazeFailures === 1) console.warn('[jester] reading the face failed', err);
    if (gazeFailures >= GAZE_FAILURE_LIMIT) {
      // Closed as well as marked, so that a fresh start (a restart, or the
      // calibration screen opening) loads a new one rather than finding this
      // one still there and never saying it is ready again.
      try {
        faceLandmarker?.close?.();
      } catch {
        /* it is being given up on either way */
      }
      faceLandmarker = null;
      trackerWarm = false;
      gazeFailures = 0;
      landmarkerState = 'failed';
      landmarkerError = String(err?.message || err);
    }
  }
}

function readFaceFrom(result, now, W, H, hands) {
  gaze.seq += 1;
  const found = result?.faceLandmarks?.[0];
  if (!found) {
    gaze.last = { at: now, seq: gaze.seq, face: false };
    return;
  }
  const points = crops.face ? landmarksFromCrop([found], crops.face, W, H)[0] : found;
  facePointsNow = points;
  const cropped = !!crops.face;
  const head = headPose(result.facialTransformationMatrixes?.[0]?.data);

  const eyes = readEyes(points, {
    blendshapes: result.faceBlendshapes?.[0],
    matrix: result.facialTransformationMatrixes?.[0],
    width: W,
    height: H
  });
  if (!eyes) {
    gaze.last = { at: now, seq: gaze.seq, face: true, cropped };
    // The eyes can't be read, but the head still points somewhere.
    if (head) gaze.head = { pose: head, at: now };
    return;
  }

  const occluded = handOverEyes(hands, eyes.boxes, W, H);
  const blink = !occluded && blinkHold(now, eyes.openness);
  // The reading first, then this engine's own calls on it: they must win.
  gaze.last = { ...eyes, at: now, seq: gaze.seq, face: true, occluded, blink, cropped };
  // A hand across the face bends its landmarks, and the head's pose with them:
  // the cursor holds still rather than follow that.
  if (!occluded && head) gaze.head = { pose: head, at: now };

  // A closed lid, a hand, a zoomed-in face: hold the last answer instead.
  if (!gazeModel || occluded || blink || cropped) return;
  const point = gazeModel.predict(eyes.features);
  if (!point) return;
  gaze.point = { x: point.x + ptr.sessionBias[0], y: point.y + ptr.sessionBias[1], at: now };
  // While a palm is arming, keep what the eyes said: the cursor starts from
  // their median rather than from whichever single reading came last.
  if (ptr.palmSince && !ptr.active) {
    ptr.armReadings.push({ x: gaze.point.x, y: gaze.point.y, pose: eyes.pose });
    if (ptr.armReadings.length > 40) ptr.armReadings.shift();
  }
}

/** The latest prediction (screen pixels), or null once it's too old to stand for where you're looking. */
function freshGaze(now) {
  return gaze.point && now - gaze.point.at <= GAZE_STALE_MS ? gaze.point : null;
}

/** The latest head pose, or null once it's too old to steer by. */
function freshHead(now) {
  return gaze.head && now - gaze.head.at <= GAZE_STALE_MS ? gaze.head : null;
}

function setCalibration(model) {
  calibration = model || null;
  refreshGazeModel();
}

/**
 * Build the predictor for the stored calibration — if it applies to the camera
 * that is actually open. A calibration made through another camera describes
 * a face seen from somewhere else; rather than put a cursor somewhere
 * unrelated to where you look, the eyes stand down (the head can still aim, on
 * 'auto') until you recalibrate. Re-checked whenever the camera or the
 * calibration changes.
 */
function refreshGazeModel() {
  const usable = usableModel(calibration, { cameraId: liveCameraId });
  if (usable !== !!gazeModel || gazeModelFor !== calibration) {
    gazeModel = usable ? new GazeModel(calibration) : null;
    gazeNoise = gazeModel
      ? makeNoiseTracker({ noisePx: gazeModel.noisePx, noiseRho: gazeModel.noiseRho, screenW: gazeModel.screenW })
      : null;
    gazeModelFor = calibration;
    gaze.point = null;
    // What clicking taught about the last calibration says nothing about this one.
    ptr.sessionBias = [0, 0];
    // A fresh calibration replaces the mapping under a live cursor, which would
    // otherwise jump. Drop it and let the user raise it again.
    endPointer();
  }
  // Someone who has calibrated will raise a palm sooner or later, and the
  // tracker's load and slow first frame are better spent now than then.
  if (running && (pointerUsable() || settings.longRange)) ensureFaceLandmarker();
}

// ---------------------------------------------------------------------------
// The pointer: an open palm raises it, the eyes and the head aim it, a fist clicks
// ---------------------------------------------------------------------------

/** How long the cursor must have been up before a close counts as aimed. */
const CLICK_AIM_MS = 300;
/** A close slower than this is a hand relaxing, not a click. */
const CLICK_CLOSE_MS = 600;
/** A fist held this long after a click is done with the cursor for now. */
const DOWN_HIDE_MS = 1000;
/** A reading farther than this share of the screen past its edge is looking away from it. */
const OFFSCREEN_MARGIN = 0.08;
/**
 * Eyes and head together: the eyes put the cursor roughly where you look, the
 * head does the rest. A new look moves the cursor only when it lands at least
 * this far from it — this many of the calibration's typical misses, and this
 * share of the screen — so a gaze still resting on the target can't undo the
 * head's fine adjustment, and the next button over is a nudge of the head.
 */
const REANCHOR_MISSES = 1.5;
const REANCHOR_MIN = 0.06;
/** After the eyes land somewhere new, the cursor settles onto their average this long — unless the head starts steering first. */
const SETTLE_MS = 450;
/**
 * After the cursor goes where the eyes went, the head's turning isn't
 * steering until the head has first come to rest (`HEAD_REST`): in a large look the head
 * follows the eyes a few degrees, over a third of a second or more, and taken
 * as steering that carried the cursor past the target by 60 px a degree. For
 * `HEAD_FOLLOW_MS` whatever it does; then for as long as it keeps turning, up
 * to `FOLLOW_MAX_MS`; and then a settle of `SETTLE_TAIL_MS` for the last
 * fraction of a degree, unless it starts turning again. A correction made on
 * purpose can't start before the user has seen where the cursor landed.
 */
const HEAD_FOLLOW_MS = 300;
const FOLLOW_MAX_MS = 1000;
const SETTLE_TAIL_MS = 250;
/** A head turning faster than this, radians a second, is steering, not drifting. */
const HEAD_STEER = 0.12;
const HEAD_TRAIL_MS = 150;
/** A head-steered cursor raised again this soon comes back where it was, rather than in the middle. */
const HEAD_RESUME_MS = 5000;
/** The session's learned offset: at most this share of the screen, and each click moves it this much of the way toward what it showed. */
const SESSION_BIAS_MAX = 0.15;
const SESSION_BIAS_RATE = 0.35;
/** How far around a head-steered cursor the page looks for the thing you meant, px: it is placed to within a few. */
const HEAD_AIM_PX = 44;
/**
 * A hand this far closed is clicking: the eyes no longer move the cursor. The
 * eyes often flick to the closing hand, and that look must not carry the cursor
 * off what it was on. The page freezes its aim at the same point.
 */
const CLOSING_FROM = 0.25;

/**
 * Turning slower than this, radians a second, the head is at rest: well clear
 * of a still head's jitter once filtered (a pixel or two of cursor), well
 * under any turn made to move the cursor somewhere.
 */
const HEAD_REST = 0.035;

/** How fast the head is turning over the last moment, radians a second (filtered angles). */
function headSpeed(now) {
  const trail = ptr.headTrail.filter((p) => now - p.t <= HEAD_TRAIL_MS);
  if (trail.length < 2) return 0;
  const a = trail[0];
  const b = trail[trail.length - 1];
  const dt = (b.t - a.t) / 1000;
  return dt > 0 ? Math.hypot(b.yaw - a.yaw, b.pitch - a.pitch) / dt : 0;
}

/** Whether the head is turning on purpose — over the last moment, faster than drift. */
const headSteering = (now) => headSpeed(now) > HEAD_STEER;

/** How far a new look must land from the cursor to move it there, px. */
function reanchorPx() {
  const miss = calibration?.errorPx > 0 ? calibration.errorPx : 0.1 * ptr.screen.w;
  return Math.max(REANCHOR_MISSES * miss, REANCHOR_MIN * ptr.screen.w);
}

/** How far around the cursor the page should look for the thing meant, px — or null for its own default. */
function aimRadius() {
  const miss = calibration?.errorPx > 0 ? calibration.errorPx : null;
  if (ptr.mode === 'eyes') return miss;
  if (ptr.mode === 'hybrid') return Math.max(HEAD_AIM_PX, 0.5 * (miss || 100));
  return HEAD_AIM_PX;
}

function startPointer(now, mode) {
  const screen = screenFor(mode);
  ptr.mode = mode;
  ptr.screen = screen;
  ptr.head = mode === 'eyes' ? null : makeHeadPointer({ screenW: screen.w, screenH: screen.h, speed: settings.headSpeed });
  ptr.headTrail = [];
  const head = freshHead(now);
  if (ptr.head && head) {
    ptr.head.update(head.pose, head.at);
    ptr.lastHeadAt = head.at;
  }

  let seed;
  if (mode === 'head') {
    // Raised again straight after, it comes back where it was: clicking the
    // same button twice shouldn't mean steering there twice.
    const last = ptr.lastCursor;
    seed =
      last && now - last.at <= HEAD_RESUME_MS && last.w === screen.w && last.h === screen.h
        ? { x: last.x, y: last.y }
        : { x: screen.w / 2, y: screen.h / 2 };
    ptr.filter = null;
    ptr.gazeAt = null;
    ptr.drift = null;
  } else {
    const readings = ptr.armReadings;
    seed = readings.length >= 3
      ? { x: median(readings.map((r) => r.x)), y: median(readings.map((r) => r.y)) }
      : { x: gaze.point.x, y: gaze.point.y };
    ptr.filter = makeGazeFilter({
      smoothing: settings.pointerSmoothing,
      noisePx: gazeModel.noisePx,
      noiseRho: gazeModel.noiseRho,
      screenW: gazeModel.screenW,
      // Readings arrive once per camera frame while the cursor is up.
      fps: Math.max(5, fps || settings.targetFps || 20),
      tracker: gazeNoise
    });
    ptr.filter.reset(seed.x, seed.y);
    ptr.gazeAt = { x: seed.x, y: seed.y };
    ptr.lastPointAt = gaze.point?.at ?? 0;
    // Where the head is now against where it was during calibration: the one
    // error no amount of filtering removes, and the one the user can fix.
    ptr.drift = poseDrift(gazeModel.pose, poseSummary(readings.map((r) => r.pose)));
  }
  if (ptr.head?.ready) ptr.head.anchorAt(seed.x, seed.y);
  ptr.settleUntil = mode === 'hybrid' ? now + SETTLE_MS : 0;
  ptr.anchoredAt = now;
  ptr.following = mode === 'hybrid';
  ptr.closedGaze = null;
  ptr.x = seed.x / screen.w;
  ptr.y = seed.y / screen.h;
  ptr.pastEdge = false;
  ptr.offscreen = false;
  // The picture the head is read from must not shift while it steers.
  zoom?.hold(true);

  ptr.active = true;
  ptr.shownAt = now;
  ptr.palmSince = 0;
  ptr.armReadings = [];
  ptr.lastHandAt = now;
  ptr.down = false;
  ptr.downSince = 0;
}

function endPointer() {
  if (!ptr.active && !ptr.palmSince && !ptr.armReadings.length) return;
  ptr.palmSince = 0;
  ptr.armReadings = [];
  if (!ptr.active) return;
  ptr.lastCursor = ptr.screen
    ? { x: ptr.x * ptr.screen.w, y: ptr.y * ptr.screen.h, w: ptr.screen.w, h: ptr.screen.h, at: performance.now() }
    : null;
  ptr.active = false;
  ptr.mode = null;
  ptr.down = false;
  ptr.hidden = false;
  ptr.filter = null;
  ptr.gazeAt = null;
  ptr.head = null;
  ptr.headTrail = [];
  ptr.drift = null;
  zoom?.hold(false);
  post({ type: MSG.CURSOR, cursor: { active: false } });
}

/** Said out loud in the popup's history, so a fist that "did nothing" has a reason. */
function refuseClick(detail) {
  post({ type: MSG.CURSOR_CLICK, ok: false, detail });
}

/**
 * A click in eyes-and-head mode is a look at a known point: the user steered
 * the cursor onto what they meant, and the eyes were reading somewhere near
 * it. The gap is the calibration's error, here and now — so the session's
 * offset moves a step toward it. A click far from where the eyes were isn't a
 * correction but a look somewhere else, and teaches nothing.
 */
function learnFromClick() {
  if (ptr.mode !== 'hybrid' || !ptr.gazeAt || !ptr.screen) return;
  const dx = ptr.x * ptr.screen.w - ptr.gazeAt.x;
  const dy = ptr.y * ptr.screen.h - ptr.gazeAt.y;
  if (Math.hypot(dx, dy) > reanchorPx()) return;
  const maxX = SESSION_BIAS_MAX * ptr.screen.w;
  const maxY = SESSION_BIAS_MAX * ptr.screen.h;
  ptr.sessionBias = [
    clamp(ptr.sessionBias[0] + SESSION_BIAS_RATE * dx, -maxX, maxX),
    clamp(ptr.sessionBias[1] + SESSION_BIAS_RATE * dy, -maxY, maxY)
  ];
}

/**
 * The click edge, the held state, and how close the hand is to clicking.
 *
 * A close only clicks if it looked like one: into a fist rather than a pose
 * that merely has its fingers folded (👍 👎 ☝️, thumb or finger measurably
 * out), quick (a hand relaxing is slow), with the hand still (a hand dropping
 * out of view curls as it goes), and after the cursor has been up long enough
 * for someone to have aimed it. One that fails those wasn't a click at all, so
 * it hands the hand back — and a fist raised and held can still press Pause,
 * a 👍 turn the volume up. (A folded pose bound to nothing just doesn't click.)
 * One that passes but can't land — the face lost, or looking off the screen —
 * is refused, with a reason, and the cursor stays.
 *
 * `progress` drives the ring around the cursor, the only feedback saying how
 * far the hand has left to close.
 */
function clickSignal(now, click, seeing, offscreen) {
  let fired = false;
  let release = false;
  let refused = null;
  // A folded pose bound to nothing: not a fist, and nothing to hand it to.
  const inert = !!click.foldedFist && !poseBound(click.foldedFist);
  if (click.fired && !inert) {
    const aimedFor = click.lastOpenAt - ptr.shownAt;
    if (
      click.foldedFist ||
      click.closeMs > CLICK_CLOSE_MS ||
      click.speed > 2 * settings.maxHoldSpeed ||
      aimedFor < CLICK_AIM_MS
    ) {
      release = true;
    } else {
      ptr.down = true;
      ptr.downSince = now;
      // Eyes alone need the eyes; anything steered by the head needs the face.
      if (!seeing) refused = ptr.mode === 'eyes' ? "Not clicked — couldn't see your eyes" : "Not clicked — couldn't see your face";
      else if (offscreen) refused = 'Not clicked — you were looking away from the screen';
      else fired = true;
      if (refused) refuseClick(refused);
      if (fired) learnFromClick();
    }
  }
  // Only a hand that opens again can click again, so a held fist is a state to
  // show, not a click to repeat — and only opening ends it: a frame of dropout
  // or a fist loosening a little is still the same held fist.
  if (click.state === 'open') {
    ptr.down = false;
    ptr.downSince = 0;
  }
  return { click: fired, release, refused, down: ptr.down, progress: closingProgress(click) };
}

/** How far an armed hand has closed: 0 wide open, 1 at the fist that clicks. */
function closingProgress(click) {
  // Full on the frame that clicks, too — the hand has stopped being armed by
  // then, and the page must not read a click frame as "not closing".
  if (click.fired) return 1;
  return click.armed ? clamp((PALM_OPEN - click.openness) / (PALM_OPEN - FIST_CLOSED), 0, 1) : 0;
}

/**
 * The cursor isn't up yet: is a palm going up?
 *
 * The palm has to be *held*, and held *still* — `pointerArmMs` of it. Still,
 * because swipes are made with an open hand too: a palm moving across the
 * frame is on its way somewhere, and arming on it would swallow every swipe
 * and then pop a cursor up at the end of it. Held, so a hand that opens on its
 * way past raises nothing. Detection flickers, so a frame or two of a
 * half-closed hand doesn't cancel the wait; a hand that stays closed, or
 * leaves, does.
 */
function armPointer(now, click) {
  const still = click.speed <= settings.maxHoldSpeed;
  const raised = click.facing >= PALM_FACING;
  if (click.state === 'open' && still && raised) {
    ptr.lastOpenAt = now;
    if (!ptr.palmSince) {
      ptr.palmSince = now;
      ptr.armReadings = [];
    }
  } else if (click.state === 'open') {
    // Open, but moving or lying flat: a swipe on its way, or a hand at rest.
    ptr.palmSince = 0;
  } else if (ptr.palmSince && now - ptr.lastOpenAt > POINTER_RELEASE_MS) {
    ptr.palmSince = 0;
  }
  if (!ptr.palmSince) {
    // Open and still but not held up to the camera: worth a word, since it
    // looks like everything the cursor asks for.
    return { active: false, arming: false, flat: click.state === 'open' && still && !raised, handState: click.state };
  }

  const armMs = Math.max(0, settings.pointerArmMs);
  const armProgress = clamp((now - ptr.palmSince) / Math.max(1, armMs), 0, 1);
  // Still open at the moment the cursor comes up, too: a hand that closed
  // during the wait would otherwise be credited with a palm it no longer shows.
  if (now - ptr.palmSince < armMs || click.state !== 'open') {
    return { active: false, arming: true, armProgress, handState: click.state };
  }

  // The palm is up but what aims the cursor can't be read. Keep the hand
  // anyway — poses stay off — rather than let the same palm sometimes raise a
  // cursor and sometimes press Play depending on whether the face was found.
  const mode = aimMode(now);
  const ready = mode === 'head' ? !!freshHead(now) : !!mode && !!freshGaze(now);
  if (!ready) {
    return { active: false, arming: true, armProgress: 1, waitingForFace: true, handState: click.state };
  }

  startPointer(now, mode);
  return drivePointer(now, click);
}

/** A swipe won: the open hand was going somewhere, not asking for the cursor. */
function cancelArming() {
  if (!ptr.active) {
    ptr.palmSince = 0;
    ptr.armReadings = [];
  }
}

/** Hybrid: put the cursor where the eyes are, and let it settle there. */
function anchorOnEyes(now, at) {
  ptr.head.anchorAt(at.x, at.y);
  ptr.settleUntil = now + SETTLE_MS;
  ptr.anchoredAt = now;
  ptr.following = true;
}

/** The cursor is up: follow the eyes and the head, click on the fist, go when the hand does. */
function drivePointer(now, click) {
  // Only the hand that raised the cursor keeps it up; another hand merely in
  // view does not, or a fist resting on a chin would hold it forever.
  if (click.followed && click.state !== null) ptr.lastHandAt = now;
  else if (now - ptr.lastHandAt > POINTER_RELEASE_MS) {
    endPointer();
    return { active: false, arming: false, handState: null };
  }
  // The hand that holds the cursor has made a pose of its own — ✌️, 👍, 🤟 —
  // and held it: the user wants the pose, so the cursor stands down and the
  // pose recogniser gets the hand back.
  if (click.pose && click.poseMs >= POSE_TAKEOVER_MS && poseBound(click.pose)) {
    endPointer();
    return { active: false, arming: false, handState: click.state };
  }

  const W = ptr.screen.w;
  const H = ptr.screen.h;

  // The head: each reading through its filter once.
  const head = ptr.head ? freshHead(now) : null;
  if (head && head.at !== ptr.lastHeadAt) {
    ptr.head.update(head.pose, head.at);
    ptr.lastHeadAt = head.at;
    const angles = ptr.head.angles;
    ptr.headTrail.push({ t: now, yaw: angles.yaw, pitch: angles.pitch });
    while (ptr.headTrail.length && now - ptr.headTrail[0].t > HEAD_TRAIL_MS) ptr.headTrail.shift();
  }

  // The eyes: each reading through the fixation filter once — it counts
  // readings, and a tick between camera frames must not count one twice.
  //
  // While the hand closes, and while the fist that clicked is held, they move
  // nothing and decide nothing: they flick to the closing hand, and that look
  // mustn't carry the cursor off what it was on, nor refuse the click as a
  // look away from the screen. The page freezes its aim at the same point.
  const closing = closingProgress(click) >= CLOSING_FROM || ptr.down;
  const point = ptr.filter ? freshGaze(now) : null;
  if (point && point.at !== ptr.lastPointAt) {
    const smoothed = ptr.filter.next(point.x, point.y);
    ptr.lastPointAt = point.at;
    // Judged on the readings, not the smoothed cursor — a glance at the
    // keyboard is over before the filter would follow it off the edge — but on
    // two in a row: one stray reading past the edge is noise, and near the
    // top or bottom of the screen (where the player's controls are) one would
    // otherwise fade the cursor, drop its aim, and refuse a click.
    const past =
      point.x < -OFFSCREEN_MARGIN * W ||
      point.x > (1 + OFFSCREEN_MARGIN) * W ||
      point.y < -OFFSCREEN_MARGIN * H ||
      point.y > (1 + OFFSCREEN_MARGIN) * H;
    if (closing) {
      if (ptr.mode === 'hybrid' && !ptr.closedGaze && ptr.gazeAt) ptr.closedGaze = { ...ptr.gazeAt };
    } else {
      ptr.gazeAt = { x: smoothed.x, y: smoothed.y };
      ptr.offscreen = past && ptr.pastEdge;
      ptr.pastEdge = past;
    }

    if (ptr.mode === 'hybrid' && ptr.head?.ready && !closing) {
      if (!ptr.head.anchored) {
        // The head arrived after the eyes: start steering from where they are.
        anchorOnEyes(now, smoothed);
      } else if (ptr.closedGaze) {
        // The hand has opened again. A look made while it was closing counts
        // now — but against where the eyes were when it began to close, not
        // against the cursor the head may have nudged off their reading: a
        // glance at the hand and back changes nothing.
        if (!past) {
          if (Math.hypot(smoothed.x - ptr.closedGaze.x, smoothed.y - ptr.closedGaze.y) > reanchorPx()) {
            anchorOnEyes(now, smoothed);
          }
          ptr.closedGaze = null;
        }
      } else {
        const at = ptr.head.position(0);
        if (smoothed.jumped && Math.hypot(smoothed.x - at.x, smoothed.y - at.y) > reanchorPx()) {
          // The eyes went somewhere new, well away from the cursor: it goes there.
          anchorOnEyes(now, smoothed);
        } else if (ptr.following) {
          // Just landed, and the head is still following the eyes there: the
          // cursor stays with the eyes until the head first comes to rest.
          const since = now - ptr.anchoredAt;
          if (since >= HEAD_FOLLOW_MS && !(headSpeed(now) > HEAD_REST && since < FOLLOW_MAX_MS)) {
            ptr.following = false;
            ptr.settleUntil = Math.max(ptr.settleUntil, now + SETTLE_TAIL_MS);
          }
          ptr.head.anchorAt(smoothed.x, smoothed.y);
        } else if (now < ptr.settleUntil && !headSteering(now)) {
          // The eyes' average is still settling, and the cursor settles with
          // it — until the head starts steering.
          ptr.head.anchorAt(smoothed.x, smoothed.y);
        }
      }
    }
  }

  if (ptr.head?.anchored && ptr.mode !== 'eyes') {
    const p = ptr.head.position(0);
    ptr.x = p.x / W;
    ptr.y = p.y / H;
  } else if (ptr.gazeAt) {
    ptr.x = ptr.gazeAt.x / W;
    ptr.y = ptr.gazeAt.y / H;
  }

  const gazeNow = ptr.filter ? freshGaze(now) : null;
  const headNow = ptr.head ? freshHead(now) : null;
  // What it takes to place a click: the head for a head-steered cursor, the
  // eyes for an eye-aimed one, either for both.
  const seeing = ptr.mode === 'head' ? !!headNow : ptr.mode === 'hybrid' ? !!(headNow || gazeNow) : !!gazeNow;
  const offscreen = ptr.mode !== 'head' && !!gazeNow && ptr.offscreen;

  const signal = clickSignal(now, click, seeing, offscreen);
  if (signal.release) {
    endPointer();
    return { active: false, arming: false, handState: click.state };
  }
  // A fist held on after its click is done with the cursor for now: hide it,
  // rather than leave it hovering over the page firing mouse moves. When it
  // comes back, the aim clock starts again: a click needs the cursor to have
  // been *seen* for a moment, not merely to have existed.
  const hidden = ptr.down && now - ptr.downSince > DOWN_HIDE_MS;
  if (ptr.hidden && !hidden) ptr.shownAt = now;
  ptr.hidden = hidden;
  // The calibration's record of where its screen sits, if this is that screen.
  const sameScreen = calibration && calibration.screenW === W && calibration.screenH === H;
  post({
    type: MSG.CURSOR,
    cursor: {
      active: true,
      // Fractions of the screen the cursor is placed on — not clamped: the
      // page decides what looking past its edge means.
      x: ptr.x,
      y: ptr.y,
      progress: signal.progress,
      down: signal.down,
      click: signal.click,
      // Said on the page too, where the user is looking — the popup is shut —
      // unless toasts are switched off.
      refused: signal.refused,
      notices: !!settings.showToasts,
      hidden,
      offscreen,
      mode: ptr.mode,
      // How far around the cursor to look for the thing you meant.
      errorPx: aimRadius(),
      display: {
        w: W,
        h: H,
        insetX: sameScreen ? calibration.display?.insetX ?? null : null,
        insetY: sameScreen ? calibration.display?.insetY ?? null : null
      }
    }
  });
  return {
    active: true,
    arming: false,
    armProgress: 1,
    mode: ptr.mode,
    // Losing the face mid-use freezes the cursor where it was rather than
    // tearing it down; the hand leaving is what ends it.
    waitingForFace: !seeing,
    offscreen,
    drift: ptr.drift,
    progress: signal.progress,
    down: signal.down,
    handState: click.state
  };
}

/**
 * What the calibration screen needs, every frame: what the face looked like,
 * and what the hand is doing. It knows which dot is lit; this document doesn't.
 */
function postCalibrationFeed(now, click) {
  const last = gaze.last && now - gaze.last.at <= GAZE_STALE_MS ? gaze.last : null;
  const read = last?.features ? last : null;
  post({
    type: MSG.CALIBRATION_FEED,
    tracker: landmarkerState,
    trackerError: landmarkerError,
    cameraId: liveCameraId || '',
    // Frames repeat when a tick runs between camera frames; the screen uses
    // this to count each reading once.
    sample: last ? last.seq : 0,
    // How long ago this reading's picture was taken, ms: what a hold's timing
    // is judged by, not when the message happened to arrive. An age, not a
    // time: two documents' clocks needn't agree — on a Mac, one created
    // before a sleep runs behind one created after it.
    age: last ? Math.max(0, performance.now() - last.at) : -1,
    face: !!last?.face,
    eyes: !!read,
    features: read ? read.features : null,
    // How open the eyelids are — the eyes' openness, not the hand's.
    ear: read ? read.openness : 0,
    occluded: !!read?.occluded,
    // Read from a zoomed-in face: too far away to calibrate from.
    cropped: !!last?.cropped,
    // The engine's own blink call, so the result screen's dot holds through a
    // blink exactly as the cursor does.
    blink: !!read?.blink,
    eyeWidth: read ? read.eyeWidth : 0,
    eyeHeight: read ? read.eyeHeight : 0,
    iris: read ? read.iris : null,
    pose: read ? read.pose : null,
    hand: click.state !== null,
    handState: click.state,
    handArmed: click.armed,
    handOpenness: click.openness,
    // How far the armed hand has closed, 0 → 1: the dot's ring, so the screen
    // doesn't have to know this document's thresholds.
    handProgress: closingProgress(click),
    confirm: click.fired
  });
}

/**
 * Runs every frame, hand or no hand, so the cursor can time itself out.
 *
 * @returns `{ active, arming, … }` — the two truthy states both mean the
 *          pointer owns the hand and no pose may fire from it.
 */
function updatePointer(now, click) {
  // While the calibration screen is up it wants the raw readings and nothing
  // else. Driving a cursor from a mapping we are in the middle of *replacing*
  // would put a wrong cursor on top of the dots the user is looking at.
  //
  // Deliberately ahead of the `pointerEnabled` gate below. Opening the
  // calibration screen is an explicit request to calibrate, and declining to
  // read the eyes because the pointer happens to be switched off would leave
  // someone staring at a screen that never responds and never says why.
  if (now < calibrationUntil) {
    endPointer();
    postCalibrationFeed(now, click);
    return { active: false, arming: false, calibrating: true };
  }

  const blocker = pointerBlocker();
  if (blocker) {
    endPointer();
    // Carried out so the popup can say why a raised palm didn't bring the
    // cursor up — it's pressing Play instead, and nothing else would say so.
    return { active: false, arming: false, unavailable: blocker, handState: click.state, facing: click.facing };
  }

  return ptr.active ? drivePointer(now, click) : armPointer(now, click);
}

/**
 * Whether `hand` is the hand whose path ended at `last`: no farther from it
 * than a hand travels between frames, in its own palm lengths, and no other
 * hand in view nearer to it. The best hand switches from one to the other as
 * their scores cross, and from the sofa the two are only a few palms apart.
 */
function continuesTrail(last, hand, W, H) {
  const gap = Math.hypot(hand.palm.x - last.x, hand.palm.y - last.y);
  if (gap > HAND_STEP_PALMS * Math.max(last.palm || 0, hand.size || 0, 1)) return false;
  for (const landmarks of lastResult?.landmarks || []) {
    if (landmarks === hand.landmarks) continue;
    const other = palmCentre(landmarks, W, H);
    if (Math.hypot(other.x - last.x, other.y - last.y) < gap) return false;
  }
  return true;
}

/** A pose not seen for `releaseMs` is let go of, and can fire again. */
function releaseIfGone(now) {
  if (rec.candidate && now - rec.candidateSeenAt > settings.releaseMs) {
    rec.candidate = null;
    rec.fired = false;
    rec.switchTo = null;
  }
}

function processHand(now, click, W, H) {
  // Runs even with no hand and even when the pointer is switched off, so a
  // cursor that is already up always gets its release timer.
  const pointer = updatePointer(now, click);
  pointerView = pointer;

  // The pointer owns the click hand, not every hand in view. While a palm is
  // raising the cursor or the cursor is up, poses and swipes are read from the
  // best of the *other* hands, so the other hand can still mute, swipe or
  // pause. A click hand alone in view is the pointer's outright: the fist that
  // clicks must not press Pause, and moving it must not swipe.
  const owning = (pointer.active || pointer.arming) && click.landmarks;
  const palmTaken = !pointer.calibrating && pointerUsable();
  const hand =
    (owning && readHand(lastResult, W, H, click.landmarks, palmTaken)) || readHand(lastResult, W, H, null, palmTaken);
  const isClick = !!hand && !!click.landmarks && hand.landmarks === click.landmarks;
  pointer.bestIsClick = isClick;

  // The palm's recent path, kept even while the pointer is arming, so a swipe
  // made with an open hand is still seen as one. A path is one hand's: when
  // the hand read now isn't the one it followed, it starts again — or the gap
  // between the two hands would read as a swipe.
  if (hand) {
    const last = rec.trail[rec.trail.length - 1];
    if (last && !continuesTrail(last, hand, W, H)) rec.trail.length = 0;
    rec.lastHandAt = now;
    rec.trail.push({ t: now, x: hand.palm.x, y: hand.palm.y, palm: hand.size });
    const keep = Math.max(TRAIL_MS, settings.swipeMaxDurationMs);
    while (rec.trail.length && now - rec.trail[0].t > keep) rec.trail.shift();
  } else if (now - rec.lastHandAt > HAND_LOST_MS) {
    rec.trail.length = 0;
  }

  if (pointer.calibrating) {
    rec.candidate = null;
    rec.fired = false;
    rec.switchTo = null;
    rec.trail.length = 0;
    return { gesture: null, score: hand?.score ?? 0, progress: 0, handPresent: !!hand };
  }

  if (pointer.active && (!hand || isClick)) {
    // The hand being read is the cursor's own, or none: nothing here is a
    // pose. Another hand's hold isn't dropped for that — a frame or two of it
    // missing lets go only after releaseMs, as anywhere else, or its fired
    // toggle would fire again when it reappears.
    releaseIfGone(now);
    rec.trail.length = 0;
    return { gesture: null, score: hand?.score ?? 0, progress: 1, handPresent: !!hand };
  }

  if (!hand) {
    releaseIfGone(now);
    return { gesture: null, score: 0, progress: 0, handPresent: false };
  }

  // --- swipes win over poses, and over a palm that is only arming ---
  if (settings.swipeEnabled && now - rec.lastActionAt >= settings.cooldownMs) {
    const direction = detectSwipe(now, W);
    const action = direction && swipeAction(direction);
    // A swipe bound to nothing is only a hand moving: it mustn't cost a pose
    // its hold, start a cooldown or cancel the cursor's arming — paused or not.
    if (direction && action && action !== 'NONE') {
      rec.trail.length = 0;
      rec.lastActionAt = now;
      rec.candidate = null;
      rec.fired = false;
      rec.switchTo = null;
      // The palm that was arming was on its way somewhere — unless the swipe
      // was the other hand's.
      if (isClick) cancelArming();
      fire(action, 'swipe', direction);
      return { gesture: null, score: 0, progress: 0, handPresent: true, swipe: direction };
    }
  }

  // A palm going up for the cursor must not press Play on the way.
  if (pointer.arming && isClick) {
    releaseIfGone(now);
    return { gesture: null, score: hand.score, progress: pointer.armProgress || 0, handPresent: true };
  }

  // --- held poses ---
  const name = hand.gesture;
  // While the eye pointer can be used, ✋ is its gesture: raised to the camera
  // it brings the cursor up, and however else it is held — flat on the desk,
  // tilted, on the move — it never presses its own binding. Paused, a pose
  // that doesn't resume Jester isn't worth reading at all: it would only fill
  // a bar for something that isn't going to happen.
  const recognised =
    name &&
    name !== 'None' &&
    hand.score >= settings.minGestureScore &&
    !(palmTaken && name === 'Open_Palm') &&
    !(standby && !resumesStandby(settings, 'pose', name));

  if (!recognised) {
    releaseIfGone(now);
    return { gesture: null, score: hand.score, progress: 0, handPresent: true };
  }

  if (rec.candidate !== name) {
    // A pose that already fired stays spent until the hand has really moved
    // on: another has to hold for releaseMs to take over. The model naming
    // something else for a frame or two on the way would otherwise re-arm it,
    // and a held toggle would undo itself when the pose came back.
    if (rec.fired && rec.candidate && now - rec.candidateSeenAt <= settings.releaseMs) {
      if (rec.switchTo !== name) {
        rec.switchTo = name;
        rec.switchSince = now;
      }
      if (now - rec.switchSince < settings.releaseMs) {
        return { gesture: name, score: hand.score, progress: 0, handPresent: true };
      }
    }
    // A switch that had to wait is credited with the time it waited.
    rec.candidateSince = rec.switchTo === name ? rec.switchSince : now;
    rec.candidate = name;
    rec.fired = false;
  }
  rec.switchTo = null;
  rec.candidateSeenAt = now;

  // The pose that just paused Jester, still held. It has to be let go of
  // before it can resume anything, so it isn't on its way to doing so — and
  // reading it as a pose would show a full bar for a resume that isn't coming.
  if (standby && rec.fired) return { gesture: null, score: hand.score, progress: 0, handPresent: true };

  // A moving hand is mid-swipe, not holding a pose — keep restarting the timer.
  if (speedOverWindow(now, W) > settings.maxHoldSpeed) {
    rec.candidateSince = now;
    return { gesture: name, score: hand.score, progress: 0, handPresent: true };
  }

  const binding = poseBinding(name);
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

/**
 * What the popup and the page's pill should say about the pointer, if
 * anything.
 *
 * `state` is one of `calibrating`, `arming`, `active`, `no-eyes` (the palm is
 * up but what aims can't be read), `away` (looking off the screen), `flat` (an
 * open palm held still but not up to the camera) or `unavailable` — the palm
 * is up, but it is pressing its pose instead, and `reason` says why:
 * `uncalibrated`, `stale` (a calibration from another camera or an older
 * version), `screen` (made on a screen of another size), `no-screen` or
 * `tracker-failed`. Switched off, or Jester paused, there is nothing to say:
 * that palm was never going to raise a cursor, and the popup already says why.
 * `mode` is how an active cursor aims ('hybrid', 'eyes', 'head'), with `why`
 * for a head-steered one; `drift` says whether the head has moved since
 * calibrating: `turned` or `moved` (a re-centre fixes it) or `distance`
 * (recalibrate).
 */
function pointerTelemetry(p) {
  if (!p) return null;
  if (p.calibrating) return { state: 'calibrating' };
  if (p.active) {
    return {
      state: p.waitingForFace ? 'no-eyes' : p.offscreen ? 'away' : 'active',
      active: true,
      mode: p.mode || null,
      why: p.mode === 'head' ? headReason() : null,
      progress: p.progress || 0,
      down: !!p.down,
      handState: p.handState || null,
      drift: p.drift || null
    };
  }
  if (p.arming) {
    return {
      state: p.waitingForFace ? 'no-eyes' : 'arming',
      armProgress: p.armProgress || 0,
      handState: p.handState || null
    };
  }
  if (p.flat && p.bestIsClick) return { state: 'flat' };
  // Only worth saying while a palm is actually raised to the camera: that is
  // the moment someone expected a cursor and got their ✋ binding instead. A
  // hand lying open in a lap expected nothing.
  const silent = p.unavailable === 'disabled' || p.unavailable === 'standby';
  if (p.unavailable && !silent && p.handState === 'open' && p.facing >= PALM_SHOWN && p.bestIsClick) {
    return { state: 'unavailable', reason: p.unavailable };
  }
  return null;
}

/** What the zoom is doing, for the popup: zoomed in on someone far away, or looking for them. */
function zoomTelemetry() {
  if (!settings.longRange || !zoom) return null;
  if (crops.searching) return { state: 'searching' };
  if (crops.face || crops.hands) return { state: 'zoomed' };
  return null;
}

function emitTelemetry(now, view) {
  // Nobody is listening: no popup open and the on-page HUD is switched off.
  if (!settings.showHud && now > previewWantedUntil) return;
  if (now - lastTelemetryAt < TELEMETRY_INTERVAL_MS) return;
  const telemetry = {
    gesture: view.gesture,
    label: view.gesture ? GESTURE_LABELS[view.gesture] || view.gesture : null,
    score: Math.round(view.score * 100) / 100,
    progress: Math.round(view.progress * 100) / 100,
    handPresent: view.handPresent,
    swipe: view.swipe || null,
    // Paused: `gesture` and `progress` are then only ever a pose resuming Jester.
    standby,
    sleeping: standby,
    mic: micStatus,
    pointing: { active: voice.active },
    voicePill: voice.active,
    pointer: pointerTelemetry(pointerView),
    zoom: zoomTelemetry(),
    stalled: running && now - lastFrameAt > STALE_FRAME_MS,
    fps: Math.round(fps),
    delegate: activeDelegate
  };
  // Unchanged telemetry is sent only as a slow heartbeat: every message wakes
  // every extension page that listens.
  const key = JSON.stringify({ ...telemetry, fps: 0 });
  if (key === lastTelemetryKey && now - lastTelemetryAt < TELEMETRY_HEARTBEAT_MS) return;
  lastTelemetryKey = key;
  lastTelemetryAt = now;
  post({ type: MSG.TELEMETRY, telemetry });
}

function drawPreview(now, hands, W, H) {
  if (now > previewWantedUntil) return;
  if (now - lastPreviewAt < PREVIEW_INTERVAL_MS) return;
  if (!frameCanvas.width) return;
  lastPreviewAt = now;

  // The preview keeps the camera's shape: 16:9 from a 16:9 camera.
  const width = previewCanvas.width;
  const height = Math.round((width * H) / W) || previewCanvas.height;
  if (previewCanvas.height !== height) previewCanvas.height = height;
  const mirror = !!settings.mirrorPreview;
  previewCtx.save();
  if (mirror) {
    previewCtx.translate(width, 0);
    previewCtx.scale(-1, 1);
  }
  previewCtx.drawImage(frameCanvas, 0, 0, width, height);
  previewCtx.restore();

  const toX = (x) => (mirror ? 1 - x : x) * width;
  const toY = (y) => y * height;
  const box = (rect, color, dashed = false) => {
    const x = mirror ? width - ((rect.x + rect.w) / W) * width : (rect.x / W) * width;
    previewCtx.save();
    previewCtx.strokeStyle = color;
    previewCtx.lineWidth = 1.5;
    if (dashed) previewCtx.setLineDash([4, 3]);
    previewCtx.strokeRect(x, (rect.y / H) * height, (rect.w / W) * width, (rect.h / H) * height);
    previewCtx.restore();
  };

  // Where the zoom is looking: the hands' crop and the face's, or the place
  // being searched.
  if (settings.longRange) {
    if (crops.searching && crops.face) box(crops.face, 'rgba(250, 204, 21, 0.7)', true);
    else {
      if (crops.hands) box(crops.hands, 'rgba(126, 231, 135, 0.6)', true);
      if (crops.face) box(crops.face, 'rgba(250, 204, 21, 0.75)', true);
    }
  }

  // Every hand, not just the best one — the one closing into a fist may not be
  // the one the pose recognizer is most sure of.
  for (const drawn of hands || []) {
    if (!drawn?.landmarks) continue;

    previewCtx.lineWidth = 2;
    previewCtx.strokeStyle = 'rgba(126, 231, 135, 0.9)';
    previewCtx.beginPath();
    for (const { start, end } of GestureRecognizer.HAND_CONNECTIONS) {
      const a = drawn.landmarks[start];
      const b = drawn.landmarks[end];
      if (!a || !b) continue;
      previewCtx.moveTo(toX(a.x), toY(a.y));
      previewCtx.lineTo(toX(b.x), toY(b.y));
    }
    previewCtx.stroke();

    previewCtx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    for (const lm of drawn.landmarks) {
      previewCtx.beginPath();
      previewCtx.arc(toX(lm.x), toY(lm.y), 2.5, 0, Math.PI * 2);
      previewCtx.fill();
    }
  }

  // Box the two eyes being read. It is the quickest way to tell a badly aimed
  // cursor from a lost face — which look identical from the page's side. Red
  // is a reading that can't be used (a hand across the eyes), amber a blink.
  const last = gaze.last;
  if (last?.boxes && now - last.at <= GAZE_STALE_MS) {
    const color = last.occluded ? 'rgba(251, 113, 133, 0.95)' : last.blink ? 'rgba(251, 191, 36, 0.9)' : 'rgba(125, 211, 252, 0.95)';
    for (const eye of [last.boxes.left, last.boxes.right]) box(eye, color);
  }

  post({ type: MSG.PREVIEW_FRAME, dataUrl: previewCanvas.toDataURL('image/jpeg', 0.6) });
}

// ---------------------------------------------------------------------------
// Voice commands: a bound gesture starts a latched single-utterance capture.
// Its lifetime is independent of the webcam frame loop and pointer resets.
// ---------------------------------------------------------------------------

let micStatus = { state: MIC.IDLE, detail: '' };
let voicePillUp = false;
const voice = createVoice({
  onLevels: (levels) => {
    if (voicePillUp) post({ type: MSG.VOICE, voice: { active: true, levels, position: 'bottom-center' } });
  },
  onTranscript: (transcript) => {
    post({ type: MSG.VOICE, voice: { transcript } });
  },
  onStatus: (status) => {
    micStatus = status;
    lastStatus = { ...lastStatus, mic: micStatus };
    post({ type: MSG.ENGINE_STATUS, ...lastStatus });
    if (voicePillUp) post({ type: MSG.VOICE, voice: { active: true, mic: status, detail: status.detail, position: 'bottom-center' } });
  },
  onCommand: ({ text }) => {
    // The worker owns execution; speech never types directly into the page.
    post({ type: MSG.VOICE_COMMAND, text });
  },
  onComplete: ({ submitted, state, detail }) => {
    voicePillUp = false;
    // A submitted command hands the existing pill straight to the assistant.
    if (submitted) return;
    if (detail || state === MIC.ERROR || state === MIC.NO_PERMISSION) {
      post({ type: MSG.VOICE, voice: {
        phase: 'answer', text: detail || 'Voice command could not start.', ok: false,
        position: 'bottom-center'
      } });
    } else post({ type: MSG.VOICE, voice: { active: false } });
  }
});

function controlVoice(action) {
  if (action === 'cancel') { voice.stop(); return; }
  if (action === 'stop' || action === 'finish') { voice.finish(); return; }
  if (!settings?.enabled || !settings.voiceEnabled || standby) return;
  if (action === 'toggle' && voice.active) { voice.finish(); return; }
  if (action !== 'start' && action !== 'toggle') return;
  if (voice.active) return;
  voicePillUp = true;
  post({ type: MSG.VOICE, voice: { active: true, start: true, levels: [0, 0, 0, 0, 0], position: 'bottom-center' } });
  voice.start({ language: settings.voiceLanguage });
}

// Spoken clicks are resolved and authorized by the worker's agent boundary.
// VOICE_CONTROL only controls microphone capture; palm/fist clicks stay manual.

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
/** Settings that change how the cursor aims: one already up is dropped, to be raised again the new way. */
const POINTER_KEYS = ['pointerEnabled', 'pointerInput', 'pointerAim', 'headSpeed', 'pointerSmoothing'];

async function applySettings(next) {
  const previous = settings;
  settings = next;
  if (!settings.enabled || !settings.voiceEnabled || (previous && previous.voiceLanguage !== settings.voiceLanguage)) voice.stop();
  // The camera may just have changed, and a calibration belongs to one camera.
  refreshGazeModel();
  if (previous && POINTER_KEYS.some((key) => previous[key] !== settings[key])) endPointer();
  if (previous && previous.longRange !== settings.longRange) {
    crops = NO_CROPS;
    zoom?.reset();
    if (settings.longRange && running) ensureFaceLandmarker();
  }

  if (!settings.enabled) {
    // Off is off: switched back on, Jester starts out listening, not paused.
    standby = false;
    if (running || starting) stop(ENGINE.OFF);
    else if (!previous) report(ENGINE.OFF);
    return;
  }

  // Paused, with nothing left that could resume it — its binding changed in
  // Settings meanwhile — would be the camera on for good with nothing ever to
  // end it. Resume instead. Otherwise the way to resume may have changed.
  if (standby && !resumeGlyphs(settings)) setStandby(false);
  else if (standby && running) reportRunning();

  const needsRestart =
    previous && RESTART_KEYS.some((key) => previous[key] !== settings[key]);

  if (needsRestart) {
    stop(ENGINE.STARTING, 'Applying new settings…');
    try {
      recognizer?.close?.();
    } catch {
      /* it is being replaced either way */
    }
    recognizer = null;
    dropFaceLandmarker();
    await start();
    return;
  }

  if (!running && !starting) await start();
}

/**
 * Settings arrive one at a time and are applied one at a time: a restart that
 * starts while another is still loading its model would otherwise run two
 * engines at once.
 */
let applyChain = Promise.resolve();
function queueSettings(next) {
  applyChain = applyChain
    .then(() => applySettings(next))
    .catch((err) => report(ENGINE.ERROR, String(err?.message || err)));
  return applyChain;
}

/**
 * Offscreen documents are only granted `chrome.runtime` — `chrome.storage` is
 * undefined here, so settings are requested from (and pushed by) the worker.
 */
async function requestSettings() {
  const response = await chrome.runtime.sendMessage({ type: MSG.SETTINGS_REQUEST });
  // A worker that couldn't read the settings says so rather than staying
  // silent; starting on the defaults instead would quietly ignore every
  // binding and threshold the user set.
  if (!response?.settings) throw new Error(response?.detail || 'the service worker sent no settings');
  return {
    settings: mergeSettings(response?.settings),
    suspend: !!response?.suspend,
    context: response?.context,
    screen: response?.screen || null,
    calibration: response?.calibration || null
  };
}

/**
 * Entering or leaving fullscreen re-points every pose at a different action, so
 * a hold that was part-way through belongs to the set that is no longer live:
 * drop it rather than credit it to the new one. A pose that already fired
 * stays spent — it is very likely the 🤟 that just toggled fullscreen, still
 * held, and must not toggle it straight back.
 */
function setContext(context) {
  if (context !== 'fullscreen' && context !== 'windowed') return;
  if (context === viewContext) return;
  viewContext = context;
  if (!rec.fired) {
    rec.candidate = null;
    rec.candidateSince = 0;
  }
  rec.switchTo = null;
  rec.trail.length = 0;
}

/**
 * What a push has already set, so the boot reply — assembled by the worker
 * across several awaits, and possibly older — doesn't overwrite it.
 */
const pushed = { settings: false, suspend: false, screen: false, calibration: false, context: false };

chrome.runtime.onMessage.addListener((message, sender) => {
  // Settings, a calibration, a pause: only Jester itself may say — never a
  // content script, whose messages reach this page too.
  if (!fromJester(sender)) return false;
  switch (message?.type) {
    case MSG.VOICE_CONTROL:
      controlVoice(message.action || 'toggle');
      return false;
    case MSG.ENGINE_STOP:
      voice.stop();
      stop(ENGINE.OFF);
      return false;
    case MSG.PREVIEW_PING:
      previewWantedUntil = performance.now() + PREVIEW_GRACE_MS;
      return false;
    case MSG.ENGINE_SETTINGS:
      pushed.settings = true;
      queueSettings(mergeSettings(message.settings));
      return false;
    case MSG.ENGINE_CONFIG:
      if (typeof message.suspend === 'boolean') {
        pushed.suspend = true;
        if (message.suspend !== suspended) {
          suspended = message.suspend;
          // A pose half-held when the engine paused mustn't fire on the first
          // frame after it wakes, with no hold at all.
          resetRecognitionState();
          if (running) reportRunning();
        }
      }
      if (message.context) {
        pushed.context = true;
        setContext(message.context);
      }
      if (message.screen !== undefined) {
        pushed.screen = true;
        pageScreen = message.screen || null;
      }
      return false;
    case MSG.ENGINE_QUERY:
      // The worker restarted and lost its copy of our state.
      post({ type: MSG.ENGINE_STATUS, ...lastStatus });
      return false;
    case MSG.CALIBRATION_MODEL:
      pushed.calibration = true;
      if (settings) setCalibration(message.calibration);
      else calibration = message.calibration || null;
      return false;
    case MSG.CALIBRATION_MODE:
      if (message.on) {
        // Only on the *first* beat of a new lease, not on every heartbeat: tear
        // the cursor down, and give a tracker that gave up another chance —
        // opening calibration is a request to use it.
        if (performance.now() >= calibrationUntil) {
          endPointer();
          forgiveTracker();
        }
        calibrationUntil = performance.now() + CALIBRATION_LEASE_MS;
      } else {
        calibrationUntil = 0;
      }
      return false;
    default:
      return false;
  }
});

window.addEventListener('pagehide', () => { voice.stop(); stop(ENGINE.OFF); });

(async () => {
  let initial;
  try {
    initial = await requestSettings();
  } catch (err) {
    if (!pushed.settings) report(ENGINE.ERROR, `Could not read settings: ${err?.message || err}`);
    return;
  }
  if (!pushed.suspend) suspended = initial.suspend;
  if (!pushed.screen) pageScreen = initial.screen;
  if (!pushed.context && initial.context) viewContext = initial.context;
  if (!pushed.calibration) calibration = initial.calibration;
  if (pushed.settings) {
    // A push got here first and is already being applied, with the newer settings.
    refreshGazeModel();
    return;
  }
  queueSettings(initial.settings);
})();
