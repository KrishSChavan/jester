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
 * Eyes/head aim the page cursor. An open palm raises it, and closing that
 * hand into a fist clicks. A bound gesture starts voice command capture; it
 * stays active after the hand is lowered and finishes when speech stops.
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

  /**
   * Not an off switch — a full stop that the *same* gesture lifts.
   *
   * Asleep, the camera stays open and the frame loop keeps running, because the
   * only thing that can wake Jester is seeing the pose or swipe that put it
   * under. Nothing else is looked at: no other binding fires, the pointer never
   * arms, and the microphone is released. From the page's side that is
   * indistinguishable from being switched off, with the one difference that
   * matters — you can get back out of it with your hands.
   *
   * The way back deliberately ignores the bindings while it's in force, so a
   * fullscreen change (which swaps the whole set) can't strand you.
   */
  VOICE_CAPTURE_TOGGLE: { label: 'Start / stop voice command', repeatable: false, scope: 'system', group: 'Jester' },
  CALIBRATE_POINTER: { label: 'Calibrate the eye pointer', repeatable: false, scope: 'system', group: 'Jester' },
  SLEEP: { label: 'Sleep / wake Jester', repeatable: false, scope: 'system', group: 'Jester' }
};

/** Voice is activated explicitly by a bound gesture or the toolbar control. */
export const VOICE_PILL_MODES = { gesture: { label: 'Start with a gesture', hint: 'A bound gesture starts a command. Speak, then pause to send it; repeat the gesture to finish.' } };

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
  // offscreen -> service worker: a finished utterance. The pill has come down
  // (or the talking has stopped in `always` mode) and these are the words the
  // assistant should act on.
  VOICE_COMMAND: 'jester/voice-command',
  VOICE_CONTROL: 'jester/voice-control',
  CALIBRATION_MODE: 'jester/calibration-mode',
  CALIBRATION_FEED: 'jester/calibration-feed',
  CALIBRATION_SAVED: 'jester/calibration-saved',
  CALIBRATION_MODEL: 'jester/calibration-model',
  GET_CALIBRATION: 'jester/get-calibration',
  CLEAR_CALIBRATION: 'jester/clear-calibration',
  OPEN_CALIBRATION: 'jester/open-calibration',
  // service worker -> popup: the pill is up but the page in front can't be
  // reached, so there is nothing to draw it on. Silent otherwise — you'd be left
  // holding a gesture that the popup says is working, at a page that never
  // responds.
  VOICE_BLOCKED: 'jester/voice-blocked',
  // service worker <-> content script: the assistant's two halves — roughly
  // where am I, and go and do this. @see src/background/assistant.js
  PAGE_DIGEST: 'jester/page-digest',
  RUN_STEPS: 'jester/run-steps',
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
  VIEW_CONTEXT: 'jester/view-context',
  // content script -> service worker: "this tab is / isn't being shown". Chrome's
  // occlusion tracking is what makes this worth having — a window buried under
  // another one still reports itself focused to the windows API, and this is the
  // only reading that notices. Still worth sending when `actWhenOutOfView` is on
  // and actions ignore it: the cursor and the pill don't, and the worker's cache
  // has to be dropped either way. @see frontTab
  VIEW_VISIBILITY: 'jester/view-visibility'
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
  // Watching for exactly one gesture — the one that put it here. @see ACTIONS.SLEEP
  SLEEPING: 'sleeping',
  NO_PERMISSION: 'no-permission',
  ERROR: 'error'
};

export const POINTER_AIMS = {
  auto: { label: 'Eyes and head (automatic)', hint: 'Look to place the cursor, then move your head to fine-tune it. Requires calibration; uses head alone at a distance.' },
  head: { label: 'Head only', hint: 'Turn your head to aim. No calibration needed.' },
  eyes: { label: 'Eyes only', hint: 'Look to aim. Requires calibration.' }
};
export const POINTER_INPUTS = {
  voice: { label: 'Voice', hint: 'Speak a command to point or click.' },
  'eyes-head': { label: 'Eyes / head', hint: 'Raise an open palm, aim with eyes or head, and close your hand to click.' },
  both: { label: 'Both', hint: 'Aim with eyes or head, then click with your voice or a closing hand.' }
};
export const SETTINGS_VERSION = 6;

