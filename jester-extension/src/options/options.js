import {
  ACTIONS,
  CONTEXTS,
  DEFAULT_SETTINGS,
  FULLSCREEN_MODES,
  GESTURES,
  MSG,
  SWIPES,
  VOICE_PILL_MODES,
  VOICE_PILL_POSITIONS,
  loadSettings,
  saveSettings
} from '../common/constants.js';
import { loadEnv } from '../common/env.js';

const ALL_SITES = { origins: ['*://*/*'] };
const ALL_SITES_SCRIPT_ID = 'jester-all-sites';
const DEBUGGER = { permissions: ['debugger'] };

let settings = await loadSettings();
const env = await loadEnv();

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
//
// Both tables grow a second action column when the fullscreen / windowed split
// is on, so the two sets sit side by side rather than in separate lists you'd
// have to scroll between to compare.
// ---------------------------------------------------------------------------

function actionSelect(value) {
  const select = document.createElement('select');
  const groups = new Map();

  for (const [id, meta] of Object.entries(ACTIONS)) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = meta.label;

    // Ungrouped entries (just "Do nothing") sit at the top level.
    if (!meta.group) {
      select.append(option);
      continue;
    }
    let group = groups.get(meta.group);
    if (!group) {
      group = document.createElement('optgroup');
      group.label = meta.group;
      groups.set(meta.group, group);
      select.append(group);
    }
    group.append(option);
  }

  select.value = value in ACTIONS ? value : 'NONE';
  return select;
}

function headerCell(text, className) {
  const cell = document.createElement('th');
  cell.textContent = text;
  if (className) cell.className = className;
  return cell;
}

function nameCell(glyph, label) {
  const cell = document.createElement('td');
  cell.innerHTML = '<span class="glyph"></span><span></span>';
  cell.firstChild.textContent = glyph;
  cell.lastChild.textContent = label;
  return cell;
}

/** One column per binding set on show — one, or one per context. */
function bindingColumns() {
  if (!settings.windowedBindingsEnabled) {
    return [{ label: 'Action', poses: 'bindings', swipes: 'swipeBindings' }];
  }
  return [
    { label: CONTEXTS.fullscreen.label, poses: 'bindings', swipes: 'swipeBindings' },
    {
      label: CONTEXTS.windowed.label,
      poses: 'windowedBindings',
      swipes: 'windowedSwipeBindings'
    }
  ];
}

/** @returns the action cell and its "repeat while held" cell, already wired. */
function poseCells(gesture, key) {
  const binding = settings[key][gesture.id] || { action: 'NONE', repeat: false };

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
    patch({ [key]: { ...settings[key], [gesture.id]: { action, repeat: repeat.checked } } });
  };

  select.addEventListener('change', commit);
  repeat.addEventListener('change', commit);
  return [actionCell, repeatCell];
}

function swipeCell(swipe, key) {
  const cell = document.createElement('td');
  const select = actionSelect(settings[key][swipe.id]);
  select.addEventListener('change', () =>
    patch({ [key]: { ...settings[key], [swipe.id]: select.value } })
  );
  cell.append(select);
  return cell;
}

function buildGestureTable() {
  const columns = bindingColumns();
  const repeatLabel = columns.length > 1 ? 'Repeat' : 'Repeat while held';

  const head = document.querySelector('#gestureTable thead tr');
  head.replaceChildren(headerCell('Pose'));
  for (const column of columns) {
    head.append(headerCell(column.label), headerCell(repeatLabel, 'center'));
  }

  const body = document.querySelector('#gestureTable tbody');
  body.replaceChildren();
  for (const gesture of GESTURES) {
    const row = document.createElement('tr');
    row.append(nameCell(gesture.glyph, gesture.label));
    for (const column of columns) row.append(...poseCells(gesture, column.poses));
    body.append(row);
  }
}

