import { MSG, ENGINE, ACTIONS } from '../common/constants.js';

const el = (id) => document.getElementById(id);

const ui = {
  enabled: el('enabled'),
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
  [ENGINE.NO_PERMISSION]: 'Camera access needed',
  [ENGINE.ERROR]: 'Something went wrong'
};

const DOT_CLASS = {
  [ENGINE.RUNNING]: 'running',
  [ENGINE.STARTING]: 'starting',
  [ENGINE.SUSPENDED]: 'starting',
  [ENGINE.NO_PERMISSION]: 'error',
  [ENGINE.ERROR]: 'error'
};

let previewSeenAt = 0;
let cameraGranted = true;
let lastEngine = {};

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
  // While the pointer owns the hand the bar tracks how closed the pinch is —
  // the readout to tune the pinch distance against.
  let bar = t.progress || 0;

  if (t.pointer?.active) {
    ui.gestureLabel.textContent = t.pointer.down ? '👌 Pinched — click' : '🖐 Pointer — steering';
    ui.gestureScore.textContent = '';
    bar = t.pointer.pinch || 0;
  } else if (t.pointer?.arming) {
    ui.gestureLabel.textContent = '🖐 Pointer — hold it there…';
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
  const state = await chrome.runtime.sendMessage({ type: MSG.GET_STATE });
  if (!state) return;
  ui.enabled.checked = !!state.settings.enabled;
  renderEngine(state.engine);
  renderHistory(state.history || []);
  ui.targetState.textContent = state.hasTarget ? 'video tab found' : 'no video tab';
  if (!state.settings.enabled) {
    ui.previewPlaceholder.textContent = 'Turn Jester on to start the camera.';
  }
})();
