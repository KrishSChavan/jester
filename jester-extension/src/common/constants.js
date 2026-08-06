/**
 * Shared vocabulary for every extension context (service worker, offscreen
 * document, popup, options page).
 *
 * NOTE: the content script cannot import ES modules, so anything it needs is
 * passed to it inside messages rather than imported from here.
 */

/**
 * The canned gesture labels the MediaPipe GestureRecognizer model emits.
 *
 * The pointer shapes — a half-open hand to steer, a thumb-to-index pinch to
 * click — are deliberately *not* here: the model can't recognise either, so
 * they're measured off the raw landmarks in the offscreen document, and they
 * drive a mode rather than firing an action, so neither is bindable. See
 * `pointerReading()`.
 */
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
 * Every action a gesture can be bound to.
 *
 * `repeatable` marks actions that feel natural to fire over and over while you
 * hold the pose (volume, seeking). `group` is purely how the options page files
 * them in its dropdown.
 *
 * `scope` decides *who* runs the action and *what* it needs to run against:
 *
 *   video   — the <video> frame the service worker resolves. Needs a player.
 *   page    — the top frame of whatever tab is in front. Needs no player.
 *   browser — chrome.tabs / chrome.windows, so the service worker itself.
 *   window  — fullscreen, which the worker drives step by step across both.
 *   system  — Jester's own state.
 */
export const ACTIONS = {
  NONE: { label: 'Do nothing', repeatable: false, scope: 'none' },

  // --- playback ---
  PLAY_PAUSE: { label: 'Play / pause', repeatable: false, scope: 'video', group: 'Video' },
  PLAY: { label: 'Play', repeatable: false, scope: 'video', group: 'Video' },
  PAUSE: { label: 'Pause', repeatable: false, scope: 'video', group: 'Video' },
  SEEK_FORWARD: { label: 'Skip forward', repeatable: true, scope: 'video', group: 'Video' },
  SEEK_BACK: { label: 'Skip back', repeatable: true, scope: 'video', group: 'Video' },
  VOLUME_UP: { label: 'Volume up', repeatable: true, scope: 'video', group: 'Video' },
  VOLUME_DOWN: { label: 'Volume down', repeatable: true, scope: 'video', group: 'Video' },
  MUTE_TOGGLE: { label: 'Mute / unmute', repeatable: false, scope: 'video', group: 'Video' },
  SPEED_UP: { label: 'Speed up', repeatable: true, scope: 'video', group: 'Video' },
  SPEED_DOWN: { label: 'Slow down', repeatable: true, scope: 'video', group: 'Video' },
  SKIP_AD: { label: 'Skip ad', repeatable: false, scope: 'video', group: 'Video' },
  NEXT_VIDEO: { label: 'Next video / episode', repeatable: false, scope: 'video', group: 'Video' },

  // --- fullscreen ---
  FULLSCREEN_TOGGLE: { label: 'Fullscreen toggle', repeatable: false, scope: 'window', group: 'Fullscreen' },
  EXIT_FULLSCREEN: { label: 'Exit fullscreen', repeatable: false, scope: 'window', group: 'Fullscreen' },

  // --- the page you're on ---
  SCROLL_UP: { label: 'Scroll up', repeatable: true, scope: 'page', group: 'Browsing' },
  SCROLL_DOWN: { label: 'Scroll down', repeatable: true, scope: 'page', group: 'Browsing' },
  PAGE_TOP: { label: 'Jump to top', repeatable: false, scope: 'page', group: 'Browsing' },
  PAGE_BOTTOM: { label: 'Jump to bottom', repeatable: false, scope: 'page', group: 'Browsing' },
  HISTORY_BACK: { label: 'Back', repeatable: true, scope: 'browser', group: 'Browsing' },
  HISTORY_FORWARD: { label: 'Forward', repeatable: true, scope: 'browser', group: 'Browsing' },
  RELOAD: { label: 'Reload the page', repeatable: false, scope: 'browser', group: 'Browsing' },

  // --- tabs and windows ---
  TAB_NEXT: { label: 'Next tab', repeatable: true, scope: 'browser', group: 'Tabs & windows' },
  TAB_PREV: { label: 'Previous tab', repeatable: true, scope: 'browser', group: 'Tabs & windows' },
  TAB_MOVE_RIGHT: { label: 'Move this tab right', repeatable: true, scope: 'browser', group: 'Tabs & windows' },
  TAB_MOVE_LEFT: { label: 'Move this tab left', repeatable: true, scope: 'browser', group: 'Tabs & windows' },
  TAB_NEW: { label: 'New tab', repeatable: false, scope: 'browser', group: 'Tabs & windows' },
  TAB_CLOSE: { label: 'Close this tab', repeatable: false, scope: 'browser', group: 'Tabs & windows' },
  TAB_REOPEN: { label: 'Reopen closed tab', repeatable: false, scope: 'browser', group: 'Tabs & windows' },
  WINDOW_NEXT: { label: 'Next window', repeatable: false, scope: 'browser', group: 'Tabs & windows' },

  // One-way by nature: it stops the camera, so no gesture can undo it. Switching
  // back on has to come from the popup or the options page.
  DISABLE: { label: 'Turn Jester off', repeatable: false, scope: 'system', group: 'Jester' }
};

