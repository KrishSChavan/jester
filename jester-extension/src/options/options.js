import {
  ACTIONS,
  CONTEXTS,
  DEFAULT_SETTINGS,
  FULLSCREEN_MODES,
  GESTURES,
  MSG,
  SWIPES,
  POINTER_AIMS,
  loadSettings,
  saveSettings
} from '../common/constants.js';
import { PROVIDERS, normaliseConnection, connectionOrigin } from '../common/credentials.js';
import { PERMISSION_BOUNDARIES } from '../common/agent-permissions.js';
import { localSpeechAvailability } from '../offscreen/voice.js';

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
  paintInputControls();
  if (patchObject.voiceLanguage) refreshSpeech();
}

function bindControls(scope = document) {
  for (const input of scope.querySelectorAll('[data-setting]')) {
    const key = input.dataset.setting;
    writeControl(input, settings[key]);
    if (input.dataset.bound) continue;
    input.dataset.bound = 'true';
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
    // Jester Desktop's actions: nothing in the browser can perform them.
    if (meta.scope === 'os') continue;
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

  select.value = value in ACTIONS && ACTIONS[value].scope !== 'os' ? value : 'NONE';
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
const speechStatus = document.getElementById('speechStatus');
const Speech = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
function fillSelect(select, entries) {
  for (const [id, meta] of Object.entries(entries)) {
    const option = document.createElement('option');
    option.value = id; option.textContent = meta.label; select.append(option);
  }
}
fillSelect(document.getElementById('pointerAim'), POINTER_AIMS);
fillSelect(document.getElementById('agentPermissionBoundary'), PERMISSION_BOUNDARIES);
function paintInputControls() {
  document.getElementById('cursorControls').hidden = !settings.pointerEnabled;
  document.getElementById('eyeControls').hidden = settings.pointerInput === 'voice';
  document.getElementById('pointerAimNote').textContent = POINTER_AIMS[settings.pointerAim]?.hint || '';
  document.getElementById('permissionNote').textContent = PERMISSION_BOUNDARIES[settings.agentPermissionBoundary]?.hint || '';
}
async function refreshMic() {
  try {
    const state = (await navigator.permissions.query({name:'microphone'})).state;
    micDot.className = `dot ${state === 'granted' ? 'running' : 'starting'}`;
    micText.textContent = state === 'granted' ? 'Microphone access granted' : 'Allow microphone access before starting a voice gesture.';
    micGrantBtn.hidden = state === 'granted';
  } catch { micText.textContent = 'Use Allow microphone access to set up voice.'; }
}
async function refreshSpeech() {
  if (!Speech || !Speech.available) {
    speechStatus.textContent = 'This Chrome version does not support on-device speech. Update Chrome to use voice commands.';
    return;
  }
  try {
    const status = await localSpeechAvailability(Speech,settings.voiceLanguage);
    speechStatus.textContent = status === 'available' ? 'On-device speech is ready.' : `Speech pack: ${status}. Use Set up on-device speech to install it.`;
  } catch { speechStatus.textContent = 'Could not check the local speech pack in this browser.'; }
}
micGrantBtn.addEventListener('click', async () => {
  micGrantBtn.disabled = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({audio:true,video:false});
    stream.getTracks().forEach(t => t.stop());
    await refreshMic();
  } catch (err) { micText.textContent = `Microphone request failed: ${err.message}`; }
  finally { micGrantBtn.disabled = false; }
});
document.getElementById('installSpeechBtn').addEventListener('click', async (event) => {
  if (!Speech?.install) { await refreshSpeech(); return; }
  event.currentTarget.disabled = true;
  speechStatus.textContent = 'Installing the local speech pack…';
  try {
    const installed = await Speech.install({langs:[settings.voiceLanguage],processLocally:true});
    speechStatus.textContent = installed ? 'On-device speech is ready.' : 'The language pack could not be installed.';
  } catch (err) { speechStatus.textContent = `Speech setup failed: ${err.message}`; }
  finally { document.getElementById('installSpeechBtn').disabled = false; }
});
document.getElementById('calibrateBtn').addEventListener('click', () => chrome.runtime.sendMessage({type:MSG.OPEN_CALIBRATION}));
document.getElementById('clearCalBtn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({type:MSG.CLEAR_CALIBRATION});
  document.getElementById('calText').textContent = 'Eye calibration cleared. Head-only aiming remains available.';
});

