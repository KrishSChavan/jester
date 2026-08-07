import { MSG, ENGINE, ACTIONS, saveSettings } from '../common/constants.js';
import { loadEnv } from '../common/env.js';

const el = (id) => document.getElementById(id);

const ui = {
  enabled: el('enabled'),
  pointerCard: el('pointerCard'),
  pointerEnabled: el('pointerEnabled'),
  notice: el('notice'),
  statusDot: el('statusDot'),
  statusText: el('statusText'),
  statusMeta: el('statusMeta'),
  statusDetail: el('statusDetail'),
  grantBtn: el('grantBtn'),
  preview: el('preview'),
  previewPlaceholder: el('previewPlaceholder'),
  gestureLabel: el('gestureLabel'),
  gestureScore: el('gestureScore'),
  gestureBar: el('gestureBar'),
  history: el('history'),
  targetState: el('targetState'),
  optionsBtn: el('optionsBtn'),
  restartBtn: el('restartBtn')
};

const STATUS_TEXT = {
  [ENGINE.OFF]: 'Off',
  [ENGINE.STARTING]: 'Starting…',
  [ENGINE.RUNNING]: 'Watching for gestures',
  [ENGINE.SUSPENDED]: 'Paused — no video tab',
  [ENGINE.SLEEPING]: 'Asleep',
  [ENGINE.NO_PERMISSION]: 'Camera access needed',
  [ENGINE.ERROR]: 'Something went wrong'
};

const DOT_CLASS = {
  [ENGINE.RUNNING]: 'running',
  [ENGINE.STARTING]: 'starting',
  [ENGINE.SUSPENDED]: 'starting',
  [ENGINE.SLEEPING]: 'starting',
  [ENGINE.NO_PERMISSION]: 'error',
  [ENGINE.ERROR]: 'error'
};

let previewSeenAt = 0;
let cameraGranted = true;
let lastEngine = {};
let env = { ok: true, error: '', cursor: true, aiOk: true, aiMessage: '' };
/** Set from telemetry, and only when the microphone is in a state worth saying. */
let micProblem = '';
/** The pill is up but this page can't be reached. @see MSG.VOICE_BLOCKED */
let voiceBlocked = false;

const VOICE_BLOCKED_NOTE =
  'Jester can’t draw on this page — it has no content script here. Tick “Also run on ' +
  'every other site” in Settings and reload the tab, or try it on a supported site.';

/**
 * One line, for the most pressing thing wrong. Ordered by how much it stops
 * Jester working: an unreadable .env leaves every flag guessed, a page Jester
 * can't touch means the pill is invisible however well the gesture reads, a
 * blocked microphone leaves the bars dead, and a missing AI key leaves the pill
 * listening to sentences nothing can act on.
 */
function renderNotice() {
  const stale = env.mirrored
    ? 'Flags came from env.txt, not .env — Chrome won’t serve the dotfile here, so re-run ' +
      'build-zip.ps1 after editing .env or the change won’t reach the extension.'
    : '';
  const message = !env.ok
    ? env.error
    : (voiceBlocked && VOICE_BLOCKED_NOTE) || micProblem || stale || (env.aiOk ? '' : env.aiMessage);
  ui.notice.textContent = message;
  ui.notice.hidden = !message;
}

/**
 * The engine lives in an offscreen document, which can't show a camera prompt.
 * Checking the permission here means the popup can tell the user what to do
 * even when the engine is stuck waiting on it.
 */
async function refreshCameraPermission() {
  try {
    const status = await navigator.permissions.query({ name: 'camera' });
    cameraGranted = status.state === 'granted';
    status.onchange = () => {
      cameraGranted = status.state === 'granted';
      renderEngine(lastEngine);
    };
  } catch {
    cameraGranted = true; // can't tell — don't nag
  }
  renderEngine(lastEngine);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderEngine(engine = {}) {
  lastEngine = engine;
  const state = engine.state || ENGINE.OFF;
  const blocked = !cameraGranted;

  ui.statusText.textContent = blocked && state !== ENGINE.ERROR
    ? STATUS_TEXT[ENGINE.NO_PERMISSION]
    : STATUS_TEXT[state] || state;
  ui.statusDot.className = `dot ${blocked ? 'error' : DOT_CLASS[state] || ''}`;
  ui.statusDetail.textContent =
    engine.detail ||
    (blocked ? 'Jester needs camera access before it can start.' : '');
  ui.grantBtn.hidden = !blocked && state !== ENGINE.NO_PERMISSION;
}

function renderTelemetry(t) {
  const mic = t.mic?.detail || (t.mic?.state ? `Microphone: ${t.mic.state}` : '');
  if (mic !== micProblem) {
    micProblem = mic;
    renderNotice();
  }

  // While the pointer owns the hand the bar tracks how closed the pinch is —
  // the readout to tune the pinch distance against.
  let bar = t.progress || 0;

  if (t.sleeping) {
    // The engine masks every pose but the one that wakes it, so a gesture
    // reaching here at all means the way out is being held right now.
    ui.gestureLabel.textContent = t.gesture
      ? '😴 Hold to wake…'
      : `😴 Asleep${t.wake ? ` — ${t.wake} to wake` : ''}`;
    ui.gestureScore.textContent = '';
  } else if (env.cursor && t.pointer?.active) {
    ui.gestureLabel.textContent = t.pointer.down ? '👌 Pinched — click' : '🖐 Pointer — steering';
    ui.gestureScore.textContent = '';
    bar = t.pointer.pinch || 0;
  } else if (env.cursor && t.pointer?.arming) {
    ui.gestureLabel.textContent = '🖐 Pointer — hold it there…';
    ui.gestureScore.textContent = '';
  } else if (t.pointing?.active) {
    ui.gestureLabel.textContent = '☝️ Listening';
    ui.gestureScore.textContent = '';
    bar = 1;
  } else if (t.pointing?.arming) {
    ui.gestureLabel.textContent = '☝️ Hold it there…';
    ui.gestureScore.textContent = '';
  } else if (t.handPresent && t.gesture) {
    ui.gestureLabel.textContent = t.label || t.gesture;
    ui.gestureScore.textContent = `${Math.round((t.score || 0) * 100)}%`;
  } else if (t.handPresent) {
    ui.gestureLabel.textContent = 'Hand detected';
    ui.gestureScore.textContent = '';
  } else {
    ui.gestureLabel.textContent = 'No hand detected';
    ui.gestureScore.textContent = '';
  }
  ui.gestureBar.style.width = `${Math.round(bar * 100)}%`;

  if (t.fps) {
    ui.statusMeta.hidden = false;
    ui.statusMeta.textContent = `${t.fps} fps · ${t.delegate || '—'}`;
  }
}

function renderHistory(entries) {
  ui.history.replaceChildren();
  if (!entries.length) {
    const li = document.createElement('li');
    li.className = 'small muted';
    li.textContent = 'Nothing yet — try holding a closed fist at your camera to pause.';
    ui.history.append(li);
    return;
  }
  for (const entry of entries) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    // Pointer clicks carry their own label — they aren't bindable actions.
    name.textContent = entry.label || ACTIONS[entry.action]?.label || entry.action;
    if (!entry.ok) name.className = 'fail';

    const detail = document.createElement('span');
    detail.className = 'muted';
    detail.textContent = entry.detail || '';

    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = ago(entry.at);

    li.append(name, detail, when);
    ui.history.append(li);
  }
}

