/**
 * Jester Desktop's Settings window.
 *
 * Settings live in `chrome.storage.local` exactly as in the extension (the
 * preload's shim carries them to the main process), so the engine picks up a
 * change the way it does in Chrome. Permissions and the engine's state come
 * from the main process as `jester/desktop-state` messages.
 */

import { ACTIONS, ENGINE, GESTURES, POINTER_AIMS, SWIPES, mergeSettings } from '../ext/src/common/constants.js';
import { PROVIDERS } from '../ext/src/common/credentials.js';
import { calibrationGrade, loadCalibration, usableModel } from '../ext/src/common/gaze-store.js';
import { DESKTOP_LABELS, bindable, describePlan, parseShortcut } from '../main/os-actions.js';

const $ = (id) => document.getElementById(id);
const SHORTCUTS = ['SHORTCUT_1', 'SHORTCUT_2', 'SHORTCUT_3'];

const STATUS = {
  [ENGINE.OFF]: ['Off', 'idle'],
  [ENGINE.STARTING]: ['Starting…', 'warn'],
  [ENGINE.RUNNING]: ['Watching for gestures', 'ok'],
  [ENGINE.SUSPENDED]: ['Paused', 'idle'],
  [ENGINE.SLEEPING]: ['Asleep — make your wake gesture', 'idle'],
  [ENGINE.NO_PERMISSION]: ['Camera access needed', 'bad'],
  [ENGINE.ERROR]: ['Something went wrong', 'bad']
};

const PERMISSION_STATE = {
  granted: ['Allowed', 'granted'],
  'not-determined': ['Not allowed yet', 'missing'],
  denied: ['Turned off in System Settings', 'denied'],
  restricted: ['Blocked by a device policy', 'denied'],
  unknown: ['Unknown', 'missing']
};

const TIER = { needed: 'Needed', recommended: 'Recommended', later: 'Later' };

let settings = null;
let desktop = null;

async function readSettings() {
  const { settings: stored } = await chrome.storage.local.get('settings');
  return mergeSettings(stored);
}

async function save(patch) {
  const before = settings;
  settings = mergeSettings({ ...(await readSettings()), ...patch });
  await chrome.storage.local.set({ settings });
  settingsChanged(before);
}

/** The menus name your shortcuts, so a new shortcut means new menus. */
function settingsChanged(before) {
  if (JSON.stringify(before?.desktopShortcuts || {}) !== JSON.stringify(settings.desktopShortcuts || {})) buildBindings();
  renderControls();
  renderBindings();
}

function renderStatus() {
  const engine = desktop?.engine || { state: ENGINE.OFF };
  const [text, tone] = settings && !settings.enabled ? ['Jester is off', 'idle'] : STATUS[engine.state] || [engine.state, 'idle'];
  $('status-text').textContent = engine.state === ENGINE.ERROR && engine.detail ? `${text}: ${engine.detail}` : text;
  $('status').dataset.tone = tone;
  // The last frame rate means nothing once the camera has stopped.
  if (![ENGINE.RUNNING, ENGINE.SLEEPING].includes(engine.state) || (settings && !settings.enabled)) $('camera-stats').textContent = '—';
}

function renderPermissions() {
  const items = desktop?.permissions || [];
  const missing = items.filter((item) => item.tier === 'needed' && !item.granted);
  $('permissions-intro').textContent = missing.length
    ? `Jester needs ${missing.map((item) => item.label).join(' and ')} to work. Everything it sees and hears stays on this computer.`
    : 'Everything Jester needs is allowed. Camera frames and audio stay on this computer.';
  $('permissions').replaceChildren(
    ...items.map((item) => {
      const li = document.createElement('li');
      li.className = `permission${item.granted ? ' granted' : ''}`;
      const [stateText, stateTone] = PERMISSION_STATE[item.status] || PERMISSION_STATE.unknown;
      // Something not used yet is no cause for alarm.
      const stateClass = item.tier === 'later' && !item.granted ? 'later' : stateTone;

      const text = document.createElement('div');
      text.className = 'text';
      const title = document.createElement('div');
      title.className = 'title';
      const name = document.createElement('strong');
      name.textContent = item.label;
      const badge = document.createElement('span');
      badge.className = `badge ${item.tier}`;
      badge.textContent = TIER[item.tier];
      title.append(name, badge);
      const why = document.createElement('small');
      why.textContent = item.why;
      text.append(title, why);

      const actions = document.createElement('div');
      actions.className = 'actions';
      const state = document.createElement('span');
      state.className = `state ${stateClass}`;
      state.textContent = stateText;
      actions.append(state);
      if (item.action) {
        const button = document.createElement('button');
        button.className = item.tier === 'needed' ? 'primary' : '';
        button.textContent = item.action === 'request' ? 'Allow…' : 'Open Settings';
        button.addEventListener('click', async () => {
          button.disabled = true;
          desktop = await chrome.runtime.sendMessage({ type: 'jester/desktop-permission', id: item.id, action: item.action });
          render();
        });
        actions.append(button);
      }
      li.append(text, actions);
      return li;
    })
  );
}

