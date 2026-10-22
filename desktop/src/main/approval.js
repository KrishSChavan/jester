/**
 * The assistant's question — "Type “hello” in “Message”, then Enter?" — as a
 * small window of its own, just above the voice pill, with Allow and Don't.
 *
 * The overlay lets every click through to the apps below it, and asking it to
 * take some didn't work: a click on its Allow landed in the app underneath,
 * which came to the front. This window takes clicks itself, and without making
 * Jester the active app, so the app the assistant works in stays in front.
 */

import { BrowserWindow, screen } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { postTo } from './chrome-bridge.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD = path.join(here, '../preload/chrome-shim.cjs');
const PAGE = 'jester://app/overlay/approval.html';
const WIDTH = 600;
const HEIGHT = 64;
/** Its bottom edge above the usable area's: clear of the voice pill (24 + 46 px) and a gap. */
const ABOVE = 84;

export function createApprovalPrompt() {
  let win = null;
  let text = '';

  /** Over the display with the pointer, centred, above the Dock. */
  function place() {
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    return { width: WIDTH, height: HEIGHT, x: Math.round(area.x + (area.width - WIDTH) / 2), y: Math.round(area.y + area.height - HEIGHT - ABOVE) };
  }

  return {
    show(question) {
      text = question;
      if (win && !win.isDestroyed()) {
        win.setBounds(place());
        postTo(win.webContents, { type: 'jester/approval-text', text });
        win.showInactive();
        return;
      }
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
        webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true }
      });
      win.setAlwaysOnTop(true, 'screen-saver');
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
      const shown = win;
      shown.webContents.once('did-finish-load', () => {
        if (shown.isDestroyed()) return;
        postTo(shown.webContents, { type: 'jester/approval-text', text });
        shown.showInactive();
      });
      shown.loadURL(PAGE);
    },
    hide() {
      if (win && !win.isDestroyed()) win.destroy();
      win = null;
    }
  };
}