function buildSwipeTable() {
  const columns = bindingColumns();

  const head = document.querySelector('#swipeTable thead tr');
  head.replaceChildren(headerCell('Direction'));
  for (const column of columns) head.append(headerCell(column.label));

  const body = document.querySelector('#swipeTable tbody');
  body.replaceChildren();
  for (const swipe of SWIPES) {
    const row = document.createElement('tr');
    row.append(nameCell(swipe.glyph, swipe.label));
    for (const column of columns) row.append(swipeCell(swipe, column.swipes));
    body.append(row);
  }
}

// ---------------------------------------------------------------------------
// Fullscreen / windowed split
// ---------------------------------------------------------------------------

const windowedSplit = document.getElementById('windowedSplit');
const contextNote = document.getElementById('contextNote');

function paintContextSplit() {
  windowedSplit.checked = !!settings.windowedBindingsEnabled;
  contextNote.textContent = settings.windowedBindingsEnabled
    ? `${CONTEXTS.fullscreen.label}: ${CONTEXTS.fullscreen.hint} Anything else uses the second column.`
    : 'One set of bindings, used everywhere.';
}

// Wired by hand rather than through `data-setting`, because the tables have to
// be rebuilt against the saved value — not the one still in flight.
windowedSplit.addEventListener('change', async () => {
  await patch({ windowedBindingsEnabled: windowedSplit.checked });
  paintContextSplit();
  buildGestureTable();
  buildSwipeTable();
});

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
// Voice — the pill, and the microphone permission behind it
//
// Same trap as the camera: the engine runs in an offscreen document, which has
// no UI, so Chrome has nowhere to show the prompt. It has to be asked for from
// a real tab, and this is the only one Jester has.
// ---------------------------------------------------------------------------

const micDot = document.getElementById('micDot');
const micText = document.getElementById('micText');
const micGrantBtn = document.getElementById('micGrantBtn');
const voicePillMode = document.getElementById('voicePillMode');
const voicePillPosition = document.getElementById('voicePillPosition');
const voicePillNote = document.getElementById('voicePillNote');

function fillSelect(select, entries) {
  for (const [id, meta] of Object.entries(entries)) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = meta.label;
    select.append(option);
  }
}

// Populated before bindControls() runs, or it would have nothing to set.
fillSelect(voicePillMode, VOICE_PILL_MODES);
fillSelect(voicePillPosition, VOICE_PILL_POSITIONS);

/**
 * Reads the control rather than `settings`, because it also runs from the
 * select's own change handler — where the save is still in flight and
 * `settings` is a moment behind what you just picked.
 */
function paintVoiceMode() {
  const mode = voicePillMode.value in VOICE_PILL_MODES ? voicePillMode.value : 'pointer-finger';
  voicePillNote.textContent = VOICE_PILL_MODES[mode].hint;
  // Position is meaningless with no pill to place.
  voicePillPosition.disabled = mode === 'off';
}

voicePillMode.addEventListener('change', paintVoiceMode);

async function micPermission() {
  try {
    const status = await navigator.permissions.query({ name: 'microphone' });
    return status.state;
  } catch {
    return 'unknown';
  }
}

async function refreshMic() {
  const state = await micPermission();
  const granted = state === 'granted';

  micDot.className = `dot ${granted ? 'running' : state === 'denied' ? 'error' : 'starting'}`;
  micText.textContent = granted
    ? 'Microphone access granted'
    : state === 'denied'
      ? 'Microphone access blocked — allow it from the padlock icon in the address bar'
      : 'Microphone access not granted yet';
  micGrantBtn.hidden = granted;
}

micGrantBtn.addEventListener('click', async () => {
  micGrantBtn.disabled = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    stream.getTracks().forEach((track) => track.stop());
    await chrome.runtime.sendMessage({ type: MSG.RESTART_ENGINE });
  } catch (err) {
    micText.textContent = `Microphone request failed: ${err?.message || err}`;
  } finally {
    micGrantBtn.disabled = false;
    refreshMic();
  }
});

// ---------------------------------------------------------------------------
// AI key — read from .env, checked for shape only. See src/common/env.js.
// ---------------------------------------------------------------------------

