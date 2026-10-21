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

import { app, nativeTheme, screen, session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { saveSettings } from '../../../jester-extension/src/common/constants.js';
import { installBridge, onMessage, onStorageChanged, post, storage } from './chrome-bridge.js';
import { desktopSettings, loadSettings, startEngineHost } from './engine-host.js';
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

registerScheme();
if (env.JESTER_DATA_DIR) app.setPath('userData', path.resolve(env.JESTER_DATA_DIR));
if (env.JESTER_FAKE_MEDIA) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
}

const log = env.JESTER_LOG ? (...parts) => console.log('[jester]', ...parts) : () => undefined;

let engineWindow = null;
let tray = null;
let engine = { state: 'off', detail: '' };
let permissions = [];

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
  const settings = await loadSettings();
  tray?.update(trayModel({ engine, settings, missing: missingNeeded(permissions), voiceReady: VOICE_READY }));
  post(desktopState());
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
  win.webContents.once('did-finish-load', async () => {
    await pause(1500);
    if (capture) {
      win.setContentSize(win.getContentSize()[0], await page('document.documentElement.scrollHeight'));
      await pause(400);
      fs.writeFileSync(capture, (await win.webContents.capturePage()).toPNG());
      log('selftest: captured', capture);
    }
    log('selftest: settings shows', await shows());
    await page(`document.getElementById('enabled').click()`);
    await pause(1500);
    log('selftest: after switching off —', engine.state, '|', await shows());
    await page(`document.getElementById('enabled').click()`);
    await pause(2500);
    log('selftest: after switching on —', engine.state, '|', await shows());
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

  let lastTelemetryLog = 0;
  let cursorFrames = 0;
  startEngineHost({
    screen: primaryScreen,
    onStatus: (status) => {
      engine = { state: status.state, detail: status.detail || '' };
      log('status', status.state, status.detail || '');
      refresh();
    },
    onTrigger: (message) => log('trigger', message.action, `(${message.source} ${message.gesture})`),
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
}