export const DEFAULT_SETTINGS = {
  settingsVersion: SETTINGS_VERSION,
  enabled: false,

  // --- camera ---
  cameraDeviceId: '',
  mirrorPreview: true,

  // --- inference ---
  targetFps: 20,
  delegate: 'GPU', // 'GPU' | 'CPU' — falls back to CPU automatically on failure
  numHands: 2,
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

  // --- page cursor: eyes/head aim, open palm engages, fist clicks ---
  pointerEnabled: true,
  pointerInput: 'eyes-head',
  pointerAim: 'auto',
  pointerArmMs: 500,
  pointerSmoothing: 0.5,
  headSpeed: 1,
  longRange: true,

  // Voice is command capture only; it never inserts dictated text into fields.
  voiceEnabled: true,
  voiceLanguage: 'en-US',
  agentPermissionBoundary: 'entertainment',
  /**
   * Voice tasks click and type with Chrome's own mouse and keyboard through
   * chrome.debugger, as Claude in Chrome does, so sites see trusted input. Chrome
   * shows its debugging bar for the length of a task. Off: synthetic page events.
   */
  agentRealInput: true,
  /**
   * When the page text is not enough, the agent may look at one screenshot with
   * numbered labels, at most three per task, never with a password or payment
   * field visible, and only through a saved model that can read images.
   */
  agentScreenshots: true,
  voicePillMode: 'gesture',
  voicePillPosition: 'bottom-center',

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

  // --- where actions land ---

  /**
   * Off by default, because an action you can't see is indistinguishable from
   * one that didn't fire: left off, a gesture aimed at a Chrome that is behind
   * another application, minimized or covered over does nothing at all, and you
   * find out by looking at the window rather than by wondering.
   *
   * On, that same gesture lands on the last tab you were using — which is the
   * whole point when a film is playing on the other monitor and you only want to
   * pause it. Actions follow this setting; the cursor and the voice pill never
   * do, because both are aimed by eye. @see frontTab
   */
  actWhenOutOfView: false,

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
    Pointing_Up: { action: 'VOICE_CAPTURE_TOGGLE', repeat: false },
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
    Pointing_Up: { action: 'VOICE_CAPTURE_TOGGLE', repeat: false },
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
export function resumesStandby(settings, kind, id) {
  if (kind === 'swipe' && !settings.swipeEnabled) return false;
  return Object.keys(CONTEXTS).some((context) => kind === 'swipe' ? swipeBindingsFor(settings, context)[id] === 'SLEEP' : bindingsFor(settings, context)[id]?.action === 'SLEEP');
}
export function resumeGlyphs(settings) {
  return [...GESTURES.filter((g) => resumesStandby(settings, 'pose', g.id)), ...SWIPES.filter((g) => resumesStandby(settings, 'swipe', g.id))].map((g) => g.glyph).join(' or ');
}

export async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return mergeSettings(settings);
}

/**
 * Actions that have been renamed, and what they became.
 *
 * `DISABLE` stopped the camera outright, which left no gesture able to undo it.
 * `SLEEP` is the same idea with a way back, so anyone who had bound it keeps the
 * gesture they picked for "stop reacting to me" rather than finding it silently
 * unbound after an update.
 */
const RENAMED_ACTIONS = { DISABLE: 'SLEEP', STANDBY_TOGGLE: 'SLEEP' };

const renameAction = (action) => RENAMED_ACTIONS[action] || action;

