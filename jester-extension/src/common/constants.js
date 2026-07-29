/**
 * Shared vocabulary for every extension context (service worker, offscreen
 * document, popup, options page).
 *
 * NOTE: the content script cannot import ES modules, so anything it needs is
 * passed to it inside messages rather than imported from here.
 */

/** The canned gesture labels the MediaPipe GestureRecognizer model emits. */
export const GESTURES = [
  { id: 'Open_Palm', label: 'Open palm', glyph: '✋' },
  { id: 'Closed_Fist', label: 'Closed fist', glyph: '✊' },
  { id: 'Victory', label: 'Victory / peace', glyph: '✌️' },
  { id: 'Thumb_Up', label: 'Thumb up', glyph: '👍' },
  { id: 'Thumb_Down', label: 'Thumb down', glyph: '👎' },
  { id: 'Pointing_Up', label: 'Pointing up', glyph: '☝️' },
  { id: 'ILoveYou', label: 'ILoveYou sign', glyph: '🤟' }
];

export const SWIPES = [
  { id: 'left', label: 'Swipe left', glyph: '⬅️' },
  { id: 'right', label: 'Swipe right', glyph: '➡️' },
  { id: 'up', label: 'Swipe up', glyph: '⬆️' },
  { id: 'down', label: 'Swipe down', glyph: '⬇️' }
];

/**
 * Every action a gesture can be bound to. `repeatable` marks actions that feel
 * natural to fire over and over while you hold the pose (volume, seeking).
 */
export const ACTIONS = {
  NONE: { label: 'Do nothing', repeatable: false },
  PLAY_PAUSE: { label: 'Play / pause', repeatable: false },
  PLAY: { label: 'Play', repeatable: false },
  PAUSE: { label: 'Pause', repeatable: false },
  SEEK_FORWARD: { label: 'Skip forward', repeatable: true },
  SEEK_BACK: { label: 'Skip back', repeatable: true },
  VOLUME_UP: { label: 'Volume up', repeatable: true },
  VOLUME_DOWN: { label: 'Volume down', repeatable: true },
  MUTE_TOGGLE: { label: 'Mute / unmute', repeatable: false },
  SPEED_UP: { label: 'Speed up', repeatable: true },
  SPEED_DOWN: { label: 'Slow down', repeatable: true },
  EXIT_FULLSCREEN: { label: 'Exit fullscreen', repeatable: false },
  FULLSCREEN_TOGGLE: { label: 'Fullscreen toggle', repeatable: false },
  SKIP_AD: { label: 'Skip ad', repeatable: false },
  NEXT_VIDEO: { label: 'Next video / episode', repeatable: false }
};

/** Message envelope types. Every message is `{ type, ...payload }`. */
export const MSG = {
  // popup/options -> service worker
  GET_STATE: 'jester/get-state',
  SET_ENABLED: 'jester/set-enabled',
  RESTART_ENGINE: 'jester/restart-engine',
  // offscreen -> service worker
  // An offscreen document has no chrome.storage of its own, so it asks the
  // worker for settings instead of reading them.
  SETTINGS_REQUEST: 'jester/settings-request',
  // service worker -> offscreen
  ENGINE_CONFIG: 'jester/engine-config',
  ENGINE_SETTINGS: 'jester/engine-settings',
  ENGINE_STOP: 'jester/engine-stop',
  ENGINE_QUERY: 'jester/engine-query',
  // offscreen -> everyone
  ENGINE_STATUS: 'jester/engine-status',
  TELEMETRY: 'jester/telemetry',
  PREVIEW_FRAME: 'jester/preview-frame',
  TRIGGER: 'jester/trigger',
  // popup -> offscreen
  PREVIEW_PING: 'jester/preview-ping',
  // service worker -> popup
  STATE: 'jester/state',
  ACTION_RESULT: 'jester/action-result',
  // service worker <-> content script
  DO_ACTION: 'jester/do-action',
  PROBE: 'jester/probe',
  VIDEO_STATE: 'jester/video-state',
  HUD: 'jester/hud',
  // Fullscreen needs window-level control, so the worker drives it step by step
  // instead of handing the whole action to the frame.
  FULLSCREEN: 'jester/fullscreen',
  TOAST: 'jester/toast',
  // content script -> service worker
  FULLSCREEN_EXIT: 'jester/fullscreen-exit',
  FULLSCREEN_DETACHED: 'jester/fullscreen-detached'
};

