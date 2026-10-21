/**
 * The main process's half of the `chrome` shim (src/preload/chrome-shim.cjs).
 *
 * In the extension, pages and the service worker talk through
 * `chrome.runtime` messages. Here the main process is the worker: its
 * handlers answer pages, and `post()` reaches every page the way the worker's
 * broadcasts do. A page's message also reaches every *other* page, as in
 * Chrome — the calibration screen hears the engine's feed that way.
 */

import { app, ipcMain, webContents } from 'electron';
import path from 'node:path';
import { createStorageArea } from './storage.js';

export const RUNTIME_ID = 'jester-desktop';
export const EXT_ROOT = 'jester://ext/';
const OWN_PAGES = /^jester:\/\/(ext|app)\//;
/** What `sender.url` says for the main process, so `fromJester()` accepts it. */
const WORKER_URL = `${EXT_ROOT}src/background/service-worker.js`;

const handlers = new Set();
const storageListeners = new Set();
let areas = null;

/**
 * Listen as the worker. A handler returns the reply, or a promise of one;
 * `undefined` means the message wasn't for it.
 */
export function onMessage(handler) {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

export function onStorageChanged(listener) {
  storageListeners.add(listener);
  return () => storageListeners.delete(listener);
}

function pages(except) {
  return webContents.getAllWebContents().filter((contents) => contents !== except && !contents.isDestroyed() && OWN_PAGES.test(contents.getURL()));
}

/** A message from the worker to every page. */
export function post(message) {
  const sender = { id: RUNTIME_ID, url: WORKER_URL };
  for (const contents of pages()) contents.send('jester:message', message, sender);
}

/** Send to one page only, as `chrome.tabs.sendMessage` would. */
export function postTo(contents, message) {
  if (!contents.isDestroyed()) contents.send('jester:message', message, { id: RUNTIME_ID, url: WORKER_URL });
}

export const storage = {
  get local() {
    return areas.local;
  },
  get session() {
    return areas.session;
  }
};

function storageChanged(area, changes) {
  for (const contents of pages()) contents.send('jester:storage-changed', changes, area);
  for (const listener of storageListeners) listener(changes, area);
}

/**
 * The same slice of `chrome.*` for extension modules imported into the main
 * process — gaze-store.js, credentials.js and constants.js's `post()` reach
 * for the global `chrome`, and this lets them run unchanged.
 */
function installMainChrome() {
  globalThis.chrome = {
    runtime: {
      id: RUNTIME_ID,
      getURL: (file = '') => EXT_ROOT + String(file).replace(/^\/+/, ''),
      sendMessage: async (message) => post(message)
    },
    storage: {
      local: areas.local,
      session: areas.session,
      onChanged: {
        addListener: (fn) => void storageListeners.add(fn),
        removeListener: (fn) => void storageListeners.delete(fn)
      }
    }
  };
}

export function installBridge({ dataDir = app.getPath('userData') } = {}) {
  areas = {
    local: createStorageArea({ file: path.join(dataDir, 'storage-local.json'), onChanged: (changes) => storageChanged('local', changes) }),
    session: createStorageArea({ onChanged: (changes) => storageChanged('session', changes) })
  };
  installMainChrome();

  ipcMain.handle('jester:message', async (event, message) => {
    const url = event.senderFrame?.url || event.sender.getURL();
    if (!OWN_PAGES.test(url)) return undefined;
    const sender = { id: RUNTIME_ID, url, contents: event.sender };
    for (const contents of pages(event.sender)) contents.send('jester:message', message, { id: RUNTIME_ID, url });
    for (const handler of handlers) {
      const reply = await handler(message, sender);
      if (reply !== undefined) return reply;
    }
    return undefined;
  });

  ipcMain.handle('jester:storage', async (event, area, op, arg) => {
    const url = event.senderFrame?.url || event.sender.getURL();
    if (!OWN_PAGES.test(url) || !Object.hasOwn(areas, area) || !['get', 'set', 'remove'].includes(op)) return undefined;
    return areas[area][op](arg);
  });
}