/** Which camera is in use, from the engine: "Default camera" hides which one that is. */
function renderCameraHint(cameras = null) {
  if (cameras) renderCameraHint.named = cameras.some((camera) => camera.label);
  $('camera-hint').textContent = desktop?.engine?.camera
    ? `Watching: ${desktop.engine.camera}.`
    : renderCameraHint.named === false
      ? 'Names appear once the camera is allowed.'
      : 'The camera Jester watches.';
}

async function renderCameras() {
  const select = $('cameraDeviceId');
  let cameras = [];
  try {
    cameras = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'videoinput');
  } catch {
    cameras = [];
  }
  const options = [['', 'Default camera'], ...cameras.map((camera, i) => [camera.deviceId, camera.label || `Camera ${i + 1}`])];
  select.replaceChildren(...options.map(([value, label]) => new Option(label, value)));
  select.value = settings?.cameraDeviceId || '';
  // Without camera permission the browser hides camera names.
  renderCameraHint(cameras);
}

function renderControls() {
  if (!settings) return;
  $('enabled').checked = !!settings.enabled;
  $('pointerEnabled').checked = !!settings.pointerEnabled;
  $('pointerEnabled').disabled = !settings.enabled;
  renderVoice();
  const cursorOff = !settings.enabled || !settings.pointerEnabled;
  const aim = $('pointerAim');
  if (!aim.options.length) aim.replaceChildren(...Object.entries(POINTER_AIMS).map(([value, meta]) => new Option(meta.label, value)));
  aim.value = settings.pointerAim;
  aim.disabled = cursorOff;
  $('pointerAim-hint').textContent = POINTER_AIMS[settings.pointerAim]?.hint || '';
  $('headSpeed').value = String(settings.headSpeed);
  $('headSpeed').disabled = cursorOff || settings.pointerAim === 'eyes';
  $('calibrate').disabled = cursorOff;
  renderStatus();
}

/** How to start a command: the gesture bound to voice, if any, and the shortcut. */
function voiceStarters() {
  const shortcut = platform() === 'darwin' ? '⌥⇧J' : 'Alt+Shift+J';
  const [pose] = Object.entries(settings.bindings || {}).find(([, binding]) => binding?.action === 'VOICE_CAPTURE_TOGGLE') || [];
  const gesture = GESTURES.find((item) => item.id === pose);
  return gesture ? `${gesture.glyph} ${gesture.label} or ${shortcut}` : shortcut;
}

/** The voice switch, and what voice needs or does: the speech model's state comes from the main process. */
function renderVoice() {
  const voice = desktop?.voice || 'missing';
  const missing = voice === 'missing';
  $('voiceEnabled').checked = !!settings.voiceEnabled && !missing;
  $('voiceEnabled').disabled = !settings.enabled || missing;
  $('voice-row').classList.toggle('disabled', missing);
  $('voice-hint').textContent = missing
    ? 'Needs its speech model, which isn’t installed. In desktop/, run: npm run models'
    : `${voiceStarters()} starts a command: say “open Spotify”, “volume 30”, “type hello”. Speech is recognized on this computer.`;
  renderSpeechModel(missing);
}

/** Which recognizer hears commands; one not downloaded yet is listed, and says how to get it. */
function renderSpeechModel(missing) {
  const choices = desktop?.speechChoices || [];
  $('speech-model-row').hidden = missing || !choices.length;
  const select = $('speechModel');
  select.replaceChildren(...choices.map((choice) => {
    const option = new Option(choice.installed ? choice.label : `${choice.label} (not downloaded)`, choice.id);
    option.disabled = !choice.installed;
    return option;
  }));
  select.value = desktop?.speechModel || '';
  select.disabled = !settings.enabled || !settings.voiceEnabled;
  const chosen = choices.find((choice) => choice.id === desktop?.speechModel);
  const absent = choices.find((choice) => !choice.installed);
  $('speech-model-hint').textContent = [chosen?.hint, absent && `To add ${absent.label}, in desktop/ run: npm run models -- ${absent.id}`].filter(Boolean).join(' ');
}

