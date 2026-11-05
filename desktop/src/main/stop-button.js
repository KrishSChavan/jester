/**
 * The × beside the voice pill while the assistant works, and what it asks
 * first: "Stop automation?", Yes or No. Yes ends the task.
 *
 * A window of its own, like the assistant's question (approval.js): the overlay
 * lets every click through. It takes clicks without making Jester the active
 * app, so the app the task works in stays in front.
 *
 * It stays up while the assistant reads the screen, when the overlay blinks out:
 * a click must never fall through to the app below. So it sits at a lower window
 * level than the overlay, away from what stopped those reads (README).
 */

import { BrowserWindow, screen } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { postTo } from './chrome-bridge.js';
import { besidePill, pillEnd } from './pill-math.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD = path.join(here, '../preload/chrome-shim.cjs');
const PAGE = 'jester://app/overlay/stop.html';
/** The × alone, and the question: what stop.css draws, with room around the ×. */
const BUTTON = { width: 36, height: 36 };
const QUESTION = { width: 272, height: 46 };

/** @param {{onStop: () => void}} deps  onStop: answered Yes */
export function createStopButton({ onStop }) {
  let win = null;
  let asking = false;
  /** Where the pill ends on the screen (pill-math.js), once it has said. */
  let end = null;

  function place() {
    const from = end ? { x: Math.round(end.x), y: Math.round(end.y) } : screen.getCursorScreenPoint();
    const area = screen.getDisplayNearestPoint(from).workArea;
    return besidePill(end || pillEnd(area), asking ? QUESTION : BUTTON, area);
  }

  const up = () => win && !win.isDestroyed();

  function ask(on) {
    asking = on;
    win.setBounds(place());
    postTo(win.webContents, { type: 'jester/stop-asking', asking });
  }

  function hide() {
    if (up()) win.destroy();
    win = null;
    asking = false;
  }

  return {
    show() {
      if (up()) return;
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
      win.setAlwaysOnTop(true, 'pop-up-menu');
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
      const shown = win;
      shown.webContents.once('did-finish-load', () => {
        if (!shown.isDestroyed()) shown.showInactive();
      });
      shown.loadURL(PAGE);
    },

    hide,

    /** The pill moved or changed width. Null: it isn't known where it is. */
    anchor(point) {
      end = point;
      if (up()) win.setBounds(place());
    },

    /** A click on the page: 'ask' (the ×), 'no' or 'yes'. One that arrives after the window went is too late. */
    clicked(op) {
      if (!up()) return;
      if (op === 'ask') ask(true);
      else if (op === 'no') ask(false);
      else if (op === 'yes') {
        hide();
        onStop();
      }
    }
  };
}