/**
 * How `FULLSCREEN_TOGGLE` gets around the fact that `requestFullscreen()` needs
 * transient user activation, which a recognised gesture never has.
 */
export const FULLSCREEN_MODES = {
  cinema: {
    label: 'Cinema mode (recommended)',
    hint:
      "Puts the browser window itself into fullscreen — an API that doesn't need a " +
      'click — and pins the player to fill it. Looks the same as real fullscreen and ' +
      'needs no extra permission.'
  },
  debugger: {
    label: 'True fullscreen (needs the debugger permission)',
    hint:
      "Uses Chrome's debugger to hand the page a real user gesture, so the site's own " +
      'fullscreen engages. Chrome shows a "being debugged" bar for a moment each time, ' +
      'and it cannot attach while DevTools is open on that tab.'
  }
};

/** Engine lifecycle states surfaced in the popup. */
export const ENGINE = {
  OFF: 'off',
  STARTING: 'starting',
  RUNNING: 'running',
  SUSPENDED: 'suspended',
  NO_PERMISSION: 'no-permission',
  ERROR: 'error'
};

export const DEFAULT_SETTINGS = {
  enabled: false,

  // --- camera ---
  cameraDeviceId: '',
  mirrorPreview: true,

  // --- inference ---
  targetFps: 20,
  delegate: 'GPU', // 'GPU' | 'CPU' — falls back to CPU automatically on failure
  numHands: 1,
  minHandDetectionConfidence: 0.5,
  minTrackingConfidence: 0.5,

  // --- pose (static gesture) recognition ---
  minGestureScore: 0.55,
  holdMs: 450, // how long a pose must be held before it fires
  cooldownMs: 1000, // global quiet period after any action
  repeatMs: 450, // re-fire interval for repeatable actions held down
  releaseMs: 250, // pose must be absent this long before it can re-arm
  maxHoldSpeed: 0.35, // normalized units/sec — a moving hand never fires a pose

  // --- swipe recognition ---
  swipeEnabled: true,
  swipeMinDistance: 0.22, // fraction of frame width/height
  swipeMaxDurationMs: 400,
  swipeAxisRatio: 1.8, // dominant axis must beat the other by this factor

  // --- playback ---
  seekSeconds: 10,
  volumeStep: 0.1,
  speedStep: 0.25,
  fullscreenMode: 'cinema', // see FULLSCREEN_MODES

  // --- feedback ---
  showHud: true,
  showToasts: true,

  // --- power ---
  pauseWhenNoVideo: false,

  bindings: {
    Open_Palm: { action: 'PLAY_PAUSE', repeat: false },
    Closed_Fist: { action: 'NONE', repeat: false },
    Victory: { action: 'MUTE_TOGGLE', repeat: false },
    Thumb_Up: { action: 'VOLUME_UP', repeat: true },
    Thumb_Down: { action: 'VOLUME_DOWN', repeat: true },
    Pointing_Up: { action: 'SKIP_AD', repeat: false },
    ILoveYou: { action: 'NONE', repeat: false }
  },

  swipeBindings: {
    left: 'SEEK_BACK',
    right: 'SEEK_FORWARD',
    up: 'VOLUME_UP',
    down: 'VOLUME_DOWN'
  }
};

/**
 * Read settings, filling in anything missing with defaults.
 *
 * NOTE: not usable from the offscreen document — `chrome.storage` is undefined
 * there. It asks the service worker via `MSG.SETTINGS_REQUEST` instead.
 */
export async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return mergeSettings(settings);
}

export function mergeSettings(stored) {
  const merged = { ...DEFAULT_SETTINGS, ...(stored || {}) };
  merged.bindings = { ...DEFAULT_SETTINGS.bindings, ...(stored?.bindings || {}) };
  merged.swipeBindings = { ...DEFAULT_SETTINGS.swipeBindings, ...(stored?.swipeBindings || {}) };
  return merged;
}

export async function saveSettings(patch) {
  const current = await loadSettings();
  const next = mergeSettings({ ...current, ...patch });
  await chrome.storage.local.set({ settings: next });
  return next;
}

/** `chrome.runtime.sendMessage` that stays quiet when nobody is listening. */
export function post(message) {
  return chrome.runtime.sendMessage(message).catch(() => undefined);
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
