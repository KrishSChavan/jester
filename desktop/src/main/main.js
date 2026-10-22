/**
 * Jester Desktop.
 *
 * Lives in the menu bar (the notification area on Windows). The extension's
 * engine (src/offscreen/offscreen.html) runs unchanged in a hidden window;
 * the main process plays its service worker, keeps the settings, and asks the
 * OS for the permissions Jester needs.
 *
 * Environment, for development and tests:
 *   JESTER_FAKE_MEDIA=1       Chromium's synthetic camera and mic, treated as allowed
 *   JESTER_FAKE_AUDIO=a.wav   with FAKE_MEDIA: the mic plays this file, once
 *   JESTER_SAVE_SPEECH=dir    keep each spoken command as a WAV + what was heard
 *   JESTER_DATA_DIR=path      keep settings somewhere other than the user's
 *   JESTER_SPIKE_SECONDS=n    quit after n seconds
 *   JESTER_LOG=1              log engine status, gestures, telemetry and CPU
 *   JESTER_OPEN_SETTINGS=1    open Settings at launch
 *   JESTER_SELFTEST=1         check Settings ⇄ engine, logging what it sees
 *   JESTER_SELFTEST_CALIBRATE=1  also press Start on calibration (takes the screen)
 *   JESTER_SELFTEST_VOICE=1   also speak one command (FAKE_AUDIO) and log what it did
 *   JESTER_CAPTURE=file.png   with SELFTEST: save a picture of the whole page
 *   JESTER_THEME=light|dark   override the system's appearance
 */

import { app, BrowserWindow, globalShortcut, nativeTheme, screen, session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { ENGINE, MSG, saveSettings } from '../../../jester-extension/src/common/constants.js';
import { installBridge, onMessage, onStorageChanged, post, storage } from './chrome-bridge.js';
import { createDispatcher } from './dispatch.js';
import { startDriver } from './driver.js';
import { desktopSettings, loadSettings, startEngineHost } from './engine-host.js';
import { fillsDisplay } from './os-actions.js';
import { createOverlays } from './overlay.js';
import { createPointer } from './pointer.js';
import { missingNeeded } from './permission-list.js';
import { openSettings, readPermissions, readStatuses, requestPermission } from './permissions.js';
import { registerScheme, serveFiles } from './protocol.js';
import { startSpeech } from './speech.js';
import { createTray } from './tray.js';
import { trayModel } from './tray-menu.js';
import { createVoiceRunner, runFile } from './voice-runner.js';
import { closeSafely, createEngineWindow, showCalibration, showSettings } from './windows.js';

const env = process.env;
/** Permissions change in System Settings, behind the app's back. */
const PERMISSION_POLL_MS = 2000;
/** How often the front window is checked: it decides which binding set is live. */
const FRONT_POLL_MS = 500;
/** The extension's voice shortcut, kept for the desktop. */
const VOICE_SHORTCUT = 'Alt+Shift+J';

registerScheme();
if (env.JESTER_DATA_DIR) app.setPath('userData', path.resolve(env.JESTER_DATA_DIR));
// Read by the speech service, which inherits this environment.
if (env.JESTER_SAVE_SPEECH) env.JESTER_SAVE_SPEECH = path.resolve(env.JESTER_SAVE_SPEECH);
if (env.JESTER_FAKE_MEDIA) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  if (env.JESTER_FAKE_AUDIO) {
    app.commandLine.appendSwitch('use-file-for-fake-audio-capture', `${path.resolve(env.JESTER_FAKE_AUDIO)}%noloop`);
    // Chromium's sandboxed audio process can't read the file; audio in this process can.
    app.commandLine.appendSwitch('disable-features', 'AudioServiceOutOfProcess');
  }
}

const log = env.JESTER_LOG ? (...parts) => console.log('[jester]', ...parts) : () => undefined;

