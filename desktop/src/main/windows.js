/**
 * The app's windows: the hidden one the engine runs in, and Settings.
 */

import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE_PAGE } from './engine-host.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD = path.join(here, '../preload/chrome-shim.cjs');
const SETTINGS_PAGE = 'jester://app/settings/settings.html';

const pageDefaults = { preload: PRELOAD, contextIsolation: true, sandbox: true };

/**
 * The extension's engine page, unchanged. Never shown.
 * @param {(...parts:any[]) => void} log
 */
export function createEngineWindow(log) {
  const win = new BrowserWindow({
    show: false,
    // The engine's frame loop runs on timers, which Chromium slows to once a
    // second in a window nobody can see.
    webPreferences: { ...pageDefaults, backgroundThrottling: false }
  });
  win.webContents.on('console-message', ({ level, message }) => {
    if (level === 'error' || level === 'warning') log(`engine ${level}:`, message);
  });
  win.webContents.on('render-process-gone', (_event, details) => log('engine renderer gone:', details.reason));
  win.loadURL(ENGINE_PAGE);
  return win;
}

let settings = null;

/**
 * Opens Settings, or brings it forward. While it is open the app shows in
 * the Dock and ⌘-Tab, so it can be found again; otherwise it lives in the
 * menu bar only. `quiet` shows it without taking focus (tests).
 */
export function showSettings({ quiet = false } = {}) {
  if (settings && !settings.isDestroyed()) {
    settings.show();
    settings.focus();
    return settings;
  }
  settings = new BrowserWindow({
    width: 560,
    height: 720,
    minWidth: 440,
    minHeight: 480,
    title: 'Jester',
    show: false,
    // Jester lives in the menu bar, so its windows often open inactive: a
    // first click should press the button, not just bring the window forward.
    acceptFirstMouse: true,
    webPreferences: pageDefaults
  });
  settings.once('ready-to-show', () => {
    if (quiet) return settings.showInactive();
    app.dock?.show();
    settings.show();
    settings.focus();
  });
  settings.on('closed', () => {
    settings = null;
    if (!BrowserWindow.getAllWindows().some((win) => win.isVisible())) app.dock?.hide();
  });
  settings.loadURL(SETTINGS_PAGE);
  return settings;
}

/**
 * Closes a window, leaving full screen first: a window closed while macOS is
 * animating out of full screen is lost half-way, dead and unclickable.
 * Should the end of the animation never be reported, it closes anyway.
 */
export function closeSafely(win) {
  if (!win || win.isDestroyed()) return;
  if (!win.isFullScreen()) return win.close();
  const destroy = () => {
    clearTimeout(fallback);
    if (!win.isDestroyed()) win.destroy();
  };
  const fallback = setTimeout(destroy, 3000);
  win.once('leave-full-screen', () => setTimeout(destroy, 100));
  win.setFullScreen(false);
}

export function settingsWindow() {
  return settings && !settings.isDestroyed() ? settings : null;
}

let calibration = null;
const CALIBRATION_PAGE = 'jester://ext/src/calibration/calibration.html';

/**
 * The extension's calibration screen, unchanged, on the display the cursor
 * aims at. It takes the whole screen itself when a run starts, which is how
 * it knows exactly where each dot is; Esc or the end of a run closes it.
 */
export function showCalibration(display, { quiet = false } = {}) {
  if (calibration && !calibration.isDestroyed()) {
    calibration.show();
    calibration.focus();
    return calibration;
  }
  const { x, y, width, height } = display.bounds;
  calibration = new BrowserWindow({
    x,
    y,
    width,
    height,
    title: 'Jester calibration',
    backgroundColor: '#000000',
    show: false,
    acceptFirstMouse: true,
    // Full screen from the start. The page asks for full screen when a run
    // starts and leaves it when done; with the window already there, Electron
    // answers both at once instead of animating the window, and a page left
    // waiting on an animation that never ran is a page that has frozen.
    fullscreen: true,
    webPreferences: pageDefaults
  });
  calibration.once('ready-to-show', () => {
    if (quiet) return calibration.showInactive();
    app.dock?.show();
    calibration.show();
    calibration.focus();
  });
  calibration.on('closed', () => {
    calibration = null;
    if (!BrowserWindow.getAllWindows().some((win) => win.isVisible())) app.dock?.hide();
  });
  calibration.loadURL(CALIBRATION_PAGE);
  return calibration;
}
