/**
 * What a ringing timer sounds and looks like (ring.js): a small pill at the
 * top of the screen that rings, names the timer and has a Stop to click
 * (src/overlay/ring.html). The window is the sound: closing it ends both.
 *
 * A window of its own, like the × beside the voice pill (stop-button.js): the
 * overlay lets every click through. It takes clicks without making Jester the
 * active app, and it needs no mic, so it rings whether or not he's listening.
 */

import { BrowserWindow, screen } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD = path.join(here, '../preload/chrome-shim.cjs');
const PAGE = 'jester://app/overlay/ring.html';
const SIZE = { width: 320, height: 56 };
/** Below the menu bar, clear of a notch. */
const FROM_TOP = 14;

/** @param {{muted?:boolean}} [options]  muted: shown and silent (a check, which nobody should have to hear) */
export function createRingPage({ muted = false } = {}) {
  let win = null;
  const up = () => win && !win.isDestroyed();

  function place() {
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    return { x: Math.round(area.x + (area.width - SIZE.width) / 2), y: area.y + FROM_TOP, ...SIZE };
  }

  return {
    show(label) {
      if (up()) win.destroy();
      win = new BrowserWindow({
        ...place(),
        transparent: true,
        frame: false,
        hasShadow: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        // Clicks reach it; Jester doesn't become the active app.
        focusable: false,
        acceptFirstMouse: true,
        skipTaskbar: true,
        show: false,
        type: process.platform === 'darwin' ? 'panel' : 'toolbar',
        // Sound with nobody having clicked in it, and its beat kept while it isn't in front.
        webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' }
      });
      win.webContents.setAudioMuted(muted);
      win.setAlwaysOnTop(true, 'pop-up-menu');
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
      const shown = win;
      shown.webContents.once('did-finish-load', () => {
        if (!shown.isDestroyed()) shown.showInactive();
      });
      // The timer's name goes with the address: the page has nothing to ask for.
      shown.loadURL(`${PAGE}#${encodeURIComponent(label)}`);
    },
    hide() {
      if (up()) win.destroy();
      win = null;
    },
    /** For a check: the window, while it's up. */
    get window() {
      return up() ? win : null;
    }
  };
}