let engineWindow = null;
let engineHost = null;
let tray = null;
let overlays = null;
let pointer = null;
/** What the pointer asked the driver for, during a self-test. */
const pointerCalls = [];
/** The self-test's ear: called with the next voice command and how it went. */
let voiceHeard = null;
let driver = null;
let dispatch = null;
let speech = null;
let voiceRunner = null;
let quitting = false;
let engine = { state: 'off', detail: '' };
let permissions = [];
let settings = null;
/** 'fullscreen' while the front window fills its display, as in the extension. */
let context = 'windowed';

/** The display the cursor aims at: the main one, which has the camera on a laptop. */
const pointerDisplay = () => screen.getPrimaryDisplay();

function primaryScreen() {
  const { width, height } = pointerDisplay().size;
  return { w: width, h: height };
}

/** CPU since the last call, per process, so a 5 s interval reads as a 5 s average. */
function cpuReport() {
  const metrics = app.getAppMetrics();
  const enginePid = engineWindow?.webContents.getOSProcessId();
  const pct = (metric) => (metric ? Math.round(metric.cpu.percentCPUUsage) : 0);
  const mb = (metric) => Math.round((metric?.memory?.workingSetSize || 0) / 1024);
  const engineMetric = metrics.find((m) => m.pid === enginePid);
  const gpu = metrics.find((m) => m.type === 'GPU');
  const main = metrics.find((m) => m.type === 'Browser');
  const speechMetric = metrics.find((m) => m.serviceName === 'Jester speech' || m.name === 'Jester speech');
  const total = metrics.reduce((sum, m) => sum + mb(m), 0);
  return `cpu engine ${pct(engineMetric)}% gpu ${pct(gpu)}% all ${metrics.reduce((sum, m) => sum + pct(m), 0)}% · MB engine ${mb(engineMetric)} gpu ${mb(gpu)} main ${mb(main)} speech ${mb(speechMetric)} total ${total}`;
}

/** Only media macOS (or Windows) has actually granted, so no prompt ever comes from the hidden window. */
function mediaAllowed(type) {
  if (env.JESTER_FAKE_MEDIA) return true;
  const status = readStatuses();
  if (type === 'video') return status.camera === 'granted';
  if (type === 'audio') return status.microphone === 'granted';
  return status.camera === 'granted' || status.microphone === 'granted';
}

function installMediaPermissions() {
  const own = (url) => /^jester:\/\//.test(url || '');
  // Full screen too: the calibration screen takes the whole display to know
  // exactly where each dot is, and waits on being allowed to.
  session.defaultSession.setPermissionCheckHandler((_contents, permission, origin, details) =>
    own(origin) && (permission === 'fullscreen' || (permission === 'media' && mediaAllowed(details.mediaType))));
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const types = details.mediaTypes?.length ? details.mediaTypes : ['unknown'];
    const allowed = own(details.requestingUrl) && (permission === 'fullscreen' || (permission === 'media' && types.every(mediaAllowed)));
    if (!allowed) log('refused permission', permission, 'for', details.requestingUrl);
    callback(allowed);
  });
}

/** A first launch stores the desktop defaults, so every later save starts from them. */
async function seedSettings() {
  const { settings } = await storage.local.get('settings');
  if (!settings) await storage.local.set({ settings: desktopSettings(undefined) });
}

function desktopState() {
  return {
    type: 'jester/desktop-state',
    platform: process.platform,
    engine,
    permissions,
    missing: missingNeeded(permissions).map((item) => item.id),
    voice: voiceState(),
    speechModel: speech?.model || null,
    speechChoices: speech?.choices || [],
    fakeMedia: !!env.JESTER_FAKE_MEDIA
  };
}

/** The speech model: 'ready', 'off' or 'missing' (see speech.js). */
const voiceState = () => speech?.state || 'missing';

async function refresh() {
  settings = await loadSettings();
  speech?.setModel(settings.speechModel);
  speech?.setEnabled(settings.enabled && settings.voiceEnabled);
  tray?.update(trayModel({ engine, settings, missing: missingNeeded(permissions), voice: voiceState() }));
  post(desktopState());
}