export function mergeSettings(stored) {
  const merged = { ...DEFAULT_SETTINGS, ...(stored || {}) };
  merged.bindings = migratePoseBindings({ ...DEFAULT_SETTINGS.bindings, ...(stored?.bindings || {}) });
  merged.swipeBindings = migrateSwipeBindings({
    ...DEFAULT_SETTINGS.swipeBindings,
    ...(stored?.swipeBindings || {})
  });
  merged.windowedBindings = migratePoseBindings({
    ...DEFAULT_SETTINGS.windowedBindings,
    ...(stored?.windowedBindings || {})
  });
  merged.windowedSwipeBindings = migrateSwipeBindings({
    ...DEFAULT_SETTINGS.windowedSwipeBindings,
    ...(stored?.windowedSwipeBindings || {})
  });
  // Migrate only the previous shipped defaults; custom gesture choices survive.
  if (Number(stored?.settingsVersion || 0) < SETTINGS_VERSION) {
    for (const [key, previous] of [['bindings', 'SKIP_AD'], ['windowedBindings', 'PAGE_TOP']]) {
      if (merged[key].Pointing_Up?.action === previous) merged[key].Pointing_Up = { action: 'VOICE_CAPTURE_TOGGLE', repeat: false };
    }
  }
  merged.settingsVersion = SETTINGS_VERSION;
  if (!Object.hasOwn(POINTER_AIMS, merged.pointerAim)) merged.pointerAim = DEFAULT_SETTINGS.pointerAim;
  if (!Object.hasOwn(POINTER_INPUTS, merged.pointerInput)) merged.pointerInput = DEFAULT_SETTINGS.pointerInput;
  if (!['ask','entertainment','site'].includes(merged.agentPermissionBoundary)) merged.agentPermissionBoundary = 'entertainment';
  merged.voicePillMode = 'gesture';
  merged.voicePillPosition = 'bottom-center';
  merged.voiceEnabled = merged.voiceEnabled !== false;
  merged.agentRealInput = merged.agentRealInput !== false;
  merged.agentScreenshots = merged.agentScreenshots !== false;
  merged.voiceLanguage = typeof merged.voiceLanguage === 'string' && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(merged.voiceLanguage) ? merged.voiceLanguage : 'en-US';
  for (const key of ['pointerTolerance', 'pointerPinchDistance', 'pointerRangeX', 'pointerRangeY']) delete merged[key];
  for (const [key, [lo, hi]] of Object.entries({ headSpeed: [.4, 2.5], pointerArmMs: [250, 1500], pointerSmoothing: [0, 1], numHands: [1, 2] })) {
    const value = Number(merged[key]);
    merged[key] = Number.isFinite(value) ? Math.max(lo, Math.min(hi, value)) : DEFAULT_SETTINGS[key];
  }
  merged.numHands = Math.round(merged.numHands);
  return merged;
}

/** @see RENAMED_ACTIONS */
function migratePoseBindings(bindings) {
  const out = {};
  for (const [gesture, binding] of Object.entries(bindings)) {
    const action = renameAction(binding?.action);
    out[gesture] = { action: Object.hasOwn(ACTIONS, action) ? action : 'NONE', repeat: !!binding?.repeat && !!ACTIONS[action]?.repeatable };
  }
  return out;
}

/** @see RENAMED_ACTIONS */
function migrateSwipeBindings(bindings) {
  const out = {};
  for (const [direction, action] of Object.entries(bindings)) {
    out[direction] = renameAction(action);
  }
  return out;
}

let saveChain = Promise.resolve();
export function saveSettings(patch) {
  const result = saveChain.then(async () => {
    const current = await loadSettings();
    const next = mergeSettings({ ...current, ...patch });
    await chrome.storage.local.set({ settings: next });
    return next;
  });
  saveChain = result.catch(() => undefined);
  return result;
}

/** `chrome.runtime.sendMessage` that stays quiet when nobody is listening. */
export function post(message) {
  return chrome.runtime.sendMessage(message).catch(() => undefined);
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