/** Whether the eyes are calibrated, and how well, from the extension's own grading. */
async function renderCalibration() {
  const model = await loadCalibration().catch(() => null);
  if (!model) {
    $('calibration-state').textContent = settings?.pointerAim === 'head' ? 'Not needed to aim with the head.' : 'Not calibrated yet. Head aiming works without it.';
    return;
  }
  if (!usableModel(model)) {
    $('calibration-state').textContent = 'Out of date — calibrate again.';
    return;
  }
  const grade = calibrationGrade(model.error);
  $('calibration-state').textContent = `Calibrated (${grade.grade})${model.screenW ? ` for a ${model.screenW}×${model.screenH} screen` : ''}. ${grade.hint}`;
}

// ---------------------------------------------------------------------------
// The assistant's models
// ---------------------------------------------------------------------------

/** Examples for the model field: fast models suit one-step-at-a-time work. */
const MODEL_EXAMPLES = { google: 'gemini-2.5-flash', groq: 'openai/gpt-oss-120b', openai: 'gpt-5-mini', anthropic: 'claude-haiku-5-5', custom: '' };

/** Asks the main process, which alone holds the keys; the reply lists them masked. */
async function connections(op, extra = {}) {
  const reply = await chrome.runtime.sendMessage({ type: 'jester/desktop-connections', op, ...extra });
  renderConnections(reply);
  return reply;
}

function renderConnections(reply) {
  const saved = reply?.connections || [];
  $('connection-error').textContent = reply?.ok === false ? reply.error : '';
  if (!saved.length) {
    const empty = document.createElement('div');
    empty.className = 'row';
    empty.innerHTML = '<span><strong>No model yet</strong><small>Add one below to let the assistant take commands Jester doesn’t know.</small></span>';
    $('connections').replaceChildren(empty);
    return;
  }
  $('connections').replaceChildren(
    ...saved.map((connection, i) => {
      const row = document.createElement('div');
      row.className = 'row';
      const text = document.createElement('span');
      const name = document.createElement('strong');
      name.textContent = `${PROVIDERS[connection.provider]?.label || connection.provider} · ${connection.model}`;
      const detail = document.createElement('small');
      const resting = connection.cooldownUntil > Date.now() ? ` · resting until ${new Date(connection.cooldownUntil).toLocaleTimeString()}` : '';
      detail.textContent = `${connection.masked} · ${connection.plan === 'free' ? 'Free' : 'Paid'}${saved.length > 1 && i === 0 ? ' · tried first' : ''}${resting}`;
      text.append(name, detail);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Remove';
      remove.addEventListener('click', () => connections('remove', { id: connection.id }));
      row.append(text, remove);
      return row;
    })
  );
}

function buildConnectionForm() {
  const provider = $('connection-provider');
  provider.replaceChildren(...Object.entries(PROVIDERS).map(([id, meta]) => new Option(meta.label, id)));
  const fit = () => {
    $('connection-model').placeholder = MODEL_EXAMPLES[provider.value] ? `e.g. ${MODEL_EXAMPLES[provider.value]}` : 'The model’s ID';
    $('connection-url-row').hidden = provider.value !== 'custom';
    $('connection-plan').value = ['google', 'groq'].includes(provider.value) ? 'free' : 'paid';
  };
  provider.addEventListener('change', fit);
  fit();
  $('connection-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('connection-add').disabled = true;
    const reply = await connections('save', {
      input: { provider: provider.value, model: $('connection-model').value, key: $('connection-key').value, plan: $('connection-plan').value, baseUrl: $('connection-url').value }
    });
    $('connection-add').disabled = false;
    // The key isn't kept in the page once it's saved.
    if (reply?.ok) $('connection-key').value = '';
  });
}

// ---------------------------------------------------------------------------
// Gestures and shortcuts
// ---------------------------------------------------------------------------

const platform = () => desktop?.platform || 'darwin';

function actionLabel(id) {
  if (SHORTCUTS.includes(id)) {
    const plan = parseShortcut(settings?.desktopShortcuts?.[id]);
    return `${ACTIONS[id].label} — ${plan ? describePlan(plan, platform()) : 'not set yet'}`;
  }
  return DESKTOP_LABELS[id] || ACTIONS[id]?.label || id;
}

