/**
 * Jester Desktop.
 *
 * The extension's engine (src/offscreen/offscreen.html) runs unchanged in a
 * hidden window; the main process plays its service worker.
 *
 * Environment, for spikes and tests:
 *   JESTER_FAKE_MEDIA=1     Chromium's synthetic camera and mic, no prompts
 *   JESTER_DATA_DIR=path    keep settings somewhere other than the user's
 *   JESTER_SPIKE_SECONDS=n  quit after n seconds
 *   JESTER_LOG=1            log engine status, gestures, telemetry and CPU
 */

import { app, BrowserWindow, screen, session } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installBridge } from './chrome-bridge.js';
import { ENGINE_PAGE, startEngineHost } from './engine-host.js';
import { registerScheme, serveFiles } from './protocol.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;

registerScheme();
if (env.JESTER_DATA_DIR) app.setPath('userData', path.resolve(env.JESTER_DATA_DIR));
if (env.JESTER_FAKE_MEDIA) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
}

const log = env.JESTER_LOG ? (...parts) => console.log('[jester]', ...parts) : () => undefined;
let perception = null;

function primaryScreen() {
  const { width, height } = screen.getPrimaryDisplay().size;
  return { w: width, h: height };
}

function createPerceptionWindow() {
  perception = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(here, '../preload/chrome-shim.cjs'),
      contextIsolation: true,
      sandbox: true,
      // The engine's frame loop runs on timers, which Chromium slows to once a
      // second in a window nobody can see.
      backgroundThrottling: false
    }
  });
  perception.webContents.on('console-message', ({ level, message }) => {
    if (level === 'error' || level === 'warning') log(`engine ${level}:`, message);
  });
  perception.webContents.on('render-process-gone', (_event, details) => log('engine renderer gone:', details.reason));
  perception.loadURL(ENGINE_PAGE);
}

/** CPU since the last call, per process, so a 5 s interval reads as a 5 s average. */
function cpuReport() {
  const metrics = app.getAppMetrics();
  const enginePid = perception?.webContents.getOSProcessId();
  const pct = (metric) => (metric ? Math.round(metric.cpu.percentCPUUsage) : 0);
  const mb = (metric) => Math.round((metric?.memory?.workingSetSize || 0) / 1024);
  const engine = metrics.find((m) => m.pid === enginePid);
  const gpu = metrics.find((m) => m.type === 'GPU');
  const main = metrics.find((m) => m.type === 'Browser');
  const total = metrics.reduce((sum, m) => sum + mb(m), 0);
  return `cpu engine ${pct(engine)}% gpu ${pct(gpu)}% all ${metrics.reduce((sum, m) => sum + pct(m), 0)}% · MB engine ${mb(engine)} gpu ${mb(gpu)} main ${mb(main)} total ${total}`;
}

app.whenReady().then(() => {
  serveFiles();
  installBridge();

  // Camera and mic for Jester's own pages only. The engine checks the
  // permission state before opening the camera, as it does in Chrome.
  const own = (url) => /^jester:\/\//.test(url || '');
  session.defaultSession.setPermissionCheckHandler((_contents, permission, origin) => permission === 'media' && own(origin));
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => callback(permission === 'media' && own(details.requestingUrl)));

  let lastTelemetryLog = 0;
  let cursorFrames = 0;
  startEngineHost({
    screen: primaryScreen,
    onStatus: (status) => log('status', status.state, status.detail || ''),
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

  createPerceptionWindow();

  const seconds = Number(env.JESTER_SPIKE_SECONDS);
  if (seconds > 0) setTimeout(() => app.quit(), seconds * 1000);
});

// No windows are meant to be visible yet; the app lives until it is quit.
app.on('window-all-closed', () => undefined);