function paintAiKey() {
  const dot = document.getElementById('aiDot');
  const text = document.getElementById('aiText');
  if (!env.ok) {
    dot.className = 'dot error';
    text.textContent = env.error;
    return;
  }
  dot.className = `dot ${env.aiOk ? 'running' : 'starting'}`;
  text.textContent = env.aiOk
    ? 'A key is set. It hasn’t been used for anything yet, so it isn’t verified.'
    : env.aiMessage;
}

/**
 * Which file the flags actually came from. Worth showing: if Chrome won't serve
 * the dotfile, edits to `.env` don't reach the extension until build-zip.ps1
 * refreshes the mirror, and there is otherwise nothing to see.
 */
function paintFlagSource() {
  const note = document.getElementById('envSource');
  if (!env.ok) {
    note.textContent = env.error;
    return;
  }
  note.textContent = env.mirrored
    ? 'Flags read from env.txt — Chrome would not serve .env directly. Re-run build-zip.ps1 ' +
      'after editing .env, or your changes won’t reach the extension.'
    : 'Flags read from .env. Edit it and hit Reload on chrome://extensions.';
}

// ---------------------------------------------------------------------------
// Fullscreen strategy — "true fullscreen" is behind an optional permission
// ---------------------------------------------------------------------------

const fullscreenMode = document.getElementById('fullscreenMode');
const fullscreenNote = document.getElementById('fullscreenNote');
const fullscreenBlockedNote = document.getElementById('fullscreenBlockedNote');

for (const [id, meta] of Object.entries(FULLSCREEN_MODES)) {
  const option = document.createElement('option');
  option.value = id;
  option.textContent = meta.label;
  // Shown greyed out rather than dropped, so the reason is visible. @see
  // FULLSCREEN_MODES.debugger.
  option.disabled = !!meta.unavailable;
  fullscreenMode.append(option);
}

const usable = (mode) => mode in FULLSCREEN_MODES && !FULLSCREEN_MODES[mode].unavailable;

function paintFullscreenMode() {
  const mode = usable(settings.fullscreenMode) ? settings.fullscreenMode : 'cinema';
  fullscreenMode.value = mode;
  fullscreenNote.textContent = FULLSCREEN_MODES[mode].hint;

  // Say why the greyed-out entry is greyed out. Without this it just looks broken.
  const blocked = Object.values(FULLSCREEN_MODES).find((m) => m.unavailable);
  fullscreenBlockedNote.textContent = blocked ? blocked.unavailable : '';
  fullscreenBlockedNote.hidden = !blocked;
}

async function refreshFullscreenMode() {
  // Someone upgrading from a build where this was selectable still has it
  // stored, and Chrome may have revoked the permission behind our back either
  // way. Either one puts them back on cinema.
  if (!usable(settings.fullscreenMode) || !(await chrome.permissions.contains(DEBUGGER))) {
    if (settings.fullscreenMode !== 'cinema') await patch({ fullscreenMode: 'cinema' });
  }
  paintFullscreenMode();
}

fullscreenMode.addEventListener('change', async () => {
  const mode = fullscreenMode.value;
  if (!usable(mode)) {
    paintFullscreenMode();
    return;
  }
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
  paintContextSplit();
  buildGestureTable();
  buildSwipeTable();
  paintVoiceMode();
  refreshCamera();
  refreshMic();
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

// The whole feature is gone on a CURSOR=false build, not merely switched off:
// there is nothing to show and nothing to tune.
document.getElementById('pointerSection').hidden = !env.cursor;

bindControls();
paintContextSplit();
buildGestureTable();
buildSwipeTable();
paintVoiceMode();
paintAiKey();
paintFlagSource();
refreshCamera();
refreshMic();
refreshAllSites();
refreshFullscreenMode();

// Another surface (the popup) may flip `enabled` while this page is open.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  settings = await loadSettings();
  const toggle = document.querySelector('[data-setting="enabled"]');
  if (toggle) toggle.checked = !!settings.enabled;
});
