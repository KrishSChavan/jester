/**
 * The window behind the always-on mic and Jester's audio (src/voice/voice.html).
 * Hidden, and only there while the continuous assistant is on. Audio goes through
 * Chromium rather than a player of the OS's, so it works the same on Windows.
 */

import { BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD = path.join(here, '../preload/voice.cjs');
const PAGE = 'jester://app/voice/voice.html';
/** Audio that never reports its end doesn't hold up what comes next. */
const PLAY_LIMIT_MS = 90000;
/** A page that crashed is loaded again after this long. */
const RELOAD_MS = 1000;

export function createVoicePage({ log = () => undefined } = {}) {
  let win = null;
  let plays = 0;
  /** The sound playing: its id, and what ends it. */
  let playing = null;

  const finish = () => {
    clearTimeout(playing?.limit);
    playing?.resolve();
    playing = null;
  };

  ipcMain.on('jester:voice-status', (event, report) => {
    if (event.sender !== win?.webContents) return;
    if (report?.mic) log('always-on mic:', report.mic);
    if (playing && report?.ended === playing.id) finish();
  });

  return {
    open() {
      if (win) return;
      win = new BrowserWindow({
        show: false,
        // Timers and audio run on in a window nobody can see.
        webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' }
      });
      const page = win;
      page.webContents.on('console-message', ({ level, message }) => level === 'error' && log('voice page error:', message));
      page.webContents.on('render-process-gone', (_event, details) => {
        log('voice page gone:', details.reason);
        finish();
        setTimeout(() => page === win && page.reload(), RELOAD_MS);
      });
      page.loadURL(PAGE);
    },
    /** Closing the window is what closes the mic. */
    close() {
      finish();
      win?.destroy();
      win = null;
    },
    /** @returns {Promise<void>} when the sound has ended, or been stopped */
    play(bytes, type) {
      if (!win) return Promise.reject(new Error('The voice page isn’t open'));
      finish();
      plays += 1;
      const id = plays;
      win.webContents.send('jester:voice-play', { id, bytes, type });
      return new Promise((resolve) => {
        playing = { id, resolve, limit: setTimeout(finish, PLAY_LIMIT_MS) };
      });
    },
    stop() {
      if (!playing) return;
      win?.webContents.send('jester:voice-play', { stop: true });
      finish();
    }
  };
}