/** Only what can happen on this computer, grouped as in the extension. */
function actionSelect() {
  const select = document.createElement('select');
  select.append(new Option(ACTIONS.NONE.label, 'NONE'));
  const groups = new Map();
  for (const [id, meta] of Object.entries(ACTIONS)) {
    if (!meta.group || !bindable(id, platform())) continue;
    let group = groups.get(meta.group);
    if (!group) {
      group = document.createElement('optgroup');
      group.label = meta.group;
      groups.set(meta.group, group);
      select.append(group);
    }
    group.append(new Option(actionLabel(id), id));
  }
  return select;
}

/** One pose or swipe: what it does, and for poses whether holding it repeats. */
function bindingRow(gesture, set, type) {
  const key = type === 'pose' ? (set === 'main' ? 'bindings' : 'windowedBindings') : set === 'main' ? 'swipeBindings' : 'windowedSwipeBindings';
  const row = document.createElement('div');
  row.className = 'row binding';
  const name = document.createElement('span');
  name.className = 'gesture';
  const glyph = document.createElement('span');
  glyph.className = 'glyph';
  glyph.textContent = gesture.glyph;
  const label = document.createElement('span');
  label.style.display = 'flex';
  label.style.flexDirection = 'column';
  const title = document.createElement('strong');
  title.textContent = gesture.label;
  const hint = document.createElement('small');
  label.append(title, hint);
  name.append(glyph, label);

  const controls = document.createElement('span');
  controls.className = 'controls';
  const select = actionSelect();
  select.setAttribute('aria-label', `${gesture.label} does`);
  controls.append(select);
  // Swipes get the same box, never shown, so every menu lines up.
  const wrap = document.createElement('label');
  wrap.className = type === 'pose' ? 'repeat' : 'repeat unavailable';
  const repeatBox = document.createElement('input');
  repeatBox.type = 'checkbox';
  wrap.append(repeatBox, document.createTextNode('Repeat'));
  wrap.title = 'Keep doing it while you hold the pose';
  controls.append(wrap);
  const repeat = type === 'pose' ? repeatBox : null;
  if (!repeat) repeatBox.tabIndex = -1;
  row.append(name, controls);

  const current = () => (type === 'pose' ? settings[key][gesture.id] : { action: settings[key][gesture.id] });
  select.addEventListener('change', () => {
    const action = select.value;
    const value = type === 'pose' ? { action, repeat: !!repeat?.checked && !!ACTIONS[action]?.repeatable } : action;
    save({ [key]: { ...settings[key], [gesture.id]: value } });
  });
  repeat?.addEventListener('change', () => save({ [key]: { ...settings[key], [gesture.id]: { action: current().action, repeat: repeat.checked } } }));

  return {
    element: row,
    update() {
      const { action = 'NONE', repeat: repeating = false } = current() || {};
      // Bound to something this computer can't do (set in the extension, say): show it, greyed.
      if (![...select.options].some((option) => option.value === action)) {
        const option = new Option(`${actionLabel(action)} (not on this computer)`, action);
        option.disabled = true;
        select.append(option);
      }
      select.value = action;
      if (repeat) {
        const repeatable = !!ACTIONS[action]?.repeatable;
        repeat.checked = repeatable && repeating;
        repeat.parentElement.classList.toggle('unavailable', !repeatable);
      }
      hint.textContent = gesture.id === 'Open_Palm' && settings.pointerEnabled ? 'Raises the cursor while cursor control is on' : '';
    }
  };
}

let bindingRows = [];

function buildBindings() {
  bindingRows = [];
  for (const set of ['main', 'windowed']) {
    const rows = [...GESTURES.map((pose) => bindingRow(pose, set, 'pose')), ...SWIPES.map((swipe) => bindingRow(swipe, set, 'swipe'))];
    $(set === 'main' ? 'bindings-main' : 'bindings-windowed').replaceChildren(...rows.map((row) => row.element));
    bindingRows.push(...rows);
  }
}

function renderBindings() {
  if (!settings || !bindingRows.length) return;
  for (const row of bindingRows) row.update();
  const split = !!settings.windowedBindingsEnabled;
  $('windowedBindingsEnabled').checked = split;
  $('windowed-block').hidden = !split;
  $('gestures-intro').textContent = split
    ? 'While a window fills the screen. Hold a pose until its bar fills.'
    : 'What each pose and swipe does. Hold a pose until its bar fills.';
}

