import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { browserish, createChromeLink } from '../desktop/src/main/chrome-link.js';
import { EXTENSION_IDS, installLinkHost, linkOrigins } from '../desktop/src/main/link-host.js';
import { createDesktopLink, desktopBindings, LINK_STATE } from '../jester-extension/src/background/desktop-link.js';

const pause = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** The app's half, with what it sends recorded and the extension's replies scripted. */
function appSide(overrides = {}) {
  const sent = [];
  const changes = [];
  const pills = [];
  const link = createChromeLink({
    send: (message) => (sent.push(message), true),
    version: '0.1.0',
    onChange: () => changes.push(link.linked),
    onPill: (voice) => pills.push(voice),
    onAsk: async (label) => label === 'Send the email',
    ...overrides
  });
  return { link, sent, changes, pills };
}

const hello = { type: 'hello', version: '0.2.0', settings: { bindings: { Open_Palm: { action: 'PLAY_PAUSE' } }, windowedBindingsEnabled: true, voiceEnabled: true } };

test('linked once the extension says hello, which the app answers; its gestures are the extension’s with its browser in front', () => {
  const { link, sent, changes } = appSide();
  link.connected('chrome-extension://jbfmeaijggbkkakdiinamgjjmcfblpab/', { browser: 4242 });
  assert.equal(link.linked, false);
  link.message(hello);
  assert.equal(link.linked, true);
  assert.equal(link.version, '0.2.0');
  assert.deepEqual(sent, [{ type: 'welcome', version: '0.1.0' }]);
  assert.deepEqual(link.bindings(), { bindings: { Open_Palm: { action: 'PLAY_PAUSE' } }, windowedBindingsEnabled: true });
  assert.equal(link.inFront(4242), true);
  assert.equal(link.inFront(17), false, 'another app');
  link.message({ type: 'settings', settings: { bindings: {} } });
  assert.deepEqual(link.bindings(), { bindings: {} });
  link.disconnected();
  assert.equal(link.linked, false);
  assert.equal(link.inFront(4242), false);
  assert.equal(link.bindings(), null);
  assert.deepEqual(changes, [true, true, false]);
});

test('a command is the browser’s by its words, with the browser in front, or by a name the extension knows', async () => {
  assert.equal(browserish('open my Canvas bookmark'), true);
  assert.equal(browserish('close the other tabs'), true);
  assert.equal(browserish('go to canvas.instructure.com'), true);
  assert.equal(browserish('open my canvas'), false);
  assert.equal(browserish('write a grocery list in Notes'), false);
  const { link, sent } = appSide();
  assert.equal(await link.claims('close the other tabs'), false, 'not linked: nothing is the browser’s');
  link.connected('o', { browser: 1 });
  link.message(hello);
  assert.equal(await link.claims('close the other tabs'), true);
  assert.equal(await link.claims('make it louder', { browserInFront: true }), true);
  const asking = link.claims('open my canvas');
  const request = sent.at(-1);
  assert.deepEqual({ type: request.type, op: request.op, text: request.text }, { type: 'request', op: 'knows', text: 'open my canvas' });
  link.message({ type: 'reply', id: request.id, result: true });
  assert.equal(await asking, true);
  // No answer in time is a no: the app's own assistant takes it.
  const slow = link.claims('open my notes');
  assert.equal(await slow, false);
});

test('a task the extension carries out: its steps and question on the app’s pill, its outcome back', async () => {
  const { link, sent, pills } = appSide();
  link.connected('o', { browser: 1 });
  link.message(hello);
  const done = link.task('open my canvas and tell me what’s due');
  const task = sent.at(-1);
  assert.equal(task.type, 'task');
  link.message({ type: 'pill', voice: { phase: 'thinking', step: 'Opening Canvas' } });
  assert.deepEqual(pills, [{ phase: 'thinking', step: 'Opening Canvas' }]);
  link.message({ type: 'ask', id: 'q1', label: 'Send the email' });
  await pause();
  assert.deepEqual(sent.at(-1), { type: 'answer', id: 'q1', approved: true });
  link.message({ type: 'done', id: 'someone else’s', ok: true, say: 'no' });
  link.message({ type: 'done', id: task.id, ok: true, say: 'Two assignments are due Friday.' });
  assert.deepEqual(await done, { ok: true, text: 'Two assignments are due Friday.' });
  assert.equal(link.running, false);
});

