/**
 * The slice of `chrome.*` the extension's pages use, for the desktop app.
 *
 * The engine (offscreen.js) and the calibration screen run here unchanged. In
 * Chrome they talk to the service worker with `chrome.runtime` messages; here
 * the main process plays the worker, over IPC. Messages keep Chrome's shape:
 * a page's message reaches the main process and every other page, and a
 * listener is called as `(message, sender, sendResponse)`, with `sender.url`
 * set by the main process, never by the page — `senders.js` relies on that.
 */

const { contextBridge, ipcRenderer } = require('electron');

const RUNTIME_ID = 'jester-desktop';
const ROOT = 'jester://ext/';

const messageListeners = new Set();
const storageListeners = new Set();

ipcRenderer.on('jester:message', (_event, message, sender) => {
  for (const listener of messageListeners) {
    try {
      listener(message, sender, () => undefined);
    } catch (err) {
      console.error(err);
    }
  }
});

ipcRenderer.on('jester:storage-changed', (_event, changes, area) => {
  for (const listener of storageListeners) {
    try {
      listener(changes, area);
    } catch (err) {
      console.error(err);
    }
  }
});

const event = (listeners) => ({
  addListener: (fn) => void listeners.add(fn),
  removeListener: (fn) => void listeners.delete(fn),
  hasListener: (fn) => listeners.has(fn)
});

const area = (name) => ({
  get: (keys) => ipcRenderer.invoke('jester:storage', name, 'get', keys ?? null),
  set: (items) => ipcRenderer.invoke('jester:storage', name, 'set', items),
  remove: (keys) => ipcRenderer.invoke('jester:storage', name, 'remove', keys)
});

const api = {
  runtime: {
    id: RUNTIME_ID,
    getURL: (path = '') => ROOT + String(path).replace(/^\/+/, ''),
    sendMessage: (message) => ipcRenderer.invoke('jester:message', message),
    onMessage: event(messageListeners)
  },
  storage: {
    local: area('local'),
    session: area('session'),
    onChanged: event(storageListeners)
  }
};

// Electron pages already have a `window.chrome`, so exposeInMainWorld('chrome')
// refuses. Hang the two namespaces on the existing object instead, from inside
// the page's own world, before any of its scripts run.
contextBridge.executeInMainWorld({
  func: (shim) => {
    if (typeof globalThis.chrome !== 'object' || globalThis.chrome === null) {
      Object.defineProperty(globalThis, 'chrome', { value: {}, configurable: true, writable: true });
    }
    for (const name of ['runtime', 'storage']) {
      Object.defineProperty(globalThis.chrome, name, { value: shim[name], configurable: true, writable: true });
    }
  },
  args: [api]
});
