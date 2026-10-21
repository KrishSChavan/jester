/**
 * The overlay: one transparent, click-through window over each display,
 * above everything (full-screen apps included), that never takes focus. It
 * draws Jester's feedback — how long a pose has been held, what an action
 * just did — and, from phase 3, the cursor.
 *
 * Feedback goes to the display the user is working on, taken to be the one
 * with the mouse pointer.
 */

import { BrowserWindow, screen } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { post, postTo } from './chrome-bridge.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD = path.join(here, '../preload/chrome-shim.cjs');
const PAGE = 'jester://app/overlay/overlay.html';

function makeWindow(display) {
  const win = new BrowserWindow({
    ...display.bounds,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    show: false,
    // A panel on macOS can float over other apps' full-screen spaces.
    type: process.platform === 'darwin' ? 'panel' : 'toolbar',
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, backgroundThrottling: false }
  });
  win.setIgnoreMouseEvents(true);
  win.setAlwaysOnTop(true, 'screen-saver');
  // skipTransformProcessType: don't let this put Jester back in the Dock.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  win.loadURL(`${PAGE}?display=${display.id}`);
  win.once('ready-to-show', () => win.showInactive());
  return win;
}

export function createOverlays() {
  const windows = new Map();
  let active = null;
  let showHud = true;

  function build() {
    const displays = screen.getAllDisplays();
    for (const [id, win] of windows) {
      if (displays.some((display) => display.id === id)) continue;
      win.destroy();
      windows.delete(id);
    }
    for (const display of displays) {
      const win = windows.get(display.id);
      if (win) win.setBounds(display.bounds);
      else windows.set(display.id, makeWindow(display));
    }
    active = null;
  }
  screen.on('display-added', build);
  screen.on('display-removed', build);
  screen.on('display-metrics-changed', build);
  build();

  const cursorDisplay = () => screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id;

  return {
    /** Re-reads which display has the pointer; cheap enough to call often. */
    track(hud = showHud) {
      const id = cursorDisplay();
      if (id === active && hud === showHud) return;
      active = id;
      showHud = hud;
      post({ type: 'jester/overlay-active', display: id, showHud });
    },
    /** A short message on the active display. `tone`: 'info' | 'warn'. */
    toast(text, { tone = 'info', detail = '' } = {}) {
      const win = windows.get(active ?? cursorDisplay());
      if (win && !win.isDestroyed()) postTo(win.webContents, { type: 'jester/overlay-toast', text, tone, detail });
    },
    windows: () => [...windows.values()],
    /** The overlay on the display with the pointer. */
    activeWindow: () => windows.get(active ?? cursorDisplay()) || null,
    destroy() {
      for (const win of windows.values()) if (!win.isDestroyed()) win.destroy();
      windows.clear();
    }
  };
}