// Model settings contain public metadata only; raw keys are never read back.
const providerSelect = document.getElementById('provider');
const modelStatus = document.getElementById('modelStatus');
const modelQueueStatus = document.getElementById('modelQueueStatus');
const modelConnections = document.getElementById('modelConnections');
const modelIdInput = document.getElementById('modelId');
const modelKeyInput = document.getElementById('apiKey');
let savedConnections = [];
let editingConnectionId = null;
let connectionBusy = false;
let cooldownTimer = null;
let connectionRefresh = 0;
fillSelect(providerSelect, PROVIDERS);
providerSelect.value = 'groq';
function paintProvider() {
  const google = providerSelect.value === 'google';
  document.getElementById('baseUrlField').hidden = providerSelect.value !== 'custom';
  // Only Gemini and Groq have free tiers Jester paces for; the rest report their own limits.
  const freeTier = google || providerSelect.value === 'groq';
  document.getElementById('modelPlanField').hidden = !freeTier;
  if (!freeTier) document.getElementById('modelPlan').value = 'paid';
  else if (!editingConnectionId && document.getElementById('modelPlan').dataset.touched !== 'true') document.getElementById('modelPlan').value = 'free';
  document.getElementById('googleProviderHelp').hidden = !google;
  modelIdInput.placeholder = google ? 'gemini-3.5-flash-lite' : 'Enter your provider’s model ID';
  const list = document.getElementById('modelList');
  list.replaceChildren();
  if (google) {
    const option = document.createElement('option');
    option.value = 'gemini-3.5-flash-lite';
    list.append(option);
  }
}
providerSelect.addEventListener('change', paintProvider);
// A plan the user picked survives switching between Gemini and Groq.
document.getElementById('modelPlan').addEventListener('change', (event) => { event.target.dataset.touched = 'true'; });
function providerName(connection) {
  return PROVIDERS[connection.provider]?.label || connection.provider;
}
function resetModelForm() {
  editingConnectionId = null;
  modelIdInput.value = '';
  document.getElementById('baseUrl').value = '';
  modelKeyInput.value = '';
  delete document.getElementById('modelPlan').dataset.touched;
  document.getElementById('modelFormTitle').textContent = 'Add a model';
  document.getElementById('connectModelBtn').textContent = 'Add model';
  document.getElementById('cancelModelEditBtn').hidden = true;
  document.getElementById('modelEditNote').hidden = true;
  paintProvider();
}
function editModel(connection) {
  editingConnectionId = connection.id;
  providerSelect.value = connection.provider;
  modelIdInput.value = connection.model;
  document.getElementById('baseUrl').value = connection.baseUrl || '';
  modelKeyInput.value = '';
  document.getElementById('modelPlan').value = connection.plan === 'paid' ? 'paid' : 'free';
  document.getElementById('modelFormTitle').textContent = 'Edit model';
  document.getElementById('connectModelBtn').textContent = 'Save changes';
  document.getElementById('cancelModelEditBtn').hidden = false;
  document.getElementById('modelEditNote').hidden = false;
  modelStatus.textContent = `Editing ${providerName(connection)} · ${connection.model}. Enter its API key to save.`;
  paintProvider();
  renderConnections();
  modelKeyInput.focus();
}
function updateCooldownLabels() {
  const now = Date.now();
  const next = savedConnections.find(connection => !(connection.cooldownUntil > now));
  for (const row of modelConnections.children) {
    const connection = savedConnections.find(item => item.id === row.dataset.modelId);
    if (!connection) continue;
    const seconds = Math.max(0, Math.ceil(((connection.cooldownUntil || 0) - now) / 1000));
    const status = row.querySelector('.model-ready');
    status.textContent = seconds ? `Rate limited · ${seconds}s` : connection.id === next?.id ? 'Ready · next' : 'Ready';
    status.classList.toggle('cooling', seconds > 0);
  }
  if (!savedConnections.length) {
    modelQueueStatus.textContent = 'Add a model to run voice tasks. Add more models for automatic fallback.';
  } else if (next) {
    modelQueueStatus.textContent = `${savedConnections.length} ${savedConnections.length === 1 ? 'model' : 'models'} saved. Next: ${providerName(next)} · ${next.model}.`;
  } else {
    const soonest = Math.min(...savedConnections.map(connection => connection.cooldownUntil));
    modelQueueStatus.textContent = `All saved models are rate limited. Next retry in ${Math.max(1, Math.ceil((soonest - now) / 1000))}s.`;
  }
  const waiting = savedConnections.some(connection => connection.cooldownUntil > now);
  if (waiting && !cooldownTimer) cooldownTimer = setInterval(updateCooldownLabels, 1000);
  if (!waiting && cooldownTimer) { clearInterval(cooldownTimer); cooldownTimer = null; }
}
function setConnectionBusy(busy) {
  connectionBusy = busy;
  for (const button of modelConnections.querySelectorAll('button')) {
    button.disabled = busy || button.dataset.unavailable === 'true';
  }
  for (const id of ['connectModelBtn', 'cancelModelEditBtn', 'loadModelsBtn', 'provider', 'modelId', 'baseUrl', 'apiKey', 'modelPlan']) {
    document.getElementById(id).disabled = busy;
  }
}
async function changeConnection(message, success) {
  if (connectionBusy) return;
  setConnectionBusy(true);
  try {
    const reply = await chrome.runtime.sendMessage(message);
    if (!reply?.ok) throw new Error(reply?.detail || 'Could not update saved models.');
    await refreshConnection();
    modelStatus.textContent = success;
  } catch (err) { modelStatus.textContent = err.message; }
  finally { setConnectionBusy(false); }
}
function renderConnections() {
  modelConnections.replaceChildren();
  savedConnections.forEach((connection, index) => {
    const row = document.createElement('li');
    row.className = 'model-connection';
    row.classList.toggle('editing', connection.id === editingConnectionId);
    row.dataset.modelId = connection.id;
    const details = document.createElement('div');
    details.className = 'model-connection-details';
    const name = document.createElement('strong');
    name.textContent = `${providerName(connection)} · ${connection.model}`;
    const meta = document.createElement('div');
    meta.className = 'small muted model-connection-meta';
    meta.textContent = connection.masked || 'Key saved';
    if (connection.provider === 'custom' && connection.baseUrl) meta.textContent += ` · ${connection.baseUrl}`;
    details.append(name, meta);
    const status = document.createElement('span');
    status.className = 'model-ready small';
    const controls = document.createElement('div');
    controls.className = 'model-connection-actions';
    function addButton(label, action, unavailable = false) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.setAttribute('aria-label', `${label}: ${providerName(connection)} ${connection.model}`);
      button.dataset.unavailable = String(unavailable);
      button.disabled = connectionBusy || unavailable;
      button.addEventListener('click', action);
      controls.append(button);
    }
    function move(offset) {
      const ids = savedConnections.map(item => item.id);
      [ids[index], ids[index + offset]] = [ids[index + offset], ids[index]];
      return changeConnection({type:'jester/model-reorder', ids}, 'Model order saved.');
    }
    addButton('Move up', () => move(-1), index === 0);
    addButton('Move down', () => move(1), index === savedConnections.length - 1);
    addButton('Edit', () => editModel(connection));
    addButton('Remove', () => changeConnection({type:'jester/model-clear', id:connection.id}, 'Model removed.'));
    row.append(details, status, controls);
    modelConnections.append(row);
  });
  updateCooldownLabels();
}
async function refreshConnection() {
  const request = ++connectionRefresh;
  try {
    const reply = await chrome.runtime.sendMessage({type:'jester/model-get'});
    if (request !== connectionRefresh) return;
    if (!reply?.ok) throw new Error(reply?.detail || 'Could not load saved models.');
    const config = reply.connection;
    savedConnections = Array.isArray(config?.connections) ? config.connections : [];
    if (editingConnectionId && !savedConnections.some(connection => connection.id === editingConnectionId)) resetModelForm();
    renderConnections();
  } catch (err) {
    if (request === connectionRefresh) modelStatus.textContent = err.message;
  }
}
document.getElementById('connectModelBtn').addEventListener('click', async () => {
  if (connectionBusy) return;
  setConnectionBusy(true);
  try {
    const config = normaliseConnection({provider:providerSelect.value,model:modelIdInput.value,baseUrl:document.getElementById('baseUrl').value,key:modelKeyInput.value,plan:document.getElementById('modelPlan').value});
    if (editingConnectionId) config.id = editingConnectionId;
    // Must be called during this click, before an await loses user activation.
    const granted = await chrome.permissions.request({origins:[connectionOrigin(config)]});
    if (!granted) throw new Error('Provider access was not granted.');
    const reply = await chrome.runtime.sendMessage({type:'jester/model-save',connection:config});
    if (!reply?.ok) throw new Error(reply?.detail || 'Could not save the connection.');
    const edited = !!editingConnectionId;
    resetModelForm();
    await refreshConnection();
    modelStatus.textContent = edited ? 'Model changes saved.' : 'Model added to the fallback order.';
  } catch (err) { modelStatus.textContent = err.message; }
  finally { setConnectionBusy(false); }
});
document.getElementById('cancelModelEditBtn').addEventListener('click', () => {
  resetModelForm();
  modelStatus.textContent = '';
  renderConnections();
});
document.getElementById('loadModelsBtn').addEventListener('click', async () => {
  if (connectionBusy) return;
  setConnectionBusy(true);
  try {
    const matchesProvider = item => item.provider === providerSelect.value
      && (item.provider !== 'custom' || item.baseUrl === document.getElementById('baseUrl').value.trim().replace(/\/$/, ''));
    const matching = savedConnections.filter(matchesProvider);
    const connection = matching.find(item => item.id === editingConnectionId)
      || matching.find(item => item.model === modelIdInput.value.trim()) || matching[0];
    if (!connection) throw new Error('Add a model for this provider first, then use List models with its saved key.');
    const reply = await chrome.runtime.sendMessage({type:'jester/model-list', id:connection.id});
    if (!reply?.ok) throw new Error(reply?.detail || 'Could not list models.');
    const list = document.getElementById('modelList'); list.replaceChildren();
    for (const id of reply.models) { const option = document.createElement('option'); option.value = id; list.append(option); }
    modelStatus.textContent = `Loaded ${reply.models.length} models from ${providerName(connection)}. Choose a model ID and enter its key to save.`;
  } catch (err) { modelStatus.textContent = err.message; }
  finally { setConnectionBusy(false); }
});
paintProvider();
window.addEventListener('focus', refreshConnection);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.modelConnections) refreshConnection();
});

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
          js: ['src/content/agent-page.js', 'src/content/content.js'],
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
  paintInputControls();
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
document.getElementById('pointerSection').hidden = false;

bindControls();
paintContextSplit();
buildGestureTable();
buildSwipeTable();
paintInputControls();
refreshConnection();
refreshSpeech();
refreshCamera();
refreshMic();
refreshAllSites();
refreshFullscreenMode();

// Another surface (the popup) may flip `enabled` while this page is open.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  settings = await loadSettings();
  for (const input of document.querySelectorAll('[data-setting]')) writeControl(input,settings[input.dataset.setting]);
  paintInputControls();
});
