/**
 * The app's windows: the hidden one the engine runs in, Jester's own window
 * (the orb, his chats and Settings, all in one), and the calibration screen.
 */

import { app, BrowserWindow, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { postTo } from './chrome-bridge.js';
import { ENGINE_PAGE } from './engine-host.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD = path.join(here, '../preload/chrome-shim.cjs');
const HOME_PAGE = 'jester://app/home/home.html';
/** Behind the page while it loads: the window never flashes white. */
const HOME_GROUND = '#08060c';
/**
 * His icon on the window and the taskbar, where the window says what it is (Windows; Linux takes a PNG). A Mac
 * takes the app's icon from Jester.app instead.
 */
const ICON = { win32: '../../icons/Jester.ico', linux: '../../icons/jester.png' }[process.platform];

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

let home = null;
/** What the window shows: 'main' (the orb), 'chats', 'chat', 'settings' or 'settings/<page>' (home/screens.js). */
let homeScreen = 'main';
const homeListeners = new Set();
/** Observe visibility without moving or focusing the window. */
export function onHomeVisibility(listener) {
  homeListeners.add(listener);
  return () => homeListeners.delete(listener);
}
const changedHome = (visible) => { for (const listener of homeListeners) listener({ visible }); };

const showable = (screen) => (/^(main|chats|settings(\/[a-z-]+)?)$/.test(String(screen)) ? String(screen) : 'main');

/**
 * Jester shows in the Dock and ⌘-Tab while a window of his own is open (his window, or calibration's), minimized
 * or not, and leaves once none is. The click-through windows over each display are always "visible", so they don't
 * count.
 */
function leaveDockIfAlone() {
  const open = (win) => win && !win.isDestroyed() && (win.isVisible() || win.isMinimized());
  if (!open(home) && !open(calibration) && !open(controls) && !open(cloud)) app.dock?.hide();
}

/**
 * Jester's one window: the orb and talking to him, with Chats and Settings
 * sliding in beside it (src/home/). Opening it puts him in the Dock and ⌘-Tab
 * while it's open; otherwise he lives in the menu bar only. Opened where it
 * wasn't on screen, the orb's intro plays, unless it opens on another screen.
 * `quiet` shows it without taking focus (tests).
 * @param {{screen?:string, quiet?:boolean}} [options]
 */
export function showHome({ screen = 'main', quiet = false } = {}) {
  const goTo = showable(screen);
  // Using him in the cloud, talking to him and his chats are the server's: its page, in a window of its own.
  if (cloudPage && !goTo.startsWith('settings')) return showCloud({ quiet });
  if (home && !home.isDestroyed()) {
    const away = !home.isVisible() || home.isMinimized();
    if (home.isMinimized()) home.restore();
    const go = { type: 'jester/home-go', screen: goTo, intro: away };
    postTo(home.webContents, go);
    // Still loading, the page isn't listening yet: it's told again once it is.
    if (home.webContents.isLoading()) home.webContents.once('did-finish-load', () => postTo(home.webContents, go));
    if (quiet) home.showInactive();
    else {
      app.dock?.show();
      home.show();
      home.focus();
    }
    return home;
  }
  homeScreen = goTo;
  home = new BrowserWindow({
    width: 600,
    height: 760,
    minWidth: 460,
    minHeight: 560,
    title: 'Jester',
    show: false,
    backgroundColor: HOME_GROUND,
    // Jester lives in the menu bar, so its window often opens inactive: a
    // first click should press the button, not just bring the window forward.
    acceptFirstMouse: true,
    // The page draws to the top of the window, around the window's own buttons.
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 18, y: 20 } } : { titleBarOverlay: { color: HOME_GROUND, symbolColor: '#a79bbe', height: 56 } }),
    ...(ICON ? { icon: path.join(here, ICON) } : {}),
    webPreferences: pageDefaults
  });
  home.once('ready-to-show', () => {
    if (quiet) home.showInactive();
    else {
      app.dock?.show();
      home.show();
      home.focus();
    }
    // On screen: the orb's intro can play now, and be seen from its first frame.
    postTo(home.webContents, { type: 'jester/home-shown' });
  });
  home.on('closed', () => {
    home = null;
    homeScreen = 'main';
    changedHome(false);
    leaveDockIfAlone();
  });
  for (const event of ['show', 'restore']) home.on(event, () => changedHome(true));
  for (const event of ['hide', 'minimize']) home.on(event, () => changedHome(false));
  home.loadURL(`${HOME_PAGE}#${goTo}`);
  return home;
}

/** Settings, in the one window: `page` opens one of its pages ('permissions', say). */
export function showSettings({ quiet = false, page = '' } = {}) {
  return showHome({ screen: page ? `settings/${page}` : 'settings', quiet });
}

/** The orb, and talking to him. */
export function showTalk() {
  return showHome({ screen: 'main' });
}

/**
 * The Dock icon clicked, or Jester launched again: his window, brought forward as it is, on whatever screen it's
 * on, minimized or hidden or not. Back from minimized or hidden on the orb, the orb's intro plays, as for any
 * opening; on another screen, nothing moves. With no window open, it opens on the orb.
 */