/** jester-driver, restarted if it dies. JESTER_DRIVER_DRY=1: it describes input instead of sending it. */
function startInput() {
  try {
    driver = startDriver({
      dryRun: !!env.JESTER_DRIVER_DRY,
      onExit: (code, signal) => {
        driver = null;
        if (quitting) return;
        log('jester-driver exited', signal || code, '— restarting');
        setTimeout(startInput, 1000);
      }
    });
  } catch (err) {
    driver = null;
    log(err.message);
  }
}

/** macOS drops synthetic input silently until Accessibility is allowed. */
function canPost() {
  if (env.JESTER_DRIVER_DRY || process.platform !== 'darwin') return true;
  return !!permissions.find((item) => item.id === 'accessibility')?.granted;
}

function onJester(op) {
  if (op === 'voice') toggleVoice();
  else if (op === 'calibrate') showCalibration(pointerDisplay());
  else if (op === 'settings') showSettings();
}

/** Why the mic can't open for a command right now, or '' if it can. `mic: false` leaves the permission out. */
function voiceProblem({ mic = true } = {}) {
  if (!settings?.enabled) return 'Jester is off';
  if (!settings.voiceEnabled) return 'Voice commands are off in Jester’s Settings';
  if (engine.state === ENGINE.SLEEPING) return 'Jester is asleep: make your wake gesture first';
  if (voiceState() === 'missing') return 'The speech model isn’t installed (in desktop/: npm run models)';
  if (mic && !mediaAllowed('audio')) return 'Allow the Microphone in Jester’s Settings first';
  return '';
}

/** The voice shortcut, gesture or menu item: start listening, or finish. */
function toggleVoice() {
  const problem = voiceProblem({ mic: false });
  if (problem) return overlays?.toast('Voice commands', { tone: 'warn', detail: problem });
  if (!mediaAllowed('audio')) {
    // Not asked yet: the first command asks macOS, and goes ahead if allowed.
    if (process.platform === 'darwin' && readStatuses().microphone === 'not-determined') {
      requestPermission('microphone').then((granted) => {
        checkPermissions();
        if (granted) toggleVoice();
      });
      return;
    }
    return overlays?.toast('Voice commands', { tone: 'warn', detail: voiceProblem() });
  }
  voiceRunner.prepare();
  engineHost.voice('toggle');
}

/** A finished utterance, done; the pill says how it went. */
async function onVoiceCommand(text) {
  const { outcome } = await voiceRunner.run(text);
  post({ type: MSG.VOICE, voice: outcome ? { phase: 'answer', text: outcome.text, ok: outcome.ok } : { active: false } });
  voiceHeard?.({ text, outcome });
  voiceHeard = null;
}

/**
 * Twice a second: which display has the pointer (where feedback goes), and
 * whether the front window fills its display (which binding set is live).
 */
function watchFront() {
  let busy = false;
  let frontPid = null;
  setInterval(async () => {
    overlays?.track(settings?.showHud !== false);
    if (busy || !driver) return;
    busy = true;
    try {
      const front = await driver.call('frontmost');
      // Chromium apps take ~2 s to build the tree aim-assist reads: start as
      // soon as an app comes to the front, while the cursor is in use.
      if (settings?.pointerEnabled && front.app?.pid && front.app.pid !== frontPid) driver.call('wake', { pid: front.app.pid }).catch(() => undefined);
      frontPid = front.app?.pid ?? frontPid;
      let bounds = front.window?.bounds;
      // The driver speaks physical pixels on Windows; displays are in DIPs.
      if (bounds && process.platform === 'win32') {
        const dip = screen.screenToDipRect(null, { x: bounds.x, y: bounds.y, width: bounds.w, height: bounds.h });
        bounds = { x: dip.x, y: dip.y, w: dip.width, h: dip.height };
      }
      const next = fillsDisplay(bounds, screen.getAllDisplays().map((display) => display.bounds)) ? 'fullscreen' : 'windowed';
      if (next !== context) {
        context = next;
        log('context', context, `(${front.app?.name || 'unknown app'})`);
        engineHost?.setContext(context);
      }
    } catch {
      /* no ordinary window in front: keep the last context */
    } finally {
      busy = false;
    }
  }, FRONT_POLL_MS);
}