test('a task stopped from the app is cancelled in Chrome, and one cut off by the link closing says so', async () => {
  const { link, sent } = appSide();
  link.connected('o', { browser: 1 });
  link.message(hello);
  const controller = new AbortController();
  const stopped = link.task('play something', { signal: controller.signal });
  controller.abort();
  assert.equal(await stopped, null);
  assert.deepEqual(sent.at(-1), { type: 'cancel' });
  const cut = link.task('open my bookmarks');
  const aimed = link.aim({ x: 10.4, y: 20.6, radius: 40 });
  assert.deepEqual(sent.at(-1).x, 10);
  link.disconnected();
  assert.deepEqual(await cut, { ok: false, text: 'The link to Chrome closed before that was done.' });
  assert.equal(await aimed, null);
  assert.deepEqual(await link.task('anything'), { ok: false, text: 'Chrome isn’t linked.' });
});

test('a gesture’s action and an aim are answered by the extension', async () => {
  const { link, sent } = appSide();
  link.connected('o', { browser: 1 });
  link.message(hello);
  const acted = link.act('SEEK_FORWARD', { source: 'swipe', gesture: 'right' });
  const request = sent.at(-1);
  assert.deepEqual({ op: request.op, action: request.action, source: request.source, gesture: request.gesture }, { op: 'act', action: 'SEEK_FORWARD', source: 'swipe', gesture: 'right' });
  link.message({ type: 'reply', id: request.id, result: { ok: true, detail: 'Forward 10 s' } });
  assert.deepEqual(await acted, { ok: true, detail: 'Forward 10 s' });
  const aimed = link.aim({ x: 300, y: 200, radius: 60 });
  link.message({ type: 'reply', id: sent.at(-1).id, result: { x: 280, y: 190, w: 80, h: 24 } });
  assert.deepEqual(await aimed, { x: 280, y: 190, w: 80, h: 24 });
});