export function reopenHome() {
  if (cloudPage) return showCloud();
  const win = homeWindow();
  if (!win) return showHome();
  const away = !win.isVisible() || win.isMinimized();
  if (win.isMinimized()) win.restore();
  // Its own screen, so it stays there; the page plays the intro only if that's the orb.
  if (away) postTo(win.webContents, { type: 'jester/home-go', screen: homeScreen, intro: true });
  app.dock?.show();
  win.show();
  win.focus();
  return win;
}

// ---------------------------------------------------------------------------
// Jester in the cloud (cloud-link.js): his window is his server's website
// ---------------------------------------------------------------------------

/** The server's page, with its key ("https://…/?key=…"), while the Mac uses him in the cloud; null otherwise. */
let cloudPage = null;
let cloud = null;
let onCloudFocus = () => undefined;

/** Using him in the cloud from here on, or not (null). `onFocus`: his window was clicked into, so it's the Mac he's talking to. */
export function setCloudPage(page, { onFocus = () => undefined } = {}) {
  cloudPage = page || null;
  onCloudFocus = onFocus;
  if (!cloudPage && cloud && !cloud.isDestroyed()) cloud.close();
}

/**
 * His window, as his server's website. No preload: it's another site's page, and gets the `chrome` its own shim
 * (web/shim.js) gives it, over its socket. Its mic is never its own: the Mac's voice page is his ears here, and
 * Electron refuses the page any media (installMediaPermissions only allows jester:// pages).
 */
function showCloud({ quiet = false } = {}) {
  if (cloud && !cloud.isDestroyed()) {
    if (cloud.isMinimized()) cloud.restore();
    if (quiet) cloud.showInactive();
    else {
      app.dock?.show();
      cloud.show();
      cloud.focus();
    }
    return cloud;
  }
  cloud = new BrowserWindow({
    width: 600,
    height: 760,
    minWidth: 380,
    minHeight: 560,
    title: 'Jester',
    show: false,
    backgroundColor: HOME_GROUND,
    acceptFirstMouse: true,
    ...(ICON ? { icon: path.join(here, ICON) } : {}),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false }
  });
  // Links in it open in the browser, never in a window of Jester's that has his session.
  cloud.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  cloud.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== new URL(cloudPage).origin) event.preventDefault();
  });
  cloud.once('ready-to-show', () => {
    if (quiet) cloud.showInactive();
    else {
      app.dock?.show();
      cloud.show();
      cloud.focus();
    }
  });
  cloud.on('focus', () => onCloudFocus());
  cloud.on('closed', () => {
    cloud = null;
    leaveDockIfAlone();
  });
  cloud.loadURL(cloudPage);
  return cloud;
}

/** The window says what it shows as it changes (jester/home-screen). */
export function noteHomeScreen(screen) {
  homeScreen = String(screen || 'main');
}

/** The window, if it's open. */
export function homeWindow() {
  return home && !home.isDestroyed() ? home : null;
}

/**
 * The window, if the user's there with the orb showing: the conversation is shown there, and not on the pill too.
 * In front: Electron can't tell a window covered by other apps' from one that's seen, and the pill should be where
 * the conversation's shown then.
 */
export function talkWindow() {
  return home && !home.isDestroyed() && home.isVisible() && !home.isMinimized() && home.isFocused() && homeScreen === 'main' ? home : null;
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

let controls = null;
const CONTROLS_PAGE = 'jester://app/controls/controls.html';

/**
 * Controls: a card for each of the user's scripts, and their scenes (src/controls/). A window of its own, unlike
 * Chats and Settings (the user, 2026-11-18: "create a new window called controls"), small enough to sit beside
 * what they're doing, like a remote. `onShown`: it's come to the front, so what's on is worth reading again.
 * @param {{quiet?:boolean, onShown?:() => void}} [options]
 */
export function showControls({ quiet = false, onShown = () => undefined } = {}) {
  if (controls && !controls.isDestroyed()) {
    if (controls.isMinimized()) controls.restore();
    if (quiet) controls.showInactive();
    else {
      app.dock?.show();
      controls.show();
      controls.focus();
    }
    return controls;
  }
  controls = new BrowserWindow({
    width: 440,
    height: 700,
    minWidth: 360,
    minHeight: 420,
    title: 'Controls',
    show: false,
    backgroundColor: HOME_GROUND,
    acceptFirstMouse: true,
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 18, y: 18 } } : { titleBarOverlay: { color: HOME_GROUND, symbolColor: '#a79bbe', height: 52 } }),
    ...(ICON ? { icon: path.join(here, ICON) } : {}),
    webPreferences: pageDefaults
  });
  controls.once('ready-to-show', () => {
    if (quiet) controls.showInactive();
    else {
      app.dock?.show();
      controls.show();
      controls.focus();
    }
  });
  controls.on('focus', () => onShown());
  controls.on('closed', () => {
    controls = null;
    leaveDockIfAlone();
  });
  controls.loadURL(CONTROLS_PAGE);
  return controls;
}

/** The Controls window, if it's open. */
export function controlsWindow() {
  return controls && !controls.isDestroyed() ? controls : null;
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
    ...(ICON ? { icon: path.join(here, ICON) } : {}),
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
    leaveDockIfAlone();
  });
  calibration.loadURL(CALIBRATION_PAGE);
  return calibration;
}