function checkPermissions() {
  const before = JSON.stringify(permissions);
  const cameraBefore = permissions.find((item) => item.id === 'camera')?.granted;
  permissions = readPermissions();
  if (JSON.stringify(permissions) === before) return;
  const cameraNow = permissions.find((item) => item.id === 'camera')?.granted;
  // The engine checked the camera when it started and stopped there: start it again.
  if (cameraNow && cameraBefore === false) engineWindow?.webContents.reload();
  refresh();
}

async function onTrayAction(id, checked) {
  switch (id) {
    case 'enabled':
      return saveSettings({ enabled: checked });
    case 'pointer':
      return saveSettings({ pointerEnabled: checked });
    case 'voice':
      return saveSettings({ voiceEnabled: checked });
    case 'listen':
      return toggleVoice();
    case 'permissions':
    case 'settings':
      return showSettings();
    case 'quit':
      return app.quit();
    default:
      return undefined;
  }
}

function listenToPages() {
  onMessage(async (message, sender) => {
    const url = String(sender?.url || '');
    // The calibration screen asks the worker how the engine is, as in Chrome.
    if (message?.type === MSG.GET_STATE && url.startsWith('jester://ext/src/calibration/')) return { settings: await loadSettings(), engine };
    if (!url.startsWith('jester://app/')) return undefined;
    switch (message?.type) {
      case 'jester/desktop-calibrate':
        showCalibration(pointerDisplay());
        return { ok: true };
      case 'jester/desktop-state':
        return desktopState();
      case 'jester/desktop-permission':
        if (message.action === 'request') await requestPermission(String(message.id));
        else if (message.action === 'open-settings') openSettings(String(message.id));
        checkPermissions();
        return desktopState();
      default:
        return undefined;
    }
  });
}

/**
 * JESTER_SELFTEST: open Settings without focus and check its two-way path to
 * the engine — what the page shows, and that its "Jester on" switch stops and
 * restarts the engine. JESTER_CAPTURE adds a picture of the whole page.
 */