/**
 * When the voice pill is on screen.
 *
 * The pill is also what says the microphone is live, so this doubles as the
 * control over when Jester is listening — `always` really does mean always.
 */
export const VOICE_PILL_MODES = {
  'pointer-finger': {
    label: 'When I raise my index finger (recommended)',
    hint:
      'Hold up your index finger with the other fingers curled and the pill slides in, ' +
      'listening. Drop your hand and it goes, taking the microphone with it.'
  },
  always: {
    label: 'Always, while Jester is on',
    hint: 'The pill sits on every page and the microphone stays live the whole time Jester is running.'
  },
  off: {
    label: 'Never',
    hint: 'No pill, and the microphone is never opened.'
  }
};

/** Where the pill sits on the page. */
export const VOICE_PILL_POSITIONS = {
  'bottom-center': { label: 'Bottom, centred' },
  'top-center': { label: 'Top, centred' },
  'bottom-left': { label: 'Bottom left' },
  'bottom-right': { label: 'Bottom right' }
};

/**
 * The two situations a gesture can land in. Which one is live decides which
 * binding set the engine reads — see `bindingsFor()`.
 *
 * `fullscreen` covers all three ways a video can fill the screen (cinema mode,
 * the site's own fullscreen, and the user's own F11), because from the user's
 * side they are the same thing: a video with nothing else on screen.
 */
