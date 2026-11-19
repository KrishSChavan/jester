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
  /** The sounds playing or queued after it: id → what ends each. */
  const playing = new Map();

  /** One sound over, or with no id every one of them. */
  const finish = (id) => {
    for (const [each, sound] of [...playing]) {
      if (id !== undefined && each !== id) continue;
      clearTimeout(sound.limit);
      playing.delete(each);
      sound.resolve();
    }
  };

  ipcMain.on('jester:voice-status', (event, report) => {
    if (event.sender !== win?.webContents) return;
    if (report?.mic) log('always-on mic:', report.mic);
    if (report?.ended !== undefined && playing.has(report.ended)) finish(report.ended);
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
    /**
     * `queued`: it starts the moment what's playing ends, with no gap, rather than in its place.
     * @returns {Promise<void>} when the sound has ended, or been stopped
     */
    play(bytes, type, { queued = false } = {}) {
      if (!win) return Promise.reject(new Error('The voice page isn’t open'));
      if (!queued) finish();
      plays += 1;
      const id = plays;
      const ended = new Promise((resolve) => {
        playing.set(id, { resolve, limit: setTimeout(() => finish(id), PLAY_LIMIT_MS) });
      });
      win.webContents.send('jester:voice-play', { id, bytes, type, queued });
      return ended;
    },
    stop() {
      if (!playing.size) return;
      win?.webContents.send('jester:voice-play', { stop: true });
      finish();
    }
  };
}
