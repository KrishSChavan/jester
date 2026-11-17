import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';

const windows = [];
const displays = [{ id: 7, bounds: { x: 0, y: 0, width: 1000, height: 800 } }];
class Window extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.sent = [];
    this.webContents = Object.assign(new EventEmitter(), {
      isDestroyed: () => false, getURL: () => this.url || '',
      send: (_channel, message) => this.sent.push(message)
    });
    windows.push(this);
  }
  setIgnoreMouseEvents() {}
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  setBounds() {}
  loadURL(url) { this.url = url; }
  isDestroyed() { return false; }
  showInactive() {}
  destroy() {}
}
const screen = Object.assign(new EventEmitter(), {
  getAllDisplays: () => displays,
  getCursorScreenPoint: () => ({ x: 20, y: 30 }),
  getDisplayNearestPoint: () => displays[0]
});
globalThis.jesterOverlayFixture = { Window, screen, windows };
const electron = `data:text/javascript,
export const BrowserWindow=globalThis.jesterOverlayFixture.Window,screen=globalThis.jesterOverlayFixture.screen;
export const app={},ipcMain={},webContents={getAllWebContents:()=>globalThis.jesterOverlayFixture.windows.map(w=>w.webContents)};`;
registerHooks({ resolve: (specifier, context, next) => specifier === 'electron' ? { url: electron, shortCircuit: true } : next(specifier, context) });
const { createOverlays } = await import('../desktop/src/main/overlay.js');

test('an overlay that loads after the first display-selection frame replays that cached selection', () => {
  const overlay = createOverlays();
  const win = overlay.windows()[0];
  overlay.track();
  win.sent.length = 0; // The renderer had not subscribed to that first frame.
  win.webContents.emit('did-finish-load');
  assert.ok(win.sent.some((message) => message.type === 'jester/overlay-active' && message.display === 7));
  overlay.destroy();
});