export const CONTEXTS = {
  fullscreen: {
    label: 'In fullscreen',
    hint: 'Cinema mode, the site\'s own fullscreen, or a window you put fullscreen yourself.'
  },
  windowed: {
    label: 'Not fullscreen',
    hint: 'An ordinary browser window — browsing, or watching in a small player.'
  }
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
  // offscreen -> service worker -> content script (virtual pointer, ~20/s)
  CURSOR: 'jester/cursor',
  // content script -> service worker
  CURSOR_CLICK: 'jester/cursor-click',
  // offscreen -> service worker -> content script: the voice pill's visibility,
  // its five band levels (~25/s while up), and any transcript that lands.
  VOICE: 'jester/voice',
  // service worker -> popup: the pill is up but the page in front can't be
  // reached, so there is nothing to draw it on. Silent otherwise — you'd be left
  // holding a gesture that the popup says is working, at a page that never
  // responds.
  VOICE_BLOCKED: 'jester/voice-blocked',
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
  FULLSCREEN_DETACHED: 'jester/fullscreen-detached',
  // content script -> service worker: "this tab just entered / left a fullscreen
  // view". The worker turns that into the context it pushes to the engine.
  VIEW_CONTEXT: 'jester/view-context'
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
    label: 'True fullscreen (unavailable — see below)',
    hint:
      "Uses Chrome's debugger to hand the page a real user gesture, so the site's own " +
      'fullscreen engages. Chrome shows a "being debugged" bar for a moment each time, ' +
      'and it cannot attach while DevTools is open on that tab.',
    /**
     * Chrome refuses `debugger` in `optional_permissions` — it logs "Permission
     * 'debugger' cannot be listed as optional. This permission will be omitted."
     * and strips it, so `chrome.permissions.request()` can never grant it.
     *
     * The only way to have it is as a *required* permission, which every user
     * would be asked to accept at install for a mode most of them won't use.
     * So it's offered but disabled, with the reason on show, rather than
     * silently vanishing — `trueFullscreen()` in the service worker is intact
     * and this becomes selectable again the moment that trade is worth making.
     */
    unavailable:
      'Chrome no longer allows "debugger" as an optional permission, so Jester can’t ask ' +
      'for it on demand. Having it would mean making it a required permission, which ' +
      'every user would have to accept at install. Cinema mode looks the same and costs ' +
      'nothing, so that’s what runs.'
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

  // --- pointer (virtual mouse): a half-open hand steers, a pinch clicks ---
  pointerEnabled: true,
  pointerTolerance: 0.5, // how far from "half open" the hand may stray
  pointerArmMs: 350, // hand must hold the shape this long before the cursor appears
  pointerSmoothing: 0.5, // 0 = raw and twitchy, 1 = heavily damped
  // Fraction of the camera frame mapped onto the full viewport. Deliberately
  // most of it: a small box turns every twitch into a screen-wide jump. The
  // last sliver at each edge is left out because a palm centred there has half
  // the hand out of frame, where the landmarks go unreliable.
  pointerRangeX: 0.9,
  pointerRangeY: 0.75,
  pointerPinchDistance: 0.35, // thumb-to-index gap that counts as touching, in palm widths

  // --- voice pill: an index finger raises it, and the microphone with it ---
  voicePillMode: 'pointer-finger', // see VOICE_PILL_MODES
  voicePillPosition: 'bottom-center', // see VOICE_PILL_POSITIONS

  // --- playback ---
  seekSeconds: 10,
  volumeStep: 0.1,
  speedStep: 0.25,
  fullscreenMode: 'cinema', // see FULLSCREEN_MODES

  // --- browsing ---
  scrollStep: 0.6, // fraction of the viewport one scroll action covers

  // --- feedback ---
  showHud: true,
  showToasts: true,

  // --- power ---
  pauseWhenNoVideo: false,

  /**
   * Off by default: one set of bindings everywhere is the behaviour people
   * already have, and silently changing what a pose does depending on the
   * window would be a nasty surprise to opt someone into.
   */
  windowedBindingsEnabled: false,

  bindings: {
    // Play and pause are separate poses rather than one toggle: a toggle you
    // can't see the state of fires blind if a hold is missed.
    Open_Palm: { action: 'PLAY', repeat: false },
    Closed_Fist: { action: 'PAUSE', repeat: false },
    Victory: { action: 'MUTE_TOGGLE', repeat: false },
    Thumb_Up: { action: 'VOLUME_UP', repeat: true },
    Thumb_Down: { action: 'VOLUME_DOWN', repeat: true },
    Pointing_Up: { action: 'SKIP_AD', repeat: false },
    ILoveYou: { action: 'FULLSCREEN_TOGGLE', repeat: false }
  },

  swipeBindings: {
    left: 'SEEK_BACK',
    right: 'SEEK_FORWARD',
    up: 'VOLUME_UP',
    down: 'VOLUME_DOWN'
  },

  /**
   * Used instead of the two sets above once `windowedBindingsEnabled` is on.
   *
   * The starting point deliberately keeps play/pause, mute and fullscreen on
   * the same poses — a windowed player is still a player, and a sign that means
   * two different things depending on the window is the thing worth avoiding.
   * What changes is everything that only made sense against a video: swipes
   * navigate tabs instead of seeking, and the thumbs scroll instead of setting
   * the volume.
   */
  windowedBindings: {
    Open_Palm: { action: 'PLAY', repeat: false },
    Closed_Fist: { action: 'PAUSE', repeat: false },
    Victory: { action: 'MUTE_TOGGLE', repeat: false },
    Thumb_Up: { action: 'SCROLL_UP', repeat: true },
    Thumb_Down: { action: 'SCROLL_DOWN', repeat: true },
    Pointing_Up: { action: 'PAGE_TOP', repeat: false },
    ILoveYou: { action: 'FULLSCREEN_TOGGLE', repeat: false }
  },

  windowedSwipeBindings: {
    left: 'TAB_PREV',
    right: 'TAB_NEXT',
    up: 'SCROLL_UP',
    down: 'SCROLL_DOWN'
  }
};

/**
 * Which pose bindings are live right now.
 *
 * Falls back to the main set whenever the split is switched off, so `windowed`
 * costs nothing until someone asks for it.
 */
export function bindingsFor(settings, context) {
  return context === 'windowed' && settings.windowedBindingsEnabled
    ? settings.windowedBindings
    : settings.bindings;
}

/** @see bindingsFor */
export function swipeBindingsFor(settings, context) {
  return context === 'windowed' && settings.windowedBindingsEnabled
    ? settings.windowedSwipeBindings
    : settings.swipeBindings;
}

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
  merged.windowedBindings = {
    ...DEFAULT_SETTINGS.windowedBindings,
    ...(stored?.windowedBindings || {})
  };
  merged.windowedSwipeBindings = {
    ...DEFAULT_SETTINGS.windowedSwipeBindings,
    ...(stored?.windowedSwipeBindings || {})
  };
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