function selfTest(capture) {
  const win = showSettings({ quiet: true });
  const page = (code) => win.webContents.executeJavaScript(code);
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const shows = () => page(`['status-text', 'camera-stats', 'last-gesture'].map((id) => document.getElementById(id).textContent).join(' | ')`);
  /** Waits for the engine to reach a state, and for the page's camera line to catch up. */
  const reach = async (state, ms = 8000) => {
    for (const until = Date.now() + ms; Date.now() < until; await pause(100)) {
      if (engine.state === state && (state !== 'running' || /fps/.test(await shows()))) return true;
    }
    return false;
  };
  win.webContents.once('did-finish-load', async () => {
    if (capture) {
      await pause(1500);
      win.setContentSize(win.getContentSize()[0], await page('document.documentElement.scrollHeight'));
      await pause(400);
      fs.writeFileSync(capture, (await win.webContents.capturePage()).toPNG());
      log('selftest: captured', capture);
      // The page outgrows the screen: each later section scrolled into view too.
      for (const section of ['gestures', 'shortcuts']) {
        await page(`document.getElementById('${section}-heading').scrollIntoView()`);
        await pause(300);
        const file = capture.replace(/\.png$/, `-${section}.png`);
        fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
        log('selftest: captured', file);
      }
    }
    await reach('running');
    log('selftest: settings shows', await shows());
    log('selftest: voice row —', await page(`(() => { const box = document.getElementById('voiceEnabled'); return (box.checked ? '☑ ' : '☐ ') + (box.disabled ? '(disabled) ' : '') + document.getElementById('voice-hint').textContent; })()`));
    log('selftest: speech model row —', await page(`(() => { const select = document.getElementById('speechModel'); return [...select.options].map((o) => (o.selected ? '▸' : '') + o.text + (o.disabled ? ' [off]' : '')).join(' | ') + ' — ' + document.getElementById('speech-model-hint').textContent; })()`));
    await page(`document.getElementById('enabled').click()`);
    log('selftest: switched off —', (await reach('off')) ? 'engine off' : `engine still ${engine.state}`, '|', await shows());
    await page(`document.getElementById('enabled').click()`);
    log('selftest: switched on —', (await reach('running')) ? 'engine running' : `engine still ${engine.state}`, '|', await shows());

    // Gestures' actions, as far as the driver — and only a dry-run driver,
    // which describes input instead of sending it: never press real keys here.
    if (!env.JESTER_DRIVER_DRY) return log('selftest: skipping actions (set JESTER_DRIVER_DRY=1)');

    for (const [action, gesture] of [['VOLUME_UP', 'Thumb_Up'], ['APP_NEXT', 'Victory'], ['SPEED_UP', 'ILoveYou']]) {
      log('selftest: dispatch', action, '→', JSON.stringify(await dispatch(action, { source: 'pose', gesture })));
    }
    const overlay = overlays.activeWindow();
    if (capture && overlay) {
      await dispatch('VOLUME_UP', { source: 'pose', gesture: 'Thumb_Up' });
      await pause(400);
      const file = capture.replace(/\.png$/, '-overlay.png');
      fs.writeFileSync(file, (await overlay.webContents.capturePage()).toPNG());
      log('selftest: captured', file);
    }

    // The cursor: frames as the engine sends them, a dry-run driver taking
    // the input, every call to it recorded.
    const bounds = pointerDisplay().bounds;
    const frame = (x, y, extra = {}) =>
      pointer.frame({ active: true, x, y, progress: 0, down: false, click: false, mode: 'head', errorPx: 40, display: { w: bounds.width, h: bounds.height }, ...extra });
    pointerCalls.length = 0;
    for (let i = 0; i < 12; i++) {
      frame(0.3, 0.4);
      await pause(50);
    }
    const moves = pointerCalls.filter(([cmd]) => cmd === 'move');
    log('selftest: cursor', moves.length, 'moves, ending at', JSON.stringify(moves.at(-1)?.[1]), `(aimed at ${Math.round(bounds.x + 0.3 * bounds.width)},${Math.round(bounds.y + 0.4 * bounds.height)})`);
    if (capture && overlay) {
      frame(0.3, 0.4, { progress: 0.5 });
      await pause(200);
      const file = capture.replace(/\.png$/, '-cursor.png');
      fs.writeFileSync(file, (await overlay.webContents.capturePage()).toPNG());
      log('selftest: captured', file);
    }
    // Closing the hand freezes the aim; the click lands there, not where the eyes drifted.
    frame(0.3, 0.4, { progress: 0.6 });
    await pause(60);
    frame(0.36, 0.4, { progress: 1, click: true });
    await pause(1500);
    const clicked = pointerCalls.filter(([cmd]) => cmd === 'click').at(-1)?.[1];
    log('selftest: clicked at', JSON.stringify(clicked), `after ${pointerCalls.filter(([cmd]) => cmd === 'elementAt').length} aim-assist lookups`);
    pointer.frame({ active: false });

    // Voice: the fake mic plays JESTER_FAKE_AUDIO once, and the command in
    // it is heard, matched and done — by the dry-run driver.
    if (env.JESTER_SELFTEST_VOICE) {
      for (const until = Date.now() + 20000; voiceState() !== 'ready' && Date.now() < until; ) await pause(200);
      log('selftest: voice', voiceState(), '·', voiceProblem() || 'can listen');
      const heard = new Promise((resolve) => (voiceHeard = resolve));
      const started = Date.now();
      toggleVoice();
      if (capture && overlay) {
        await pause(1600);
        const file = capture.replace(/\.png$/, '-voice.png');
        fs.writeFileSync(file, (await overlay.webContents.capturePage()).toPNG());
        log('selftest: captured', file);
      }
      const result = await Promise.race([heard, pause(20000).then(() => null)]);
      log('selftest: voice heard', JSON.stringify(result?.text ?? null), '→', JSON.stringify(result?.outcome ?? null), `after ${Date.now() - started} ms`);
      if (capture && overlay && result) {
        await pause(300);
        const file = capture.replace(/\.png$/, '-voice-answer.png');
        fs.writeFileSync(file, (await overlay.webContents.capturePage()).toPNG());
        log('selftest: captured', file);
      }
      // Where the pill is on the screen itself, against the area apps may use.
      if (overlay && result) {
        const fit = await overlay.webContents.executeJavaScript(
          `(() => { const pill = document.getElementById('voice').getBoundingClientRect(); return { pillBottom: Math.round(window.screenY + pill.bottom), usableBottom: screen.availTop + screen.availHeight, screenBottom: screen.height, windowTop: window.screenY }; })()`
        );
        log('selftest: voice pill', JSON.stringify(fit));
      }
    }

    // The extension's calibration screen, unchanged: its checklist is fed by
    // the engine, so it shows whether the two are talking.
    const calibrationWindow = showCalibration(pointerDisplay(), { quiet: true });
    calibrationWindow.webContents.on('console-message', ({ level, message }) => level === 'error' && log('selftest: calibration error:', message));
    await new Promise((resolve) => calibrationWindow.webContents.once('did-finish-load', resolve));
    await pause(4000);
    const checklist = await calibrationWindow.webContents.executeJavaScript(
      `[...document.querySelectorAll('.check')].map((p) => p.textContent.trim() + (p.className.includes('ok') ? ' ✓' : p.className.includes('bad') ? ' ✗' : ' …')).join(', ') + ' — ' + document.getElementById('readout').textContent`
    );
    log('selftest: calibration page —', checklist);
    // Start, as a real click would (a user gesture), then what the page did.
    // Opt-in: a run takes over the whole screen for a moment.
    if (env.JESTER_SELFTEST_CALIBRATE) {
      await calibrationWindow.webContents.executeJavaScript(`document.getElementById('startBtn').click()`, true);
      await pause(2500);
      const after = await calibrationWindow.webContents.executeJavaScript(
        `JSON.stringify({ fullscreen: !!document.fullscreenElement, intro: !document.getElementById('intro').hidden, field: !document.getElementById('field').hidden, hint: document.getElementById('preflightHint').textContent })`
      );
      log('selftest: calibration after Start —', after, `· window full screen ${calibrationWindow.isFullScreen()}, simple ${calibrationWindow.isSimpleFullScreen?.()}`);
      // The page closing itself, as Done does after leaving full screen: the
      // request reaches the main process, which closes the window. (Whether
      // full screen itself goes smoothly needs a focused window: macOS won't
      // put an inactive one in full screen, so this test can't tell.)
      const closed = new Promise((resolve) => calibrationWindow.once('closed', () => resolve(true)));
      await calibrationWindow.webContents.executeJavaScript('window.close()', true).catch(() => undefined);
      const gone = await Promise.race([closed, pause(4000).then(() => false)]);
      log('selftest: calibration after Done —', gone ? 'window closed' : `window still open (full screen: ${calibrationWindow.isFullScreen()})`);
      if (gone) return;
    }
    calibrationWindow.close();
  });
}