function ago(timestamp) {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.round(seconds / 60)}m`;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

ui.enabled.addEventListener('change', () => {
  chrome.runtime.sendMessage({ type: MSG.SET_ENABLED, enabled: ui.enabled.checked });
});

ui.pointerEnabled.addEventListener('change', async () => {
  ui.pointerEnabled.disabled = true;
  try {
    await saveSettings({ pointerEnabled: ui.pointerEnabled.checked });
  } finally {
    ui.pointerEnabled.disabled = false;
  }
});

ui.optionsBtn.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

ui.restartBtn.addEventListener('click', async () => {
  ui.restartBtn.disabled = true;
  await chrome.runtime.sendMessage({ type: MSG.RESTART_ENGINE });
  ui.restartBtn.disabled = false;
});

ui.grantBtn.addEventListener('click', () => {
  // The prompt can only be shown from a full tab, not from this popup.
  chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html#camera') });
  window.close();
});

chrome.runtime.onMessage.addListener((message) => {
  switch (message?.type) {
    case MSG.STATE:
      renderEngine(message.engine);
      return false;
    case MSG.TELEMETRY:
      renderTelemetry(message.telemetry || {});
      return false;
    case MSG.VOICE_BLOCKED:
      voiceBlocked = !!message.blocked;
      renderNotice();
      return false;
    case MSG.PREVIEW_FRAME:
      ui.preview.src = message.dataUrl;
      ui.preview.classList.add('live');
      ui.previewPlaceholder.hidden = true;
      previewSeenAt = Date.now();
      return false;
    case MSG.ACTION_RESULT:
      refreshHistory();
      return false;
    default:
      return false;
  }
});

async function refreshHistory() {
  const { history = [] } = await chrome.storage.session.get('history');
  renderHistory(history);
}

// Ask the engine to keep producing preview frames while this popup is open.
setInterval(() => chrome.runtime.sendMessage({ type: MSG.PREVIEW_PING }).catch(() => {}), 700);
chrome.runtime.sendMessage({ type: MSG.PREVIEW_PING }).catch(() => {});

setInterval(() => {
  if (previewSeenAt && Date.now() - previewSeenAt > 1500) {
    ui.preview.classList.remove('live');
    ui.previewPlaceholder.hidden = false;
    ui.previewPlaceholder.textContent = 'Waiting for camera frames…';
  }
}, 800);

(async () => {
  refreshCameraPermission();

  // Before the first paint: on a CURSOR=false build the card must never flash
  // into view on its way to being removed.
  env = await loadEnv();
  ui.pointerCard.hidden = !env.cursor;
  renderNotice();

  const state = await chrome.runtime.sendMessage({ type: MSG.GET_STATE });
  if (!state) return;
  ui.enabled.checked = !!state.settings.enabled;
  ui.pointerEnabled.checked = !!state.settings.pointerEnabled;
  // The pill may already be up and blocked before this popup was even opened.
  voiceBlocked = !!state.voiceBlocked;
  renderNotice();
  renderEngine(state.engine);
  renderHistory(state.history || []);
  // Which binding set is live is otherwise invisible, and it's the first thing
  // you want to check when a pose does something you didn't expect.
  const context = state.context === 'windowed' ? 'windowed' : 'fullscreen';
  ui.targetState.textContent = `${context} · ${state.hasTarget ? 'video tab found' : 'no video tab'}`;
  if (!state.settings.enabled) {
    ui.previewPlaceholder.textContent = 'Turn Jester on to start the camera.';
  }
})();
