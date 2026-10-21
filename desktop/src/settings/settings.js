/**
 * Jester Desktop's Settings window.
 *
 * Settings live in `chrome.storage.local` exactly as in the extension (the
 * preload's shim carries them to the main process), so the engine picks up a
 * change the way it does in Chrome. Permissions and the engine's state come
 * from the main process as `jester/desktop-state` messages.
 */

import { ACTIONS, ENGINE, GESTURES, POINTER_INPUTS, SWIPES, mergeSettings } from '../ext/src/common/constants.js';

const $ = (id) => document.getElementById(id);

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
  settings = mergeSettings({ ...(await readSettings()), ...patch });
  await chrome.storage.local.set({ settings });
  renderControls();
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
  $('camera-hint').textContent = cameras.some((camera) => camera.label) ? 'The camera Jester watches.' : 'Names appear once the camera is allowed.';
}

function renderControls() {
  if (!settings) return;
  $('enabled').checked = !!settings.enabled;
  $('pointerEnabled').checked = !!settings.pointerEnabled;
  $('pointerEnabled').disabled = !settings.enabled;
  $('voiceEnabled').checked = !!settings.voiceEnabled && !!desktop?.voiceReady;
  const input = $('pointerInput');
  if (!input.options.length) input.replaceChildren(...Object.entries(POINTER_INPUTS).map(([value, meta]) => new Option(meta.label, value)));
  input.value = settings.pointerInput;
  input.disabled = !settings.enabled || !settings.pointerEnabled;
  $('pointerInput-hint').textContent = POINTER_INPUTS[settings.pointerInput]?.hint || '';
  renderStatus();
}

function render() {
  renderStatus();
  renderPermissions();
  renderControls();
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
    default:
      break;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  settings = mergeSettings(changes.settings.newValue);
  renderControls();
});

$('enabled').addEventListener('change', (event) => save({ enabled: event.target.checked }));
$('pointerEnabled').addEventListener('change', (event) => save({ pointerEnabled: event.target.checked }));
$('pointerInput').addEventListener('change', (event) => save({ pointerInput: event.target.value }));
$('cameraDeviceId').addEventListener('change', (event) => save({ cameraDeviceId: event.target.value }));

settings = await readSettings();
desktop = await chrome.runtime.sendMessage({ type: 'jester/desktop-state' });
render();
await renderCameras();
navigator.mediaDevices?.addEventListener?.('devicechange', renderCameras);
