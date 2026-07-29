import {
  ACTIONS,
  DEFAULT_SETTINGS,
  FULLSCREEN_MODES,
  GESTURES,
  MSG,
  SWIPES,
  loadSettings,
  saveSettings
} from '../common/constants.js';

const ALL_SITES = { origins: ['*://*/*'] };
const ALL_SITES_SCRIPT_ID = 'jester-all-sites';
const DEBUGGER = { permissions: ['debugger'] };

let settings = await loadSettings();

// ---------------------------------------------------------------------------
// Generic binding: any input with data-setting is wired to that settings key
// ---------------------------------------------------------------------------

const FORMATTERS = {
  ms: (v) => (v >= 1000 ? `${(v / 1000).toFixed(v % 1000 ? 1 : 0)}s` : `${v} ms`),
  percent: (v) => `${Math.round(v * 100)}%`,
  ratio: (v) => Number(v).toFixed(2),
  seconds: (v) => `${v}s`,
  fps: (v) => `${v} fps`,
  times: (v) => `${Number(v).toFixed(2)}×`
};

function readControl(input) {
  if (input.type === 'checkbox') return input.checked;
  if (input.type === 'range' || input.dataset.type === 'number') return Number(input.value);
  return input.value;
}

function writeControl(input, value) {
  if (input.type === 'checkbox') input.checked = !!value;
  else input.value = value;
  syncOutput(input);
}

function syncOutput(input) {
  const key = input.dataset.setting;
  const output = document.querySelector(`output[data-output="${key}"]`);
  if (!output) return;
  const format = FORMATTERS[input.dataset.format] || String;
  output.textContent = format(readControl(input));
}

let saveTimer = null;
function markSaved() {
  const note = document.getElementById('savedNote');
  note.textContent = 'Saved';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    note.textContent = '';
  }, 1400);
}

async function patch(patchObject) {
  settings = await saveSettings(patchObject);
  markSaved();
}

function bindControls(scope = document) {
  for (const input of scope.querySelectorAll('[data-setting]')) {
    const key = input.dataset.setting;
    writeControl(input, settings[key]);
    input.addEventListener('input', () => syncOutput(input));
    input.addEventListener('change', () => patch({ [key]: readControl(input) }));
  }
}

// ---------------------------------------------------------------------------
// Gesture + swipe binding tables
// ---------------------------------------------------------------------------

function actionSelect(value) {
  const select = document.createElement('select');
  for (const [id, meta] of Object.entries(ACTIONS)) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = meta.label;
    select.append(option);
  }
  select.value = value in ACTIONS ? value : 'NONE';
  return select;
}

function buildGestureTable() {
  const body = document.querySelector('#gestureTable tbody');
  body.replaceChildren();

  for (const gesture of GESTURES) {
    const binding = settings.bindings[gesture.id] || { action: 'NONE', repeat: false };
    const row = document.createElement('tr');

    const name = document.createElement('td');
    name.innerHTML = '<span class="glyph"></span><span></span>';
    name.firstChild.textContent = gesture.glyph;
    name.lastChild.textContent = gesture.label;

    const actionCell = document.createElement('td');
    const select = actionSelect(binding.action);
    actionCell.append(select);

    const repeatCell = document.createElement('td');
    repeatCell.className = 'center';
    const repeat = document.createElement('input');
    repeat.type = 'checkbox';
    repeat.checked = !!binding.repeat;
    repeat.disabled = !ACTIONS[binding.action]?.repeatable;
    repeatCell.append(repeat);

    const commit = () => {
      const action = select.value;
      const repeatable = !!ACTIONS[action]?.repeatable;
      repeat.disabled = !repeatable;
      if (!repeatable) repeat.checked = false;
      patch({
        bindings: { ...settings.bindings, [gesture.id]: { action, repeat: repeat.checked } }
      });
    };

    select.addEventListener('change', commit);
    repeat.addEventListener('change', commit);

    row.append(name, actionCell, repeatCell);
    body.append(row);
  }
}

function buildSwipeTable() {
  const body = document.querySelector('#swipeTable tbody');
  body.replaceChildren();

  for (const swipe of SWIPES) {
    const row = document.createElement('tr');

    const name = document.createElement('td');
    name.innerHTML = '<span class="glyph"></span><span></span>';
    name.firstChild.textContent = swipe.glyph;
    name.lastChild.textContent = swipe.label;

    const actionCell = document.createElement('td');
    const select = actionSelect(settings.swipeBindings[swipe.id]);
    select.addEventListener('change', () =>
      patch({ swipeBindings: { ...settings.swipeBindings, [swipe.id]: select.value } })
    );
    actionCell.append(select);

    row.append(name, actionCell);
    body.append(row);
  }
}

// ---------------------------------------------------------------------------
// Camera permission + device list
// ---------------------------------------------------------------------------

const camDot = document.getElementById('camDot');
const camText = document.getElementById('camText');
const grantBtn = document.getElementById('grantBtn');
const deviceSelect = document.getElementById('deviceSelect');

async function cameraPermission() {
  try {
    const status = await navigator.permissions.query({ name: 'camera' });
    return status.state;
  } catch {
    return 'unknown';
  }
}

