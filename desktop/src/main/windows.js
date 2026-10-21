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

export function settingsWindow() {
  return settings && !settings.isDestroyed() ? settings : null;
}