async function start() {
  if (!env.JESTER_KEEP_DOCK) app.dock?.hide();
  if (['light', 'dark'].includes(env.JESTER_THEME)) nativeTheme.themeSource = env.JESTER_THEME;
  serveFiles();
  installBridge({ onClose: closeSafely });
  await seedSettings();
  installMediaPermissions();
  permissions = readPermissions();

  // JESTER_NO_OVERLAY (tests): no windows over the displays, toasts dropped.
  overlays = env.JESTER_NO_OVERLAY
    ? { track() {}, toast() {}, cursor() {}, ripple() {}, whileHidden: (task) => task(), windows: () => [], activeWindow: () => null, destroy() {} }
    : createOverlays();
  startInput();
  pointer = createPointer({
    driver: {
      call: (...args) => {
        if (env.JESTER_SELFTEST) pointerCalls.push(args);
        return driver ? driver.call(...args) : Promise.reject(new Error('jester-driver is not running'));
      }
    },
    overlays,
    display: pointerDisplay,
    toast: (text, options) => overlays.toast(text, options),
    log,
    dryRun: !!env.JESTER_DRIVER_DRY
  });
  const input = { call: (...args) => (driver ? driver.call(...args) : Promise.reject(new Error('jester-driver is not running'))) };
  dispatch = createDispatcher({ driver: input, getSettings: loadSettings, canPost, onJester, toast: (text, options) => overlays.toast(text, options), log });
  // Switched on by refresh(), from the settings.
  speech = startSpeech({ log });
  voiceRunner = createVoiceRunner({
    driver: input,
    dispatch,
    canPost,
    onJester,
    // A dry run describes `open`, `osascript` and `shortcuts` too, rather than running them.
    run: env.JESTER_DRIVER_DRY ? async (file, args) => (log('dry run: would run', file, JSON.stringify(args)), '') : runFile,
    log
  });

  let lastTelemetryLog = 0;
  let cursorFrames = 0;
  let micState = '';
  engineHost = startEngineHost({
    screen: primaryScreen,
    context: () => context,
    onStatus: (status) => {
      engine = { state: status.state, detail: status.detail || '' };
      const mic = status.mic ? `${status.mic.state}${status.mic.detail ? `: ${status.mic.detail}` : ''}` : '';
      if (mic !== micState) log('mic', (micState = mic));
      log('status', status.state, status.detail || '');
      refresh();
    },
    onTrigger: (message) => {
      log('trigger', message.action, `(${message.source} ${message.gesture})`);
      dispatch(message.action, { source: message.source, gesture: message.gesture });
    },
    onCursor: (cursor) => {
      cursorFrames += 1;
      if (cursor?.click) log('cursor click at', cursor.x?.toFixed(3), cursor.y?.toFixed(3));
      pointer.frame(cursor);
    },
    onVoiceCommand: (text) => {
      log('voice command:', text);
      onVoiceCommand(text);
    },
    onTelemetry: (telemetry) => {
      const now = Date.now();
      if (now - lastTelemetryLog < 5000) return;
      lastTelemetryLog = now;
      log(`telemetry fps ${telemetry.fps} ${telemetry.delegate} hand ${telemetry.handPresent ? 'yes' : 'no'} gesture ${telemetry.gesture || '-'} · cursor frames ${cursorFrames} · ${cpuReport()}`);
      cursorFrames = 0;
    }
  });
  listenToPages();
  onStorageChanged((changes, area) => {
    if (area === 'local' && changes.settings) refresh();
  });

  engineWindow = createEngineWindow(log);
  tray = createTray(onTrayAction);
  await refresh();
  setInterval(checkPermissions, PERMISSION_POLL_MS);
  watchFront();
  if (!globalShortcut.register(VOICE_SHORTCUT, () => onJester('voice'))) log(`${VOICE_SHORTCUT} is taken by another app`);

  if (env.JESTER_SELFTEST) selfTest(env.JESTER_CAPTURE && path.resolve(env.JESTER_CAPTURE));
  else if (env.JESTER_OPEN_SETTINGS || missingNeeded(permissions).length) showSettings();

  const seconds = Number(env.JESTER_SPIKE_SECONDS);
  // Destroy first: a window stuck mid-close must not keep a test run alive.
  if (seconds > 0) setTimeout(() => (BrowserWindow.getAllWindows().forEach((win) => win.destroy()), app.quit()), seconds * 1000);
}

// One Jester at a time: launching it again opens Settings instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showSettings());
  app.on('activate', () => showSettings());
  app.whenReady().then(start);
  // Closing Settings leaves Jester running in the menu bar.
  app.on('window-all-closed', () => undefined);
  app.on('will-quit', () => {
    quitting = true;
    globalShortcut.unregisterAll();
    driver?.close();
  });
}
