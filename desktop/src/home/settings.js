/**
 * Settings, in Jester's window (home.js): a list of pages, each sliding in
 * from the right. Every control keeps the id it had in the Settings window
 * this replaced, so main.js's self-test still finds them.
 *
 * Settings live in `chrome.storage.local` exactly as in the extension (the
 * preload's shim carries them to the main process), so the engine picks up a
 * change the way it does in Chrome. Permissions and the engine's state come
 * from the main process as `jester/desktop-state` messages; the orb's screen
 * draws from the same two (`state`, `onRender`).
 */

import { ACTIONS, ENGINE, GESTURES, POINTER_AIMS, SWIPES, mergeSettings, resumeGlyphs } from '../ext/src/common/constants.js';
import { PROVIDERS } from '../ext/src/common/credentials.js';
import { calibrationGrade, loadCalibration, usableModel } from '../ext/src/common/gaze-store.js';
import { DESKTOP_LABELS, bindable, describePlan, parseShortcut, wakeHint } from '../main/os-actions.js';
import { watchPairing, watchStatus } from '../main/watch-status.js';

const $ = (id) => document.getElementById(id);
const SHORTCUTS = ['SHORTCUT_1', 'SHORTCUT_2', 'SHORTCUT_3'];

const STATUS = {
  [ENGINE.OFF]: ['Off', 'idle'],
  [ENGINE.STARTING]: ['Starting…', 'warn'],
  [ENGINE.RUNNING]: ['Watching for gestures', 'ok'],
  [ENGINE.SUSPENDED]: ['Paused', 'idle'],
  [ENGINE.SLEEPING]: ['Asleep', 'idle'],
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

const TIER = { needed: 'Needed', recommended: 'Recommended', optional: 'Optional' };

let settings = null;
let desktop = null;
/** The orb's screen, told whenever either changes. */
const renderers = new Set();

/** The settings, and how the app says things are, as last heard. */
export const state = () => ({ settings, desktop });

/** Called with `state()` each time Settings is drawn afresh. */
export function onRender(listener) {
  renderers.add(listener);
}

function told() {
  for (const listener of renderers) listener(state());
}

async function readSettings() {
  const { settings: stored } = await chrome.storage.local.get('settings');
  return mergeSettings(stored);
}

export async function save(patch) {
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
  renderJobs();
  renderDay();
  renderIndex();
  told();
}

function renderStatus() {
  const engine = desktop?.engine || { state: ENGINE.OFF };
  const [text, tone] = settings && !settings.enabled ? ['Jester is off', 'idle'] : settings?.gesturesEnabled === false ? ['Gestures off', 'idle'] : STATUS[engine.state] || [engine.state, 'idle'];
  if (engine.state === ENGINE.ERROR && engine.detail) $('status-text').textContent = `${text}: ${engine.detail}`;
  else if (engine.state === ENGINE.SLEEPING && settings?.enabled) $('status-text').textContent = `${text} — ${wakeHint(resumeGlyphs(settings), platform())}`;
  else $('status-text').textContent = text;
  $('status').dataset.tone = tone;
  // The last frame rate means nothing once the camera has stopped.
  if (![ENGINE.RUNNING, ENGINE.SLEEPING].includes(engine.state) || (settings && !settings.enabled)) $('camera-stats').textContent = '—';
}

/** What he can't do without as he's set up, and hasn't got: main.js says which (permission-list.js). */
const stillMissing = () => (desktop?.permissions || []).filter((item) => (desktop?.missing || []).includes(item.id));

function renderPermissions() {
  const items = desktop?.permissions || [];
  const missing = stillMissing();
  $('permissions-intro').textContent = missing.length
    ? `Jester needs ${missing.map((item) => item.label).join(' and ')} for what’s switched on. He asks for each one when it’s first needed; you can also allow them here. Everything he sees and hears stays on this computer.`
    : 'Everything Jester needs for what’s switched on is allowed. Anything else is asked for when it’s first used. Camera frames and audio stay on this computer.';
  $('permissions').replaceChildren(
    ...items.map((item) => {
      const li = document.createElement('li');
      li.className = `permission${item.granted ? ' granted' : ''}`;
      const [stateText, stateTone] = PERMISSION_STATE[item.status] || PERMISSION_STATE.unknown;
      // Something everything works without is no cause for alarm.
      const stateClass = item.tier === 'optional' && !item.granted ? 'optional' : stateTone;

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
      // Looked for as "Jester" in System Settings, it isn't there.
      why.textContent = `${item.why}${!item.granted && item.listedAs ? ` System Settings lists it as “${item.listedAs}”.` : ''}`;
      text.append(title, why);
      // Where it's allowed, for one that isn't; and for Accessibility, what mends a switch that's on and does nothing.
      if (!item.granted && item.where) {
        const where = document.createElement('small');
        where.className = 'where';
        where.textContent = `Allowed in ${item.where}.${item.id === 'accessibility' && platform() === 'darwin' ? ' If Jester’s already switched on there and this still says it isn’t allowed (it happens after an update), select him in that list, remove him with the − button, then press Allow… here again.' : ''}`;
        text.append(where);
      }

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
  $('gesturesEnabled').checked = settings.gesturesEnabled !== false;
  $('gesturesEnabled').disabled = !settings.enabled;
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
  renderWatch();
  renderStatus();
}

/** Only on a Mac: there's no Apple Watch to steer with on Windows. */
function renderWatch() {
  $('go-watch').hidden = platform() !== 'darwin';
  const watch = desktop?.watch || {};
  const pairing = watchPairing(watch, settings);
  $('watchEnabled').checked = !!settings.watchEnabled;
  $('watchEnabled').disabled = !settings.enabled || !watch.built;
  $('watch-hint').textContent = watchStatus(watch, settings);
  $('watch-pair-title').textContent = pairing.title;
  $('watch-pair-hint').textContent = pairing.hint;
  $('watch-pair').textContent = pairing.action;
  $('watch-pair').disabled = pairing.disabled;
  $('watch-pair').dataset.op = pairing.op;
  $('watch-cancel').hidden = !pairing.cancellable;
  $('watchSpeed').value = String(settings.watchSpeed ?? 1);
  $('watchInvertY').checked = !!settings.watchInvertY;
}

async function watchOp(op) {
  desktop = await chrome.runtime.sendMessage({ type: 'jester/desktop-watch', op });
  renderWatch();
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
    ? desktop?.models?.words || 'Needs what he hears with, which isn’t downloaded yet: Download, above.'
    : `${voiceStarters()} starts a command: say “open Spotify”, “volume 30”, “type hello”. Speech is recognized on this computer.`;
  renderModels();
  renderSpeechModel(missing);
  renderContinuous();
}

/**
 * What he hears and speaks with, when it isn't all here: how the download's going, and the buttons that start and
 * stop it. He starts it himself the first time he's opened; the row goes once there's nothing left to fetch.
 */
function renderModels() {
  const models = desktop?.models;
  const row = $('models-row');
  if (!models) return void (row.hidden = true);
  const first = models.first || [];
  const extra = models.extra?.[0];
  row.hidden = !models.fetching && !models.error && !first.length && !extra;
  $('models-words').textContent =
    models.words ||
    (first.length
      ? `What he hears and speaks with isn’t all here yet: ${models.firstMb} MB to download, once. Nothing you say is sent anywhere to be recognized.`
      : extra
        ? `${extra.label}, the other recognizer, is a ${extra.mb} MB download.`
        : '');
  const fetch = $('models-fetch');
  fetch.hidden = !!models.fetching || (!first.length && !models.error);
  fetch.textContent = models.error ? 'Try again' : `Download (${models.firstMb} MB)`;
  const more = $('models-extra');
  more.hidden = !!models.fetching || !!models.error || !extra;
  if (extra) {
    more.textContent = `Download ${extra.label} (${extra.mb} MB)`;
    more.dataset.id = extra.id;
  }
  $('models-stop').hidden = !models.fetching;
}

/** Pictures of the window for the model: on unless turned off here, and on a Mac only with Screen Recording too. */
function renderPictures() {
  $('agentScreenshots').checked = settings.agentScreenshots !== false;
  $('keepUnsureSpeech').checked = settings.keepUnsureSpeech === true;
  $('mailWatch').checked = settings.mailWatch !== false;
  $('mailJudge').checked = settings.mailJudge !== false;
  // What he tells them unasked, by the day: on unless turned off.
  $('briefMorning').checked = settings.briefMorning !== false;
  $('briefEvening').checked = settings.briefEvening !== false;
  $('checkIns').checked = settings.checkIns !== false;
  $('offerWork').checked = settings.offerWork !== false;
  if (document.activeElement !== $('eveningAt')) $('eveningAt').value = /^\d\d:\d\d$/.test(settings.eveningAt || '') ? settings.eveningAt : '21:00';
  const recording = (desktop?.permissions || []).find((item) => item.id === 'screen');
  $('pictures-hint').textContent = `When a window’s words aren’t enough, the assistant may send a model that reads pictures one of that window: up to three a task, never with a password field showing.${recording && !recording.granted ? ' Needs Screen Recording, under Permissions.' : ''}`;
}

/** The always-on assistant: whether it can listen, and how he sounds. */
function renderContinuous() {
  const { listening, problem, voice, knowsYou, teaching } = desktop?.continuous || {};
  $('continuousAssistant').checked = !!settings.continuousAssistant;
  $('continuousAssistant').disabled = !settings.enabled || !settings.voiceEnabled;
  $('continuous-hint').textContent = problem || (listening
    ? 'Listening. Say “Jester”, “J” or “Jes” first. Nothing else you say is kept or sent anywhere.'
    : 'Keeps the mic open for his name, then talks with you and does what you ask. What you hear is recognized on this computer.');
  $('voice-print-teach').textContent = teaching ? 'Cancel' : knowsYou ? 'Teach again' : 'Teach him';
  $('voice-print-teach').disabled = !settings.enabled || !settings.voiceEnabled;
  $('voice-print-forget').hidden = !knowsYou || !!teaching;
  $('voice-print-hint').textContent = teaching
    ? `Read this aloud (${teaching.done + 1} of ${teaching.of}): “${teaching.line}”`
    : knowsYou
      ? 'He only listens to you. Anyone else is ignored before their words are even worked out, and you can talk on without saying his name.'
      : 'Read five sentences so he can tell you from everyone else. What’s kept describes your voice and can’t be played back. It stays on this computer.';
  const select = $('jesterVoice');
  const there = voice?.state !== 'missing';
  select.replaceChildren(...(voice?.choices || []).map((choice) => new Option(`${choice.name} (${choice.about})`, choice.id)));
  select.value = voice?.chosen || '';
  select.hidden = !there;
  $('jester-voice-hear').hidden = !there;
  $('jester-voice-hint').textContent = !there
    ? `This computer’s voice, for now. ${desktop?.models?.fetching?.id === 'kokoro' ? desktop.models.words : 'His own is a 334 MB download: Settings › General › Downloads.'}`
    : voice.state === 'resting'
      ? 'His own voice isn’t starting, so this computer’s speaks for now. It’s tried again in a few minutes.'
      : 'His own voice, made on this computer: nothing he says is sent anywhere, and there’s no account or allowance.';
}

/** What Ollama said it has, the last time it was asked. */
let ollama = null;

/** The models Ollama has, asked when Settings opens and whenever it's come back to. */
async function renderChatModels() {
  ollama = await chrome.runtime.sendMessage({ type: 'jester/desktop-ollama' }).catch(() => null);
  const select = $('assistantModel');
  const models = ollama?.models || [];
  select.replaceChildren(...models.map(({ name, size }) => new Option(`${name} (${Math.round(size / 1e9)} GB)`, name)));
  select.value = settings?.assistantModel && models.some((model) => model.name === settings.assistantModel) ? settings.assistantModel : ollama?.chosen || '';
  select.disabled = !models.length;
  $('chat-model-hint').textContent = !ollama?.running
    ? 'Ollama isn’t running. Open it, then come back here.'
    : models.length
      ? 'Runs here: what it hears and reads stays on this computer.'
      : 'Ollama has no models yet. In a terminal, run: ollama pull qwen3.5:9b';
  renderJobs();
  renderIndex();
}

/** This computer's model's jobs, from the settings: both until unticked. */
const localUses = () => (Array.isArray(settings?.localModelUses) ? settings.localModelUses : ['talk', 'act']);

/** The saved models, as last listed: for saying who does each job. */
let savedModels = [];
/** Paid models are tried before free ones (model-jobs.js), unless the settings say as saved. */
let paidFirst = true;
/** The saved models in the order a job tries them. */
const inOrder = (models) => (paidFirst ? [...models.filter((model) => model.plan === 'paid'), ...models.filter((model) => model.plan !== 'paid')] : models);

const modelName = (connection) => `${PROVIDERS[connection.provider]?.label || connection.provider} · ${connection.model}`;

/** Who does each job, in the order they're tried. */
function renderJobs() {
  const local = localUses();
  $('local-talk').checked = local.includes('talk');
  $('local-act').checked = local.includes('act');
  const here = ollama?.chosen ? `this computer’s ${ollama.chosen}` : 'this computer’s, once Ollama is running';
  const first = (text) => text.charAt(0).toUpperCase() + text.slice(1);
  for (const job of ['talk', 'act']) {
    const saved = inOrder(savedModels.filter((connection) => connection.uses?.includes(job))).map(modelName);
    const parts = saved.length ? [saved.join(', then ')] : [];
    if (local.includes(job)) parts.push(saved.length ? `${here} when ${saved.length > 1 ? 'none of them can' : 'it can’t'}` : here);
    $(`job-${job}`).textContent = parts.length ? first(parts.join('; ')) : job === 'talk' ? 'Nothing: he can’t talk. Tick Talking on a model below.' : 'Nothing: commands Jester doesn’t know won’t work. Tick Actions on a model below.';
  }
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
  $('speech-model-hint').textContent = [chosen?.hint, absent && `${absent.label} isn’t downloaded: Downloads, above, has it.`].filter(Boolean).join(' ');
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
const MODEL_EXAMPLES = { google: 'gemini-2.5-flash', groq: 'openai/gpt-oss-120b', openai: 'gpt-5-mini', anthropic: 'claude-haiku-5-5', ollama: 'qwen3.5:9b', custom: '' };

/** Asks the main process, which alone holds the keys; the reply lists them masked. */
async function connections(op, extra = {}) {
  const reply = await chrome.runtime.sendMessage({ type: 'jester/desktop-connections', op, ...extra });
  renderConnections(reply);
  return reply;
}

/** A tick box for one of a model's jobs. */
function useBox(label, checked, onChange) {
  const wrap = document.createElement('label');
  wrap.className = 'use';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = checked;
  box.addEventListener('change', () => onChange(box.checked));
  wrap.append(box, document.createTextNode(label));
  return wrap;
}

/** What a model has cost this month, as near as Jester can tell (spend.js): dollars where its price is known. */
function spentLine(spend) {
  if (!spend?.requests) return '';
  const replies = `${spend.requests.toLocaleString()} ${spend.requests === 1 ? 'reply' : 'replies'} this month`;
  if (spend.usd === null) return ` · ${replies}`;
  const about = spend.usd <= 0 ? '$0.00' : spend.usd < 0.01 ? 'under 1¢' : `about $${spend.usd.toFixed(2)}`;
  return ` · ${about} for ${replies}`;
}

function renderConnections(reply) {
  const saved = reply?.connections || [];
  savedModels = saved;
  paidFirst = reply?.paidFirst !== false;
  $('connection-error').textContent = reply?.ok === false ? reply.error : '';
  fitTalking();
  renderJobs();
  renderIndex();
  $('connections').hidden = !saved.length;
  $('connections').replaceChildren(
    ...saved.map((connection) => {
      const row = document.createElement('div');
      row.className = 'row model';
      const text = document.createElement('span');
      const name = document.createElement('strong');
      name.textContent = modelName(connection);
      const detail = document.createElement('small');
      const resting = connection.cooldownUntil > Date.now() ? ` · resting until ${new Date(connection.cooldownUntil).toLocaleTimeString()}` : '';
      const plan = connection.provider === 'ollama' ? '' : ` · ${connection.plan === 'free' ? 'Free' : 'Paid'}`;
      detail.textContent = `${connection.masked}${plan}${resting}${spentLine(connection.spend)}`;
      text.append(name, detail);
      const controls = document.createElement('span');
      controls.className = 'controls';
      const uses = new Set(connection.uses || ['act']);
      const set = (use) => (on) => {
        if (on) uses.add(use);
        else uses.delete(use);
        connections('uses', { id: connection.id, uses: [...uses] });
      };
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Remove';
      remove.addEventListener('click', () => connections('remove', { id: connection.id }));
      controls.append(useBox('Talking', uses.has('talk'), set('talk')), useBox('Actions', uses.has('act'), set('act')), remove);
      row.append(text, controls);
      return row;
    })
  );
}

/** The Talking box was set by hand, for the model being added: left as they set it. */
let talkingChosen = false;

/**
 * Whether a model being added is ticked for Talking before they've said. Talking is the user's words, so it's ticked
 * where they stay on this computer; and where nothing talks yet, since he can't answer at all until something does
 * (the hint beside it says where their words go).
 */
function fitTalking() {
  if (talkingChosen) return;
  const provider = $('connection-provider').value;
  const talks = savedModels.some((connection) => connection.uses?.includes('talk')) || (localUses().includes('talk') && !!ollama?.chosen);
  $('connection-talk').checked = provider === 'ollama' || !talks;
}

function buildConnectionForm() {
  const provider = $('connection-provider');
  provider.replaceChildren(...Object.entries(PROVIDERS).map(([id, meta]) => new Option(meta.label, id)));
  const fit = () => {
    $('connection-model').placeholder = MODEL_EXAMPLES[provider.value] ? `e.g. ${MODEL_EXAMPLES[provider.value]}` : 'The model’s ID';
    $('connection-url-row').hidden = provider.value !== 'custom';
    $('connection-key-row').hidden = $('connection-plan-row').hidden = provider.value === 'ollama';
    $('connection-plan').value = ['google', 'groq'].includes(provider.value) ? 'free' : 'paid';
    talkingChosen = false;
    fitTalking();
    $('connection-uses-hint').textContent = provider.value === 'ollama'
      ? 'Runs on this computer: nothing it hears or reads leaves it.'
      : `A model that talks hears what you say to him, so that goes to ${PROVIDERS[provider.value]?.label || 'its provider'} too.`;
  };
  provider.addEventListener('change', fit);
  $('connection-talk').addEventListener('change', () => (talkingChosen = true));
  fit();
  $('connection-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('connection-add').disabled = true;
    const uses = [$('connection-talk').checked && 'talk', $('connection-act').checked && 'act'].filter(Boolean);
    const reply = await connections('save', {
      input: { provider: provider.value, model: $('connection-model').value, key: provider.value === 'ollama' ? '' : $('connection-key').value, plan: $('connection-plan').value, baseUrl: $('connection-url').value, uses }
    });
    $('connection-add').disabled = false;
    // The key isn't kept in the page once it's saved.
    if (reply?.ok) $('connection-key').value = '';
    // The next one added starts from how things stand now.
    if (reply?.ok) (talkingChosen = false), fitTalking();
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

/** The link to Jester's Chrome extension (chrome-link.js): what it does while it's there, and how to make it. */
function renderChrome() {
  const chrome = desktop?.chrome || {};
  $('chrome-link-state').textContent = chrome.linked ? `Linked (Jester ${chrome.version})` : 'Not linked';
  $('chrome-link-hint').textContent = chrome.linked
    ? 'Jester watches and listens for both, so Chrome’s own camera and mic stay off. With Chrome in front, gestures do what Jester’s Chrome settings say; what you ask about Chrome (a bookmark, a tab, a page) is done there, on this pill; and the cursor clicks the link you aimed at.'
    : chrome.why
      ? `${chrome.why} Until it is, Jester works Chrome like any other app.`
      : `In Chrome, open Jester’s settings and click Link with Jester Desktop. It then has your bookmarks, tabs and pages for what you ask, and one camera and mic for both.${chrome.browsers?.length ? ` Ready for ${chrome.browsers.join(', ')}.` : ''}`;
}

/**
 * Jester in the cloud: on a Mac, whether it's his server's hands (cloud-link.js) and the link to give it; on the
 * server itself (his website), whether the Mac is connected.
 */
function renderCloud() {
  const server = desktop?.server;
  const cloud = desktop?.cloud || { on: false };
  // Signing in: when it isn't linked, and again when the server no longer takes this Mac's key (only the password then).
  $('cloud-signin').hidden = !!server || (cloud.on && !cloud.refused);
  $('cloud-server-row').hidden = !!cloud.on;
  $('cloud-link-way').hidden = !!server || cloud.on;
  $('cloud-off-card').hidden = !!server || !cloud.on;
  if (server) {
    $('cloud-title').textContent = 'Your Mac';
    $('cloud-state').textContent = server.mac ? 'Connected' : 'Not connected';
    $('cloud-hint').textContent = server.mac
      ? 'This is Jester’s server. Your Mac is his hands: what you ask him to do on the computer is done there.'
      : 'This is Jester’s server. Open Jester on your Mac and paste this server’s link into its Settings › Jester in the cloud: until then he can talk, remember and remind you, but can’t work your computer.';
    return;
  }
  $('cloud-title').textContent = 'Use Jester in the cloud';
  $('cloud-state').textContent = cloud.on ? (cloud.connected ? 'Connected' : cloud.refused ? 'Sign in again' : 'Can’t reach it') : 'Off';
  $('cloud-hint').textContent = cloud.on && cloud.refused
    ? `His server at ${cloud.server} no longer takes this Mac’s key (it was replaced, or this Mac was signed out). Type your password below, or in his window, and this Mac is linked again.`
    : cloud.on
    ? `His conversation, memory, reminders, mail and briefs are on ${cloud.server}, the same Jester as his website. This Mac is his hands, eyes and ears: gestures, the cursor, Chrome and your apps stay here, and so do these settings.${cloud.connected ? '' : ' Is Tailscale on, on this Mac, and the server running?'}`
    : 'Run his brain on a server of yours (see desktop/server/README.md), and talk to the same Jester here and on his website, from any of your devices.';
}

/** macOS keeps Jester out of the vault: since it was chosen, or since it was opened (its search says so). */
const vaultDenied = (memory) => memory?.problem === 'denied' || (!!memory?.root && memory.search?.error === 'denied');

/** What he knows, as last counted: later news of the app comes without the count. */
let knownShown = null;

/** The vault Jester remembers in, and how well it can search it. */
function renderMemory() {
  const memory = desktop?.memory || {};
  const search = memory.search;
  const denied = vaultDenied(memory);
  const detected = (memory.detected || []).find((item) => item.path !== memory.chosen && item.path !== memory.root);
  $('memoryConversations').checked = settings.memoryConversations !== false;
  $('vault-hint').textContent = memory.root
    ? `${memory.name}: ${memory.root}. Jester reads all of it, and writes only in its Jester and Notes folders (and Claude and ChatGPT, when you import your chats). Stop using, and Jester does neither (nothing in the vault is deleted).`
    : 'Jester keeps what it learns about you in an Obsidian vault, reads your notes there to answer, and adds to them when you ask.';
  // What leaves the computer: the talking model is told what bears on what's said (vault-memory.js recall).
  if (memory.root) $('vault-hint').textContent += ' What you say goes to the model ticked for Talking with About me and the parts of your notes that look related, never a line that looks like a password.';
  const problems = {
    denied: `macOS hasn’t let Jester into that folder. Click Open Privacy Settings, find ${desktop?.permissions?.[0]?.listedAs || 'Jester'} under Files and Folders (System Settings › Privacy & Security › Files and Folders), turn on the folder your vault is in (Documents, say), then click Try again.`,
    missing: 'That folder isn’t there any more. Choose the vault again.'
  };
  $('vault-problem').textContent = denied ? problems.denied : memory.problem ? problems[memory.problem] || memory.problem : '';
  $('vault-use').hidden = !detected;
  if (detected) $('vault-use').textContent = `Use “${detected.name}”`;
  $('vault-use').dataset.path = detected?.path || '';
  // A long name is cut short on the button: all of it, and where it is, on hover.
  $('vault-use').title = detected?.path || '';
  $('vault-choose').textContent = memory.chosen ? 'Change…' : 'Choose…';
  $('vault-remove').hidden = !memory.chosen;
  $('vault-open').hidden = !memory.root;
  $('vault-privacy').hidden = !denied;
  // Read again opens the vault again too, so it's how to try once macOS lets Jester in.
  $('vault-reindex').hidden = !memory.root && !denied;
  $('vault-reindex').textContent = denied ? 'Try again' : 'Read again';
  // What he's learned and been asked to keep: counts only, and the note itself is the user's to open.
  $('known-row').hidden = !memory.root;
  const things = (count, one, many) => `${count} ${count === 1 ? one : many}`;
  if (memory.known) knownShown = memory.known;
  if (knownShown && memory.root) {
    $('known-hint').textContent = `${knownShown.facts ? `${things(knownShown.facts, 'thing', 'things')} learned from talking with you` : 'Nothing learned yet: he picks things up as you talk'}${knownShown.kept ? `, and ${things(knownShown.kept, 'thing', 'things')} you asked him to remember` : ''}. Ask him “what do you know about me?”, or say “forget that…” and what: he takes it out, and a note you’d asked him to keep goes to the Trash.`;
  }
  $('chats-import').hidden = !memory.root;
  $('chats-hint').textContent = memory.root
    ? 'Bring in the chats you’ve downloaded: from Claude (Settings › Privacy › Export data, then conversations-000.zip from the links it gives) or ChatGPT (Settings › Data controls › Export data). ' +
      'Each chat becomes a note in your vault’s Claude or ChatGPT folder, word for word but for lines that look like a password or key, and Jester answers from them like your other notes. ' +
      'Importing again updates only the chats carried on since, replacing those notes.'
    : 'Once there’s a vault: your chats from Claude and ChatGPT, imported a note each.';
  renderLearning(memory);
  $('vault-search').textContent = !memory.root
    ? 'Once there’s a vault: by meaning, with nomic-embed-text in Ollama, or by words without it.'
    : memory.reading || !search
      ? 'Reading the vault…'
      : `${search.notes} note${search.notes === 1 ? '' : 's'} read · ${search.mode === 'meaning' ? `by meaning (${search.model})` : search.mode === 'words' ? 'by words' : 'off'}${search.error && search.error !== 'denied' ? ` · ${search.error}` : ''}`;
}

/**
 * Learning from the imported chats: how many there are and how many he's read, the run as it goes, and how it ended.
 * One button starts it, and stops it while it runs.
 */
let wasLearning = false;
function renderLearning(memory) {
  const chats = memory.chats;
  const run = memory.learning;
  const many = (count, one, more) => `${count.toLocaleString()} ${count === 1 ? one : more}`;
  // A run just over: what he knows is counted again, for the row above.
  if (wasLearning && !run?.running) vaultOp('known').catch(() => undefined);
  wasLearning = !!run?.running;
  $('learn-row').hidden = !memory.root || !(chats?.chats || run?.running);
  if ($('learn-row').hidden) return;
  const left = chats ? chats.chats - chats.learned : 0;
  $('learn-hint').textContent =
    'Imported, a chat is only found when a question happens to match it. Learn from them has the model ticked for Talking read each chat once: what you wrote in it and how each reply began, ' +
    'never what you pasted or a line left out as a secret. A sentence on what it was about is kept in the chat’s note, so he finds it better, and the lasting things you said about yourself ' +
    '(school, work, people, projects) go into About me, at most 60 a run, yours to edit or delete. With a paid Claude model, 1,000 chats take about seven minutes and 15¢.';
  const button = $('chats-learn');
  button.disabled = false;
  button.textContent = run?.running ? 'Stop' : left && chats.learned ? 'Carry on' : left || !chats ? 'Learn from them' : 'Learned';
  button.disabled = !run?.running && !!chats && !left;
  const status = $('learn-status');
  status.classList.toggle('error', !run?.running && !!run?.error);
  if (run?.running) {
    status.textContent = run.phase === 'facts' ? 'Choosing what goes into About me…' : `Reading your chats: ${run.done.toLocaleString()} of ${run.total.toLocaleString()}${run.failed ? ` (${run.failed} couldn’t be read)` : ''}. You can leave this page: it carries on.`;
    return;
  }
  const counted = chats ? `${many(chats.chats, 'chat', 'chats')} imported; he’s read ${chats.learned === chats.chats ? (chats.chats === 1 ? 'it' : 'all of them') : chats.learned.toLocaleString()}.` : '';
  const ended = !run?.finished ? '' : run.error ? ` It stopped: ${run.error}` : ` Last time: ${many(run.done, 'chat', 'chats')} read${run.failed ? `, ${run.failed} couldn’t be` : ''}, ${run.added ? `${many(run.added, 'thing', 'things')} added to About me` : 'nothing new for About me'}.`;
  status.textContent = `${counted}${ended}`;
}

/** What an import of chats did, in a sentence or two; `error` when nothing came of it. */
function importedText(result) {
  if (result.error) return { text: `Couldn’t import them: ${result.error}`, error: true };
  const things = (count, one, many) => `${count.toLocaleString()} ${count === 1 ? one : many}`;
  const lines = Object.entries(result.sources || {}).map(([name, tally]) => {
    const done = [
      tally.added && `${things(tally.added, 'chat', 'chats')} added to your ${tally.folder} folder`,
      tally.updated && `${things(tally.updated, 'chat', 'chats')} carried on since, updated`,
      tally.same && `${things(tally.same, 'chat', 'chats')} already there`,
      tally.empty && `${things(tally.empty, 'empty chat', 'empty chats')} skipped`
    ].filter(Boolean);
    return `${name}: ${done.join(', ') || 'no chats'}.`;
  });
  if (result.leftOut) lines.push(`${things(result.leftOut, 'line', 'lines')} left out, as ${result.leftOut === 1 ? 'it' : 'they'} looked like a password, key or card number.`);
  if (result.failed) lines.push(`${things(result.failed, 'chat', 'chats')} couldn’t be written: Jester’s log says why.`);
  for (const problem of result.problems || []) lines.push(`${problem.file}: ${problem.why}`);
  const none = !Object.keys(result.sources || {}).length;
  if (none && !lines.length) lines.push('There were no chats in that.');
  return { text: lines.join(' '), error: none };
}

/** Settings › Memory's Import…: macOS's dialog, then what came of it under the button, till the next one. */
async function importChats() {
  const button = $('chats-import');
  button.disabled = true;
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'jester/desktop-memory', op: 'import' });
    if (reply) desktop = reply;
    if (reply?.imported) {
      const { text, error } = importedText(reply.imported);
      $('chats-result').textContent = text;
      $('chats-result').classList.toggle('error', error);
    }
  } finally {
    button.disabled = false;
    render();
  }
}

/** Asks the app to do something with the vault: it answers with how things are now. */
async function vaultOp(op, path) {
  desktop = await chrome.runtime.sendMessage({ type: 'jester/desktop-memory', op, path });
  render();
}

/** "just now", "4 minutes ago", "2 hours ago". */
function ago(at) {
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'} ago`;
}

/**
 * Why there's no position, and what to do about it. On his website (a server), it's the device being used that
 * couldn't say: a browser's own location, or the Mac's for Jester's window there (main/device-location.js).
 */
function locationProblem(problem, onServer = false) {
  if (onServer) {
    if (problem === 'asking') return 'Your device has to allow it first. In a browser: press Allow location on the bar at the bottom of this page, then choose Allow when the browser asks. In Jester on your Mac: choose Allow on macOS’s question. Then Locate again.';
    if (problem === 'denied') return 'The device you’re using said no to sharing where it is. On a phone or another computer, allow location for this site in the browser’s settings (on an iPhone: Settings › Privacy & Security › Location Services › Safari Websites, and Settings › Apps › Safari › Location). On your Mac, Jester needs Location Services in System Settings › Privacy & Security. Then Locate again.';
    if (problem === 'timeout') return 'No position came in time. If your browser asked whether this site may know where you are, allow it, then Locate again.';
    if (problem === 'unavailable') return 'The device you’re using couldn’t tell where it is just now. Locate again, or name a place instead.';
    return problem ? `Couldn’t get a position: ${problem}` : '';
  }
  const mac = platform() === 'darwin';
  if (problem === 'asking') return mac ? 'macOS is asking whether Jester may use this Mac’s location: choose Allow on its question. If you can’t see the question, press Locate again.' : 'Windows hasn’t answered yet. Press Locate again.';
  if (problem === 'denied') {
    return mac
      ? 'macOS hasn’t let Jester know where this Mac is. Click Open Privacy Settings, turn on Location Services, and Jester in its list, then Locate again.'
      : 'Windows hasn’t let Jester know where this computer is. Click Open Privacy Settings, let desktop apps use your location, then Locate again.';
  }
  if (problem === 'timeout') return `No position came in time. If ${mac ? 'macOS' : 'Windows'} asked whether Jester may use your location, answer it, then Locate again.`;
  if (problem === 'unavailable') return `This ${mac ? 'Mac' : 'computer'} couldn’t tell where it is just now (it needs Wi-Fi on to). Locate again, or name a place instead.`;
  return problem ? `Couldn’t get a position: ${problem}` : '';
}

/** One connected calendar: its name (his to say, so the user's to change), where it's from, and how its last read went. */
function calendarRow(calendar) {
  const row = document.createElement('div');
  row.className = 'row calendar';
  const text = document.createElement('span');
  const title = document.createElement('strong');
  title.textContent = calendar.name;
  const detail = document.createElement('small');
  detail.textContent = calendar.reading
    ? `${calendar.site} · reading…`
    : `${calendar.site} · ${calendar.events} upcoming event${calendar.events === 1 ? '' : 's'} in the next three months${calendar.at ? ` · read ${ago(calendar.at)}` : ''}`;
  const error = document.createElement('small');
  error.className = 'error';
  error.textContent = calendar.error;
  text.append(title, detail, error);
  const name = document.createElement('input');
  name.type = 'text';
  name.value = calendar.name;
  name.setAttribute('aria-label', `What Jester calls ${calendar.name}`);
  name.addEventListener('change', () => dayOp({ op: 'calendar-rename', id: calendar.id, name: name.value.trim() }));
  const buttons = document.createElement('span');
  buttons.className = 'buttons';
  if (calendar.error) {
    const again = document.createElement('button');
    again.type = 'button';
    again.textContent = 'Read again';
    again.addEventListener('click', () => dayOp({ op: 'calendar-refresh' }));
    buttons.append(again);
  }
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = 'Remove';
  remove.addEventListener('click', () => dayOp({ op: 'calendar-remove', id: calendar.id }));
  buttons.append(remove);
  row.append(text, name, buttons);
  return row;
}

let shownCalendars = '';
/** "A place you name" picked, with no place named yet: shown, not saved, until one is. */
let namingPlace = false;

/** Where the user is, the weather there, and their calendars. */
function renderDay() {
  const day = desktop?.day || {};
  const location = day.location || { source: 'off' };
  // Main's word for it: it's saved and acted on before main answers, and the page's copy of settings comes after.
  const source = namingPlace ? 'place' : location.source || settings.locationSource || 'off';
  const mac = platform() === 'darwin';
  // His website: where the device being used is, not the server's (main/device-location.js).
  const onServer = !!desktop?.server;
  $('location-here').textContent = onServer ? 'Where your device is' : mac ? 'This Mac’s location' : 'This computer’s location';
  $('location-actions').querySelector('strong').textContent = onServer ? 'Your device’s position' : mac ? 'This Mac’s position' : 'This computer’s position';
  $('locationSource').value = source;
  const shared = ' Your position goes to OpenStreetMap, to name the street you’re on, and to Open-Meteo, to the nearest kilometre, for the weather.';
  $('location-hint').textContent =
    source === 'off'
      ? 'Off: Jester doesn’t know where you are, so he can’t tell you the weather.'
      : source === 'place'
        ? day.place
          ? `${[day.place.name, day.place.countryCode === 'US' ? day.place.region : day.place.country].filter(Boolean).join(', ')}: the weather there, wherever you are.`
          : 'Name the place below.'
        : location.town
          ? `${location.town}, from ${onServer ? location.device || 'the device you’re using' : mac ? 'Location Services' : 'Windows’ location'}.${shared}`
          : location.locating
            ? onServer
              ? 'Finding where your device is… If your browser asks whether this site may know your location, allow it.'
              : `Finding where this ${mac ? 'Mac' : 'computer'} is… If ${mac ? 'macOS' : 'Windows'} asks whether Jester may use your location, allow it.`
            : onServer
              ? `Jester asks the device you’re talking to him on where you are (its browser, or your Mac’s Location Services in Jester’s window there), at most every 15 minutes, and again as soon as you switch devices.${shared}`
              : `Jester asks ${mac ? 'Location Services' : 'Windows'} where you are when you talk to him, at most every 15 minutes.${shared}`;
  $('location-problem').textContent = source === 'here' ? locationProblem(location.problem, onServer) : '';
  $('place-form').hidden = source !== 'place';
  if (document.activeElement !== $('place-name')) $('place-name').value = day.place ? [day.place.name, day.place.countryCode === 'US' ? day.place.region : day.place.country].filter(Boolean).join(', ') : '';
  $('location-actions').hidden = source !== 'here';
  $('location-detail').textContent = location.locating
    ? 'Locating…'
    : location.at
      ? `To within ${location.accuracy} m, ${ago(location.at)}.`
      : 'Not found yet.';
  $('location-again').disabled = !!location.locating;
  // The Mac's privacy settings open on the Mac only: a website can't open a phone's.
  $('location-privacy').hidden = location.problem !== 'denied' || onServer;
  $('weatherUnits').value = day.units || 'auto';
  $('weather-hint').textContent = source === 'off' ? 'Needs a location.' : day.weather || (source === 'place' && !day.place ? 'Needs a place.' : 'Fetching it…');
  // Built again only when it's changed, and not while a name's being typed.
  const calendars = day.calendars || [];
  const now = JSON.stringify(calendars);
  if (now !== shownCalendars && !$('calendars').contains(document.activeElement)) {
    shownCalendars = now;
    $('calendars').replaceChildren(...calendars.map(calendarRow));
  }
}

/** Asks the app to do something about the weather, a place or a calendar: it answers with how things are now. */
async function dayOp(message) {
  const reply = await chrome.runtime.sendMessage({ type: 'jester/desktop-day', ...message });
  if (reply?.type === 'jester/desktop-state') desktop = reply;
  render();
  return reply || { ok: false, error: 'Jester didn’t answer.' };
}

function render() {
  // The app's state can come before the settings are read: it's drawn once they are.
  if (!settings) return;
  renderStatus();
  renderChrome();
  renderCloud();
  renderPermissions();
  renderPictures();
  renderMemory();
  renderDay();
  renderControls();
  renderBindings();
  renderCameraHint();
  renderIndex();
  $('dev-note').hidden = !desktop?.fakeMedia;
  told();
}

/** Set the aside in Settings' list of pages: a word on each, where there's one worth saying. */
function aside(id, text, tone = '') {
  $(id).textContent = text;
  if (tone) $(id).dataset.tone = tone;
  else delete $(id).dataset.tone;
}

/** Settings' list of pages, each with how it stands. */
function renderIndex() {
  if (!settings) return;
  const missing = stillMissing();
  aside('sum-permissions', missing.length ? `${missing.length} needed` : desktop?.permissions?.length ? 'All set' : '', missing.length ? 'warn' : '');
  // His website has no camera to use (web.css hides those rows): only whether he's on.
  aside('sum-general', !settings.enabled ? 'Off' : globalThis.jesterWeb ? '' : [settings.gesturesEnabled === false ? 'Gestures off' : 'Gestures on', settings.pointerEnabled ? 'cursor on' : ''].filter(Boolean).join(', '));
  const watch = desktop?.watch || {};
  aside('sum-watch', settings.watchEnabled && watch.paired ? 'Steering' : watch.paired ? 'Paired' : '');
  const continuous = desktop?.continuous || {};
  aside('sum-assistant', continuous.listening ? (continuous.knowsYou ? 'Listening for you' : 'Listening') : settings.continuousAssistant && continuous.problem ? 'Can’t listen' : 'Not listening', settings.continuousAssistant && continuous.problem ? 'warn' : '');
  const memory = desktop?.memory || {};
  const troubled = vaultDenied(memory) || !!memory.problem;
  // Chosen but not open (macOS keeping Jester out, or the folder gone) is a problem, not "no vault".
  aside('sum-memory', memory.root ? memory.name || 'Vault' : memory.chosen ? 'Can’t open the vault' : 'No vault', troubled ? 'warn' : '');
  const day = desktop?.day || {};
  const location = day.location || {};
  const source = location.source || settings.locationSource || 'off';
  const calendarCount = (day.calendars || []).length;
  const calendarsBad = (day.calendars || []).some((calendar) => calendar.error);
  const where =
    source === 'off'
      ? ''
      : source === 'place'
        ? day.place?.name || 'No place named'
        : location.town || (location.locating ? 'Locating…' : location.problem ? 'Can’t locate' : 'Locating…');
  const whereBad = (source === 'here' && !location.town && !!location.problem) || (source === 'place' && !day.place);
  aside(
    'sum-day',
    [where, calendarCount ? `${calendarCount} calendar${calendarCount === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ') || 'Off',
    whereBad || calendarsBad ? 'warn' : ''
  );
  const talker = inOrder(savedModels).find((connection) => connection.uses?.includes('talk'));
  aside('sum-models', talker ? talker.model : localUses().includes('talk') && ollama?.chosen ? ollama.chosen : savedModels.length ? `${savedModels.length} saved` : '');
  aside('sum-chrome', desktop?.chrome?.linked ? 'Linked' : 'Not linked');
  aside('sum-cloud', desktop?.server ? (desktop.server.mac ? 'Mac connected' : 'No Mac') : desktop?.cloud?.on ? (desktop.cloud.connected ? 'On' : 'Can’t reach it') : 'Off', desktop?.cloud?.on && !desktop.cloud.connected ? 'warn' : '');
  aside('sum-gestures', settings.windowedBindingsEnabled ? 'Two sets' : '');
}

function gestureName(message) {
  if (message.source === 'swipe') {
    const swipe = SWIPES.find((item) => item.id === message.gesture);
    return swipe ? `${swipe.glyph} ${swipe.label}` : `Swipe ${message.gesture}`;
  }
  const pose = GESTURES.find((item) => item.id === message.gesture);
  return pose ? `${pose.glyph} ${pose.label}` : message.gesture;
}

$('cloud-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('cloud-error').textContent = '';
  $('cloud-use').disabled = true;
  const reply = await chrome.runtime.sendMessage({ type: 'jester/desktop-cloud', op: 'use', link: $('cloud-link').value });
  $('cloud-use').disabled = false;
  if (reply?.ok) {
    $('cloud-link').value = '';
    $('cloud-error').textContent = 'Restarting…';
  } else $('cloud-error').textContent = reply?.error || 'Jester didn’t answer.';
});
$('cloud-signin').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('cloud-signin-error').textContent = '';
  $('cloud-signin-go').disabled = true;
  const reply = await chrome.runtime.sendMessage({ type: 'jester/desktop-cloud', op: 'sign-in', server: $('cloud-server').value, password: $('cloud-password').value });
  $('cloud-signin-go').disabled = false;
  $('cloud-password').value = '';
  if (!reply?.ok) $('cloud-signin-error').textContent = reply?.error || 'That didn’t work.';
});
$('cloud-off').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'jester/desktop-cloud', op: 'off' }));

chrome.runtime.onMessage.addListener((message) => {
  switch (message?.type) {
    case 'jester/desktop-state':
      desktop = message;
      drawMail(message.mail);
      render();
      break;
    // A download's progress (main.js modelsChanged): the lines that say it, and nothing else redrawn.
    case 'jester/desktop-models':
      if (!desktop) break;
      desktop.models = message.models;
      renderVoice();
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

/**
 * The camera view, asked for while its page (Activity) is on screen, as the
 * extension's popup does: the engine draws one only while someone's asking.
 */
let previewTimer = null;
const askForPreview = () => {
  if (document.visibilityState === 'visible') chrome.runtime.sendMessage({ type: 'jester/desktop-preview' }).catch(() => undefined);
};

/** The window says which screen it shows (screens.js): some pages ask for things only while they're seen. */
export function showing(screen) {
  const activity = screen === 'settings/activity';
  if (activity && !previewTimer) {
    previewTimer = setInterval(askForPreview, 700);
    askForPreview();
  } else if (!activity && previewTimer) {
    clearInterval(previewTimer);
    previewTimer = null;
  }
  // Ollama's models, asked again where they're shown: Settings' list (its Models line) and the Models page.
  if (screen === 'settings' || screen === 'settings/models') renderChatModels();
  // How much he knows about them, counted when the Memory page is opened.
  if (screen === 'settings/memory') vaultOp('known').catch(() => undefined);
}

$('enabled').addEventListener('change', (event) => save({ enabled: event.target.checked }));
$('gesturesEnabled').addEventListener('change', (event) => save({ gesturesEnabled: event.target.checked }));
$('pointerEnabled').addEventListener('change', (event) => save({ pointerEnabled: event.target.checked }));
$('voiceEnabled').addEventListener('change', (event) => save({ voiceEnabled: event.target.checked }));
$('speechModel').addEventListener('change', (event) => save({ speechModel: event.target.value }));
$('continuousAssistant').addEventListener('change', (event) => save({ continuousAssistant: event.target.checked }));
$('agentScreenshots').addEventListener('change', (event) => save({ agentScreenshots: event.target.checked }));
$('keepUnsureSpeech').addEventListener('change', (event) => save({ keepUnsureSpeech: event.target.checked }));
for (const id of ['briefMorning', 'briefEvening', 'checkIns', 'offerWork']) $(id).addEventListener('change', (event) => save({ [id]: event.target.checked }));
$('eveningAt').addEventListener('change', (event) => /^\d\d:\d\d$/.test(event.target.value) && save({ eveningAt: event.target.value }));
$('memoryConversations').addEventListener('change', (event) => save({ memoryConversations: event.target.checked }));
for (const [id, op] of [['vault-choose', 'choose'], ['vault-remove', 'remove'], ['vault-open', 'open'], ['known-open', 'about'], ['vault-privacy', 'privacy'], ['vault-reindex', 'reindex']]) {
  $(id).addEventListener('click', () => vaultOp(op));
}
$('vault-use').addEventListener('click', (event) => vaultOp('use', event.currentTarget.dataset.path));
$('chats-import').addEventListener('click', () => importChats().catch(() => undefined));
$('chats-learn').addEventListener('click', () => vaultOp(desktop?.memory?.learning?.running ? 'learn-stop' : 'learn').catch(() => undefined));
const modelsOp = (message) => chrome.runtime.sendMessage({ type: 'jester/desktop-models', ...message }).catch(() => undefined);
$('models-fetch').addEventListener('click', () => modelsOp({ op: 'fetch' }));
$('models-extra').addEventListener('click', (event) => modelsOp({ op: 'fetch', ids: [event.currentTarget.dataset.id] }));
$('models-stop').addEventListener('click', () => modelsOp({ op: 'stop' }));
$('locationSource').addEventListener('change', (event) => {
  // The place is asked for before it's chosen: until one's set, there's nothing to tell the weather of.
  namingPlace = event.target.value === 'place' && !desktop?.day?.place;
  if (namingPlace) {
    renderDay();
    $('place-name').focus();
    return;
  }
  dayOp({ op: 'source', source: event.target.value });
});
$('place-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('place-set').disabled = true;
  const reply = await dayOp({ op: 'place', text: $('place-name').value });
  $('place-set').disabled = false;
  $('place-error').textContent = reply.ok ? '' : reply.error;
  if (reply.ok) {
    namingPlace = false;
    renderDay();
  }
});
$('location-again').addEventListener('click', () => dayOp({ op: 'locate' }));
$('location-privacy').addEventListener('click', () => dayOp({ op: 'privacy' }));
$('weatherUnits').addEventListener('change', (event) => dayOp({ op: 'units', units: event.target.value }));
$('calendar-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('calendar-add');
  button.disabled = true;
  button.textContent = 'Reading it…';
  $('calendar-error').textContent = '';
  const reply = await dayOp({ op: 'calendar-add', url: $('calendar-url').value, name: $('calendar-name').value });
  button.disabled = false;
  button.textContent = 'Add calendar';
  if (!reply.ok) return void ($('calendar-error').textContent = reply.error);
  $('calendar-url').value = '';
  $('calendar-name').value = '';
});
// Back from System Settings, a vault macOS kept Jester out of is tried again, as Try again does.
window.addEventListener('focus', () => vaultDenied(desktop?.memory) && vaultOp('reindex'));
$('assistantModel').addEventListener('change', async (event) => {
  await save({ assistantModel: event.target.value });
  renderChatModels();
});
for (const use of ['talk', 'act']) {
  $(`local-${use}`).addEventListener('change', (event) => {
    const uses = new Set(localUses());
    if (event.target.checked) uses.add(use);
    else uses.delete(use);
    save({ localModelUses: ['talk', 'act'].filter((job) => uses.has(job)) });
  });
}
$('jesterVoice').addEventListener('change', (event) => save({ jesterVoice: event.target.value }));
// ——— Email: Google's file, signing in and out, and what he tells (main.js jester/mail) ———

function drawMail(mail, { error = null } = {}) {
  if (!mail) return;
  $('mail-connect').hidden = !mail.client || mail.signedIn || mail.connecting;
  $('mail-connect').textContent = mail.problem === 'signin' ? 'Sign in again' : 'Sign in with Google';
  $('mail-cancel').hidden = !mail.connecting;
  $('mail-signout').hidden = !mail.signedIn;
  $('mail-forget').hidden = !mail.client;
  $('mail-client').textContent = mail.client ? 'Choose another…' : 'Choose the file…';
  $('mail-client-hint').textContent = mail.client
    ? 'Kept, sealed, on this computer. It says which Google sign-in Jester uses, and holds nothing of yours.'
    : 'Google has each app sign in through a “client” of its own. In Google Cloud’s console, under Clients, make one of type “Desktop app”, press Download JSON, and choose that file here. It’s read once and kept sealed.';
  $('mail-status').textContent = mail.connecting
    ? 'Waiting for you to finish signing in, in your browser…'
    : mail.signedIn
      ? mail.problem === 'refused'
        ? `Signed in${mail.email ? ` as ${mail.email}` : ''}, but Gmail is refusing to be read. In Google Cloud’s console, check the Gmail API is turned on for the project this file is from.`
        : `Signed in${mail.email ? ` as ${mail.email}` : ''}. Watching for new mail.`
      : mail.problem === 'signin'
        ? 'Google has signed him out: it does that every seven days while the sign-in is in its “Testing” state. Sign in again to go on.'
        : mail.problem === 'client'
          ? 'Google no longer accepts this file’s sign-in client. Choose the file again, or a new one.'
          : mail.client
          ? 'Not signed in.'
          : 'Not set up: choose Google’s file below first.';
  // A state that only arrived (he finished signing in) leaves what was said of the last try as it is.
  if (error !== null) $('mail-error').textContent = error;
  aside('sum-mail', mail.signedIn ? mail.email || 'Signed in' : mail.problem === 'signin' ? 'Sign in again' : 'Off', mail.problem === 'signin' ? 'warn' : '');
}
const mailOp = async (op) => {
  const reply = await chrome.runtime.sendMessage({ type: 'jester/mail', op }).catch(() => null);
  drawMail(reply, { error: reply?.ok === false ? reply.error || '' : '' });
  return reply;
};
for (const [id, op] of [['mail-client', 'client'], ['mail-connect', 'connect'], ['mail-cancel', 'cancel'], ['mail-signout', 'signout'], ['mail-forget', 'forget']]) $(id).addEventListener('click', () => mailOp(op));
for (const id of ['mailWatch', 'mailJudge']) $(id).addEventListener('change', (event) => save({ [id]: event.target.checked }));
mailOp('state');

// ——— Your phone: the topic to subscribe to in the ntfy app, a test, and the switch (main.js jester/phone) ———

function drawPhone(phone, { error = '', sent = false } = {}) {
  if (!phone) return;
  const set = !!phone.topic;
  $('phone-setup').hidden = set;
  $('phone-test').hidden = !set;
  $('phone-renew').hidden = !set;
  $('phone-steps').hidden = !set;
  $('phone-topic').textContent = phone.topic || '';
  $('phoneOn').disabled = !set;
  $('phoneOn').checked = phone.on === true;
  const where = phone.usual ? '' : ` On ${phone.server.replace(/^https:\/\//, '')}.`;
  $('phone-status').textContent = sent ? 'Sent. It should be on your phone in a few seconds.' : phone.on ? `On.${where}${phone.last && !phone.last.ok ? ` The last one didn’t go: ${phone.last.problem}.` : ''}` : set ? `Off: nothing is sent.${where}` : '';
  $('phone-error').textContent = error;
}
const phoneOp = async (op, more = {}) => {
  const reply = await chrome.runtime.sendMessage({ type: 'jester/phone', op, ...more }).catch(() => null);
  drawPhone(reply, { error: reply?.ok ? '' : reply?.error || '', sent: op === 'test' && reply?.ok === true });
  return reply;
};
$('phone-setup').addEventListener('click', () => phoneOp('setup'));
$('phone-renew').addEventListener('click', () => phoneOp('renew'));
$('phone-test').addEventListener('click', async () => {
  $('phone-test').disabled = true;
  await phoneOp('test');
  $('phone-test').disabled = false;
});
$('phoneOn').addEventListener('change', (event) => phoneOp('on', { on: event.target.checked }));
phoneOp('state');

/** The line being played for "Hear it". */
let sample = null;
$('jester-voice-hear').addEventListener('click', async () => {
  const button = $('jester-voice-hear');
  button.disabled = true;
  sample?.pause();
  const reply = await chrome.runtime.sendMessage({ type: 'jester/desktop-voice', op: 'hear' });
  button.disabled = false;
  $('jester-voice-error').textContent = reply?.ok ? '' : reply?.error || 'Couldn’t make the sound.';
  if (!reply?.ok) return;
  sample = new Audio(`data:${reply.type};base64,${reply.base64}`);
  sample.play().catch(() => undefined);
});
$('voice-print-teach').addEventListener('click', () =>
  chrome.runtime.sendMessage({ type: 'jester/desktop-voiceprint', op: desktop?.continuous?.teaching ? 'cancel' : 'teach' }));
$('voice-print-forget').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'jester/desktop-voiceprint', op: 'forget' }));
$('forget-conversations').addEventListener('click', async (event) => {
  await chrome.runtime.sendMessage({ type: 'jester/desktop-forget' });
  event.target.textContent = 'Forgotten';
});
window.addEventListener('focus', renderChatModels);
$('pointerAim').addEventListener('change', (event) => save({ pointerAim: event.target.value }));
$('headSpeed').addEventListener('change', (event) => save({ headSpeed: Number(event.target.value) }));
$('calibrate').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'jester/desktop-calibrate' }));
$('watchEnabled').addEventListener('change', (event) => save({ watchEnabled: event.target.checked }));
$('watchSpeed').addEventListener('change', (event) => save({ watchSpeed: Number(event.target.value) }));
$('watchInvertY').addEventListener('change', (event) => save({ watchInvertY: event.target.checked }));
$('watch-pair').addEventListener('click', (event) => watchOp(event.target.dataset.op));
$('watch-cancel').addEventListener('click', () => watchOp('cancel'));
$('restart').addEventListener('click', (event) => {
  event.target.disabled = true;
  event.target.textContent = 'Restarting…';
  chrome.runtime.sendMessage({ type: 'jester/desktop-restart' });
});
$('cameraDeviceId').addEventListener('change', (event) => save({ cameraDeviceId: event.target.value }));
$('windowedBindingsEnabled').addEventListener('change', (event) => save({ windowedBindingsEnabled: event.target.checked }));

/** Fills Settings in from the app: called once, as the window opens. */
export async function startSettings() {
  settings = await readSettings();
  desktop = await chrome.runtime.sendMessage({ type: 'jester/desktop-state' });
  buildBindings();
  buildShortcuts();
  buildConnectionForm();
  render();
  connections('list');
  renderChatModels();
  renderCalibration();
  await renderCameras();
  navigator.mediaDevices?.addEventListener?.('devicechange', renderCameras);
}