async function refreshCamera() {
  const state = await cameraPermission();
  const granted = state === 'granted';

  camDot.className = `dot ${granted ? 'running' : state === 'denied' ? 'error' : 'starting'}`;
  camText.textContent = granted
    ? 'Camera access granted'
    : state === 'denied'
      ? 'Camera access blocked — allow it from the padlock icon in the address bar'
      : 'Camera access not granted yet';
  grantBtn.hidden = granted;

  await refreshDevices(granted);
}

async function refreshDevices(granted) {
  let devices = [];
  try {
    devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  } catch {
    /* ignore */
  }

  deviceSelect.replaceChildren();
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = 'Default camera';
  deviceSelect.append(auto);

  devices.forEach((device, index) => {
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = granted && device.label ? device.label : `Camera ${index + 1}`;
    deviceSelect.append(option);
  });

  deviceSelect.value = devices.some((d) => d.deviceId === settings.cameraDeviceId)
    ? settings.cameraDeviceId
    : '';
}

grantBtn.addEventListener('click', async () => {
  grantBtn.disabled = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    stream.getTracks().forEach((track) => track.stop());
    await chrome.runtime.sendMessage({ type: MSG.RESTART_ENGINE });
  } catch (err) {
    camText.textContent = `Camera request failed: ${err?.message || err}`;
  } finally {
    grantBtn.disabled = false;
    refreshCamera();
  }
});

// ---------------------------------------------------------------------------
// Fullscreen strategy — "true fullscreen" is behind an optional permission
// ---------------------------------------------------------------------------

const fullscreenMode = document.getElementById('fullscreenMode');
const fullscreenNote = document.getElementById('fullscreenNote');

for (const [id, meta] of Object.entries(FULLSCREEN_MODES)) {
  const option = document.createElement('option');
  option.value = id;
  option.textContent = meta.label;
  fullscreenMode.append(option);
}

function paintFullscreenMode() {
  const mode = settings.fullscreenMode in FULLSCREEN_MODES ? settings.fullscreenMode : 'cinema';
  fullscreenMode.value = mode;
  fullscreenNote.textContent = FULLSCREEN_MODES[mode].hint;
}

async function refreshFullscreenMode() {
  // The permission can be revoked from chrome://extensions behind our back.
  if (settings.fullscreenMode === 'debugger' && !(await chrome.permissions.contains(DEBUGGER))) {
    await patch({ fullscreenMode: 'cinema' });
  }
  paintFullscreenMode();
}

fullscreenMode.addEventListener('change', async () => {
  const mode = fullscreenMode.value;
  if (mode === 'debugger' && !(await chrome.permissions.request(DEBUGGER))) {
    paintFullscreenMode();
    return;
  }
  if (mode !== 'debugger') await chrome.permissions.remove(DEBUGGER).catch(() => {});
  await patch({ fullscreenMode: mode });
  paintFullscreenMode();
});

// ---------------------------------------------------------------------------
// Optional "run everywhere" permission
// ---------------------------------------------------------------------------

const allSites = document.getElementById('allSites');
const allSitesNote = document.getElementById('allSitesNote');

async function refreshAllSites() {
  const granted = await chrome.permissions.contains(ALL_SITES);
  allSites.checked = granted;
  allSitesNote.textContent = granted
    ? 'Jester is registered on every site. Reload open tabs for it to take effect.'
    : '';
}

allSites.addEventListener('change', async () => {
  if (allSites.checked) {
    const granted = await chrome.permissions.request(ALL_SITES);
    if (!granted) {
      allSites.checked = false;
      return;
    }
    try {
      await chrome.scripting.registerContentScripts([
        {
          id: ALL_SITES_SCRIPT_ID,
          matches: ['*://*/*'],
          js: ['src/content/content.js'],
          runAt: 'document_idle',
          allFrames: true
        }
      ]);
    } catch {
      /* already registered */
    }
  } else {
    await chrome.scripting.unregisterContentScripts({ ids: [ALL_SITES_SCRIPT_ID] }).catch(() => {});
    await chrome.permissions.remove(ALL_SITES);
  }
  refreshAllSites();
});

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

document.getElementById('resetBtn').addEventListener('click', async () => {
  if (!confirm('Reset every Jester setting back to its default?')) return;
  await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS, enabled: settings.enabled } });
  settings = await loadSettings();
  bindControls();
  buildGestureTable();
  buildSwipeTable();
  refreshCamera();
  refreshFullscreenMode();
  markSaved();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

if (location.hash === '#welcome') document.getElementById('welcome').hidden = false;
if (location.hash === '#camera') {
  document.getElementById('cameraSection').scrollIntoView({ block: 'center' });
}

bindControls();
buildGestureTable();
buildSwipeTable();
refreshCamera();
refreshAllSites();
refreshFullscreenMode();

// Another surface (the popup) may flip `enabled` while this page is open.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  settings = await loadSettings();
  const toggle = document.querySelector('[data-setting="enabled"]');
  if (toggle) toggle.checked = !!settings.enabled;
});
