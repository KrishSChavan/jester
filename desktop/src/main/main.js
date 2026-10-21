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
 *   JESTER_DATA_DIR=path      keep settings somewhere other than the user's
 *   JESTER_SPIKE_SECONDS=n    quit after n seconds
 *   JESTER_LOG=1              log engine status, gestures, telemetry and CPU
 *   JESTER_OPEN_SETTINGS=1    open Settings at launch
 *   JESTER_SELFTEST=1         check Settings ⇄ engine, logging what it sees
 *   JESTER_CAPTURE=file.png   with SELFTEST: save a picture of the whole page
 *   JESTER_THEME=light|dark   override the system's appearance
 */

import { app, globalShortcut, nativeTheme, screen, session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { saveSettings } from '../../../jester-extension/src/common/constants.js';
import { installBridge, onMessage, onStorageChanged, post, storage } from './chrome-bridge.js';
import { createDispatcher } from './dispatch.js';
import { startDriver } from './driver.js';
import { desktopSettings, loadSettings, startEngineHost } from './engine-host.js';
import { fillsDisplay } from './os-actions.js';
import { createOverlays } from './overlay.js';
import { missingNeeded } from './permission-list.js';
import { openSettings, readPermissions, readStatuses, requestPermission } from './permissions.js';
import { registerScheme, serveFiles } from './protocol.js';
import { createTray } from './tray.js';
import { trayModel } from './tray-menu.js';
import { createEngineWindow, showSettings } from './windows.js';

const env = process.env;
/** Voice capture needs the app's own speech engine; it isn't wired in yet. */
const VOICE_READY = false;
/** Permissions change in System Settings, behind the app's back. */
const PERMISSION_POLL_MS = 2000;
/** How often the front window is checked: it decides which binding set is live. */
const FRONT_POLL_MS = 500;
/** The extension's voice shortcut, kept for the desktop. */
const VOICE_SHORTCUT = 'Alt+Shift+J';

registerScheme();
if (env.JESTER_DATA_DIR) app.setPath('userData', path.resolve(env.JESTER_DATA_DIR));
if (env.JESTER_FAKE_MEDIA) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
}

const log = env.JESTER_LOG ? (...parts) => console.log('[jester]', ...parts) : () => undefined;

let engineWindow = null;
let engineHost = null;
let tray = null;
let overlays = null;
let driver = null;
let dispatch = null;
let quitting = false;
let engine = { state: 'off', detail: '' };
let permissions = [];
let settings = null;
/** 'fullscreen' while the front window fills its display, as in the extension. */
let context = 'windowed';

function primaryScreen() {
  const { width, height } = screen.getPrimaryDisplay().size;
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
  const total = metrics.reduce((sum, m) => sum + mb(m), 0);
  return `cpu engine ${pct(engineMetric)}% gpu ${pct(gpu)}% all ${metrics.reduce((sum, m) => sum + pct(m), 0)}% · MB engine ${mb(engineMetric)} gpu ${mb(gpu)} main ${mb(main)} total ${total}`;
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
  session.defaultSession.setPermissionCheckHandler((_contents, permission, origin, details) => permission === 'media' && own(origin) && mediaAllowed(details.mediaType));
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const types = details.mediaTypes?.length ? details.mediaTypes : ['unknown'];
    callback(permission === 'media' && own(details.requestingUrl) && types.every(mediaAllowed));
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
    voiceReady: VOICE_READY,
    fakeMedia: !!env.JESTER_FAKE_MEDIA
  };
}

async function refresh() {
  settings = await loadSettings();
  tray?.update(trayModel({ engine, settings, missing: missingNeeded(permissions), voiceReady: VOICE_READY }));
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
  if (op === 'voice') overlays?.toast('Voice commands', { tone: 'warn', detail: 'Coming in a later update' });
  else if (op === 'calibrate') overlays?.toast('Calibration', { tone: 'warn', detail: 'Arrives with cursor control' });
}

/**
 * Twice a second: which display has the pointer (where feedback goes), and
 * whether the front window fills its display (which binding set is live).
 */
function watchFront() {
  let busy = false;
  setInterval(async () => {
    overlays?.track(settings?.showHud !== false);
    if (busy || !driver) return;
    busy = true;
    try {
      const front = await driver.call('frontmost');
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
    if (!String(sender?.url || '').startsWith('jester://app/')) return undefined;
    switch (message?.type) {
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
  });
}

async function start() {
  app.dock?.hide();
  if (['light', 'dark'].includes(env.JESTER_THEME)) nativeTheme.themeSource = env.JESTER_THEME;
  serveFiles();
  installBridge();
  await seedSettings();
  installMediaPermissions();
  permissions = readPermissions();

  overlays = createOverlays();
  startInput();
  dispatch = createDispatcher({ driver: { call: (...args) => (driver ? driver.call(...args) : Promise.reject(new Error('jester-driver is not running'))) }, getSettings: loadSettings, canPost, onJester, toast: (text, options) => overlays.toast(text, options), log });

  let lastTelemetryLog = 0;
  let cursorFrames = 0;
  engineHost = startEngineHost({
    screen: primaryScreen,
    context: () => context,
    onStatus: (status) => {
      engine = { state: status.state, detail: status.detail || '' };
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
    },
    onVoiceCommand: (text) => log('voice command:', text),
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
  if (seconds > 0) setTimeout(() => app.quit(), seconds * 1000);
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