function buildShortcuts() {
  $('shortcuts').replaceChildren(
    ...SHORTCUTS.map((id, i) => {
      const row = document.createElement('label');
      row.className = 'row shortcut';
      const name = document.createElement('strong');
      name.textContent = `Shortcut ${i + 1}`;
      const controls = document.createElement('span');
      controls.className = 'controls';
      const shown = document.createElement('span');
      shown.className = 'shown';
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = platform() === 'darwin' ? 'cmd+shift+4' : 'ctrl+alt+t';
      input.spellcheck = false;
      input.value = settings.desktopShortcuts?.[id] || '';
      const check = () => {
        const text = input.value.trim();
        const plan = parseShortcut(text);
        input.setAttribute('aria-invalid', String(!!text && !plan));
        shown.textContent = text ? (plan ? describePlan(plan, platform()) : 'Not a shortcut') : '';
        return { text, plan };
      };
      input.addEventListener('input', check);
      input.addEventListener('change', () => {
        const { text, plan } = check();
        if (text && !plan) return;
        const next = { ...(settings.desktopShortcuts || {}) };
        if (text) next[id] = text;
        else delete next[id];
        save({ desktopShortcuts: next });
      });
      check();
      controls.append(shown, input);
      row.append(name, controls);
      return row;
    })
  );
}

function render() {
  renderStatus();
  renderPermissions();
  renderControls();
  renderBindings();
  renderCameraHint();
  $('dev-note').hidden = !desktop?.fakeMedia;
}

function gestureName(message) {
  if (message.source === 'swipe') {
    const swipe = SWIPES.find((item) => item.id === message.gesture);
    return swipe ? `${swipe.glyph} ${swipe.label}` : `Swipe ${message.gesture}`;
  }
  const pose = GESTURES.find((item) => item.id === message.gesture);
  return pose ? `${pose.glyph} ${pose.label}` : message.gesture;
}

chrome.runtime.onMessage.addListener((message) => {
  switch (message?.type) {
    case 'jester/desktop-state':
      desktop = message;
      render();
      break;
    case 'jester/telemetry': {
      const t = message.telemetry || {};
      $('camera-stats').textContent = t.stalled ? 'No picture' : `${t.fps} fps · ${t.delegate || '—'} · ${t.handPresent ? 'hand in view' : 'no hand in view'}`;
      break;
    }
    case 'jester/trigger':
      $('last-gesture').textContent = `${gestureName(message)} → ${ACTIONS[message.action]?.label || message.action}`;
      break;
    case 'jester/preview-frame':
      $('camera-preview').src = message.dataUrl;
      $('camera-preview').hidden = false;
      break;
    default:
      break;
  }
});

// Changes from elsewhere: the menu-bar switches, or another Settings window.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.gazeCalibration) renderCalibration();
  if (area !== 'local' || !changes.settings) return;
  const before = settings;
  settings = mergeSettings(changes.settings.newValue);
  settingsChanged(before);
});

// The camera view, asked for while Settings is on screen (as the extension's popup does).
const askForPreview = () => {
  if (document.visibilityState === 'visible') chrome.runtime.sendMessage({ type: 'jester/desktop-preview' }).catch(() => undefined);
};
setInterval(askForPreview, 700);
askForPreview();

$('enabled').addEventListener('change', (event) => save({ enabled: event.target.checked }));
$('pointerEnabled').addEventListener('change', (event) => save({ pointerEnabled: event.target.checked }));
$('voiceEnabled').addEventListener('change', (event) => save({ voiceEnabled: event.target.checked }));
$('speechModel').addEventListener('change', (event) => save({ speechModel: event.target.value }));
$('pointerAim').addEventListener('change', (event) => save({ pointerAim: event.target.value }));
$('headSpeed').addEventListener('change', (event) => save({ headSpeed: Number(event.target.value) }));
$('calibrate').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'jester/desktop-calibrate' }));
$('cameraDeviceId').addEventListener('change', (event) => save({ cameraDeviceId: event.target.value }));
$('windowedBindingsEnabled').addEventListener('change', (event) => save({ windowedBindingsEnabled: event.target.checked }));

settings = await readSettings();
desktop = await chrome.runtime.sendMessage({ type: 'jester/desktop-state' });
buildBindings();
buildShortcuts();
buildConnectionForm();
render();
connections('list');
renderCalibration();
await renderCameras();
navigator.mediaDevices?.addEventListener?.('devicechange', renderCameras);