test('the relay is copied out of the guarded folders, and a manifest goes only to browsers that are there', () => {
  const home = fs.mkdtempSync(path.join(tmpdir(), 'jh-'));
  const support = path.join(home, 'Library/Application Support');
  fs.mkdirSync(path.join(support, 'Google/Chrome'), { recursive: true });
  fs.mkdirSync(path.join(support, 'BraveSoftware/Brave-Browser'), { recursive: true });
  const source = path.join(home, 'jester-driver');
  fs.writeFileSync(source, 'binary');
  const first = installLinkHost({ relaySource: source, home, platform: 'darwin' });
  assert.equal(first.relay, path.join(support, 'Jester/jester-link-relay'));
  assert.deepEqual(first.browsers, ['Google Chrome', 'Brave']);
  assert.equal(first.changed, true);
  assert.equal(fs.statSync(first.relay).mode & 0o777, 0o755);
  const manifest = JSON.parse(fs.readFileSync(path.join(support, 'Google/Chrome/NativeMessagingHosts/com.jester.desktop.json'), 'utf8'));
  assert.equal(manifest.path, first.relay);
  assert.deepEqual(manifest.allowed_origins, EXTENSION_IDS.map((id) => `chrome-extension://${id}/`));
  assert.equal(fs.existsSync(path.join(support, 'Microsoft Edge')), false, 'no folder made for a browser that isn’t there');
  assert.equal(installLinkHost({ relaySource: source, home, platform: 'darwin' }).changed, false, 'nothing rewritten');
  fs.writeFileSync(source, 'newer binary');
  assert.equal(installLinkHost({ relaySource: source, home, platform: 'darwin' }).changed, true);
  assert.match(installLinkHost({ relaySource: source, home, platform: 'win32' }).why, /macOS/);
  assert.deepEqual(linkOrigins('abcdefghijklmnopabcdefghijklmnop, not-an-id').at(-1), 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/');
  fs.rmSync(home, { recursive: true, force: true });
});

/** The extension's half, against a fake Chrome whose native port is scripted. */
function extensionSide({ granted = true } = {}) {
  const ports = [];
  const alarms = new Map();
  const listeners = { alarm: [], added: [], removed: [] };
  let lastError = null;
  const api = {
    runtime: {
      get lastError() {
        return lastError;
      },
      connectNative: (host) => {
        const port = { host, posted: [], message: [], disconnect: [], postMessage: (message) => port.posted.push(message), onMessage: { addListener: (fn) => port.message.push(fn) }, onDisconnect: { addListener: (fn) => port.disconnect.push(fn) } };
        port.receive = (message) => port.message.forEach((fn) => fn(message));
        port.close = (error = null) => {
          lastError = error && { message: error };
          port.disconnect.forEach((fn) => fn());
          lastError = null;
        };
        port.disconnect = [];
        ports.push(port);
        return port;
      }
    },
    permissions: {
      contains: async () => granted,
      onAdded: { addListener: (fn) => listeners.added.push(fn) },
      onRemoved: { addListener: (fn) => listeners.removed.push(fn) }
    },
    alarms: { create: (name, info) => alarms.set(name, info), clear: (name) => alarms.delete(name), onAlarm: { addListener: (fn) => listeners.alarm.push(fn) } }
  };
  const tasks = [];
  const states = [];
  const link = createDesktopLink({
    api: () => api,
    version: '0.2.0',
    settings: async () => ({ enabled: true, bindings: { Victory: { action: 'SLEEP' } }, seekSeconds: 10 }),
    task: async (id, text) => (tasks.push(text), { ok: true, say: `Did ${text}` }),
    cancel: () => tasks.push('cancelled'),
    request: async (op, args) => (op === 'knows' ? args.text.includes('canvas') : null),
    onChange: (state) => states.push(state)
  });
  return { link, ports, alarms, listeners, tasks, states, grant: (on) => (granted = on) };
}

test('the extension links once the app welcomes it, does what the app hands it, and answers its questions', async () => {
  const side = extensionSide();
  side.link.start();
  await pause();
  const [port] = side.ports;
  assert.equal(port.host, 'com.jester.desktop');
  assert.deepEqual(port.posted[0], { type: 'hello', version: '0.2.0', settings: { bindings: { Victory: { action: 'SLEEP' } } } });
  port.receive({ type: 'welcome', version: '0.1.0' });
  assert.equal(side.link.linked, true);
  assert.equal(side.alarms.size, 0, 'no retrying while linked');
  await side.link.ready();
  port.receive({ type: 'task', id: '3', text: 'open my canvas' });
  await pause();
  assert.deepEqual(port.posted.at(-1), { type: 'done', id: '3', ok: true, say: 'Did open my canvas' });
  port.receive({ type: 'request', id: '4', op: 'knows', text: 'open my canvas' });
  await pause();
  assert.deepEqual(port.posted.at(-1), { type: 'reply', id: '4', result: true });
  assert.equal(side.link.pill({ phase: 'thinking', step: 'Opening' }), true);
  const asked = side.link.ask('Close 3 tabs');
  const question = port.posted.at(-1);
  assert.equal(question.type, 'ask');
  port.receive({ type: 'answer', id: question.id, approved: true });
  assert.equal(await asked, true);
  port.receive({ type: 'cancel' });
  assert.deepEqual(side.tasks, ['open my canvas', 'cancelled']);
  assert.deepEqual(desktopBindings({ bindings: 1, seekSeconds: 10, windowedBindingsEnabled: false }), { bindings: 1, windowedBindingsEnabled: false });
});

test('with the app closed it waits, trying every half minute; with it not installed it says so; unlinked, it stops', async () => {
  const side = extensionSide();
  side.link.start();
  await pause();
  side.ports[0].receive({ type: 'jester/link-error', detail: 'Jester Desktop isn’t running.' });
  side.ports[0].close('Native host has exited.');
  assert.equal(side.link.state, LINK_STATE.WAITING);
  assert.deepEqual(side.alarms.get('jester-desktop-link'), { periodInMinutes: 0.5 });
  assert.equal(side.link.pill({ phase: 'thinking' }), false, 'no pill but its own while the app is away');
  assert.equal(await side.link.ask('Anything'), false);
  side.listeners.alarm.forEach((fn) => fn({ name: 'jester-desktop-link' }));
  await pause();
  assert.equal(side.ports.length, 2, 'tried again');
  side.ports[1].close('Specified native messaging host not found.');
  assert.equal(side.link.state, LINK_STATE.MISSING);
  side.grant(false);
  side.listeners.removed.forEach((fn) => fn({ permissions: ['nativeMessaging'] }));
  assert.equal(side.link.state, LINK_STATE.OFF);
  assert.equal(side.alarms.size, 0);
  const off = extensionSide({ granted: false });
  await off.link.start();
  assert.equal(off.ports.length, 0, 'never connects without the user’s say-so');
  assert.equal(off.link.state, LINK_STATE.OFF);
});
