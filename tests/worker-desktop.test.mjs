import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// The worker linked to Jester Desktop, against a small Chrome that is behind the
// app's own window (as when the user types to Jester): commands arrive on the
// native port, with what the app's conversation took them to mean, and no model
// is connected.
function event() {
  const listeners = [];
  return { listeners, addListener(fn) { listeners.push(fn); }, removeListener(fn) { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
    fire(...args) { for (const fn of [...listeners]) fn(...args); } };
}
const local = { settings: { enabled: true, voiceEnabled: true, agentPermissionBoundary: 'entertainment', agentRealInput: false },
  modelConnectionConfigured: true };
const session = {};
function area(data) {
  return { async get(key) { return typeof key === 'string' ? { [key]: structuredClone(data[key]) } : structuredClone(data); },
    async set(values) { Object.assign(data, structuredClone(values)); }, async remove(key) { delete data[key]; },
    async setAccessLevel() {} };
}
const BOOKMARKS = [
  { id: 'b1', title: 'PSU Canvas', url: 'https://psu.instructure.com/' },
  { id: 'b2', title: 'Canvas Student Guide', url: 'https://community.canvaslms.com/t5/Student-Guide/ct-p/student' }
];
let tabs = [];
let windows = [];
let nextId = 100;
const created = [];
const createdWindows = [];
const posted = [];
const runtimeMessages = event();
const onActivated = event();
const onUpdated = event();
const portMessages = event();
function activate(id) {
  const tab = tabs.find((entry) => entry.id === id);
  for (const other of tabs) if (other.windowId === tab.windowId) other.active = other.id === id;
  onActivated.fire({ tabId: id, windowId: tab.windowId });
}
const readable = (tab) => /^https?:/.test(tab?.url || '');
const loadLater = (id) => setTimeout(() => onUpdated.fire(id, { status: 'complete' }), 1);
// What Chrome's bookmark search does: every word, in the title or the address.
const search = async (query) => {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  return BOOKMARKS.filter((node) => words.every((word) => `${node.title} ${node.url}`.toLowerCase().includes(word))).map((node) => ({ ...node }));
};
globalThis.chrome = {
  runtime: { id: 'extension-test', getURL: (path = '') => `chrome-extension://extension-test/${path}`,
    getManifest: () => ({ version: '0.2.1' }),
    getContexts: async () => [{ contextType: 'OFFSCREEN_DOCUMENT' }],
    sendMessage: async () => {},
    connectNative: () => ({ postMessage: (message) => posted.push(structuredClone(message)), onMessage: portMessages,
      onDisconnect: event(), disconnect() {} }),
    onMessage: runtimeMessages, onStartup: event(), onInstalled: event() },
  storage: { local: area(local), session: area(session), onChanged: event() },
  offscreen: { createDocument: async () => {}, closeDocument: async () => {} },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  permissions: { contains: async () => true, onAdded: event(), onRemoved: event() },
  alarms: { create() {}, clear() {}, onAlarm: event() },
  notifications: { create: async (id) => id, clear: async () => {}, onClicked: event(), onClosed: event() },
  commands: { onCommand: event() },
  bookmarks: { search, getChildren: async () => [] },
  tabs: {
    onUpdated, onActivated, onCreated: event(), onRemoved: event(),
    query: async (info = {}) => tabs.filter((tab) => (info.active === undefined || tab.active === info.active) &&
      (info.windowId === undefined || tab.windowId === info.windowId) && (info.audible === undefined || !!tab.audible === info.audible) &&
      (info.url === undefined)).map((tab) => structuredClone(tab)),
    get: async (id) => { const tab = tabs.find((entry) => entry.id === id); if (!tab) throw new Error('No tab'); return structuredClone(tab); },
    update: async (id, patch) => {
      const tab = tabs.find((entry) => entry.id === id);
      if (patch.active) activate(id);
      if (patch.url) { tab.url = patch.url; tab.title = new URL(patch.url).hostname; loadLater(id); }
      return structuredClone(tab);
    },
    create: async (props) => {
      const tab = { id: nextId++, windowId: props.windowId ?? windows[0]?.id ?? 1, index: tabs.length, active: true,
        url: props.url || 'chrome://newtab/', title: props.url ? new URL(props.url).hostname : 'New Tab' };
      tabs.push(tab); created.push(structuredClone(props)); activate(tab.id); loadLater(tab.id);
      return structuredClone(tab);
    },
    sendMessage: async (tabId, message) => {
      const tab = tabs.find((entry) => entry.id === tabId);
      if (!readable(tab)) throw new Error('Receiving end does not exist');
      if (message.type === 'jester/agent-observe') return { ok: true, pageId: `doc${tabId}`, revision: 1, url: tab.url, title: tab.title,
        elements: [], text: `Page: ${tab.title}` };
      if (message.type === 'jester/agent-classify') return { ok: true, category: 'browse', label: 'Control', pageId: `doc${tabId}` };
      if (message.type === 'jester/probe') return { hasVideo: false };
      return { ok: true };
    },
    setZoomSettings: async () => {}, setZoom: async () => {}
  },
  // Jester Desktop's window has the focus: Chrome's never says it does.
  windows: {
    getLastFocused: async () => {
      if (!windows.length) throw new Error('No last-focused window');
      return { ...windows[0], focused: false, state: 'normal', type: 'normal' };
    },
    get: async (id) => ({ id, state: 'normal' }),
    update: async () => ({}),
    create: async (props) => {
      const window = { id: 2 };
      windows.push(window);
      createdWindows.push(props);
      const tab = { id: nextId++, windowId: window.id, index: 0, active: true, url: 'chrome://newtab/', title: 'New Tab' };
      tabs.push(tab);
      return { ...window, tabs: [structuredClone(tab)] };
    },
    onFocusChanged: event(), onBoundsChanged: event(), onRemoved: event()
  },
  scripting: { executeScript: async ({ target, files }) => {
    const tab = tabs.find((entry) => entry.id === target.tabId);
    if (!readable(tab)) throw new Error('Cannot access a chrome:// URL');
    return files ? [] : [{ frameId: 0, result: { hasVideo: false } }];
  } },
  sessions: { restore: async () => { throw new Error('Nothing to restore'); } },
  search: { query: async () => {} }
};
// No model is connected: anything that would need one fails the test.
globalThis.fetch = async (url) => {
  if (String(url).startsWith('chrome-extension:')) return new Response('', { status: 404 });
  throw new Error('No model may be asked');
};

await import('../jester-extension/src/background/service-worker.js');
const tick = () => new Promise((done) => setTimeout(done, 2));
async function until(predicate, label = 'the expected state') {
  for (let attempt = 0; attempt < 1000; attempt++) { if (predicate()) return; await tick(); }
  assert.fail(`Worker did not reach ${label}`);
}
// The app welcomes the extension: linked.
await until(() => posted.some((message) => message.type === 'hello'), 'its hello');
portMessages.fire({ type: 'welcome', version: 'test' });

let nextTask = 0;
/** A command from Jester Desktop, and how the extension says it went. */
async function fromDesktop(text, meant = '') {
  const id = String(++nextTask);
  portMessages.fire({ type: 'task', id, text, ...(meant ? { meant } : {}) });
  await until(() => posted.some((message) => message.type === 'done' && message.id === id), `an answer to “${text}”`);
  return posted.find((message) => message.type === 'done' && message.id === id);
}

beforeEach(() => {
  windows = [{ id: 1 }];
  tabs = [
    { id: 7, windowId: 1, index: 0, active: true, url: 'chrome-extension://extension-test/src/options/options.html', title: 'Jester — settings' },
    { id: 8, windowId: 1, index: 1, active: false, url: 'https://mail.google.com/mail/u/0/#inbox', title: 'Inbox' }
  ];
  activate(7);
  created.length = 0;
  createdWindows.length = 0;
});

test('behind Jester Desktop’s window, “open my PSU Canvas bookmark in chrome” opens the bookmark, with no model', async (t) => {
  t.mock.method(console, 'info', () => {});
  const done = await fromDesktop('Hey Jester open my PSU Canvas bookmark in chrome');
  assert.equal(done.ok, true, done.say);
  assert.deepEqual(created.map((props) => props.url), ['https://psu.instructure.com/']);
});

test('the user’s words name nothing known: what the conversation took them to mean is done', async (t) => {
  t.mock.method(console, 'info', () => {});
  const tried = await fromDesktop('Try now', 'open Chrome and open PSU Canvas bookmark');
  assert.equal(tried.ok, true, tried.say);
  assert.deepEqual(created.map((props) => props.url), ['https://psu.instructure.com/']);

  created.length = 0;
  tabs = tabs.filter((tab) => !/instructure/.test(tab.url));
  activate(7);
  const misnamed = await fromDesktop('Open my google chrome extension PSU Canvas', 'open Chrome and open the PSU Canvas bookmark');
  assert.equal(misnamed.ok, true, misnamed.say);
  assert.deepEqual(created.map((props) => props.url), ['https://psu.instructure.com/']);
});

test('“keep going” with nothing paused does what the conversation took it to mean; without one, it says there’s nothing', async (t) => {
  t.mock.method(console, 'info', () => {});
  const nothing = await fromDesktop('keep going');
  assert.equal(nothing.ok, false);
  assert.match(nothing.say, /no task to resume/);
  const going = await fromDesktop('keep going', 'open Chrome and open the PSU Canvas extension');
  assert.equal(going.ok, true, going.say);
  assert.deepEqual(created.map((props) => props.url), ['https://psu.instructure.com/']);
});

test('Chrome running with no window open: one opens, and the bookmark opens in it', async (t) => {
  t.mock.method(console, 'info', () => {});
  windows = [];
  tabs = [];
  const done = await fromDesktop('open my PSU Canvas bookmark');
  assert.equal(createdWindows.length, 1);
  assert.equal(done.ok, true, done.say);
  assert.equal(tabs.some((tab) => tab.url === 'https://psu.instructure.com/'), true);
});
