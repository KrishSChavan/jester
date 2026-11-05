import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { besidePill, pillEnd, PILL_GAP } from '../desktop/src/main/pill-math.js';

const AREA = { x: 0, y: 34, width: 1512, height: 900 };
const BUTTON = { width: 36, height: 36 };

test('the × sits just past the pill\'s end, level with it', () => {
  assert.deepEqual(besidePill({ x: 890, y: 880 }, BUTTON, AREA), { width: 36, height: 36, x: 890 + PILL_GAP, y: 862 });
  assert.deepEqual(besidePill({ x: 890, y: 880 }, { width: 272, height: 46 }, AREA), { width: 272, height: 46, x: 890 + PILL_GAP, y: 857 });
});

test('the question stays on a small screen, and on one to the left of the main display', () => {
  const small = { x: 0, y: 25, width: 1024, height: 700 };
  assert.equal(besidePill({ x: 900, y: 680 }, { width: 272, height: 46 }, small).x, 1024 - 272);
  const left = { x: -1440, y: 0, width: 1440, height: 870 };
  assert.equal(besidePill({ x: -600, y: 800 }, BUTTON, left).x, -600 + PILL_GAP);
  assert.equal(besidePill({ x: -2000, y: 800 }, BUTTON, left).x, -1440);
});

test('with no word from the pill, it goes where the pill would be', () => {
  assert.deepEqual(pillEnd(AREA), { x: 822, y: 887 });
  assert.deepEqual(pillEnd({ x: 1512, y: 0, width: 1000, height: 800 }), { x: 2078, y: 753 });
});

// The assistant reaches Electron through chrome-bridge.js; its pages are all these tests need.
const sent = [];
const overlay = { isDestroyed: () => false, getURL: () => 'jester://app/overlay/overlay.html', send: (_channel, message) => sent.push(message) };
const electron = `data:text/javascript,
  export const app = {}, BrowserWindow = {}, ipcMain = {};
  export const webContents = { getAllWebContents: () => globalThis.jesterPages };`;
globalThis.jesterPages = [overlay];
registerHooks({ resolve: (specifier, context, next) => (specifier === 'electron' ? { url: electron, shortCircuit: true } : next(specifier, context)) });
const { createAssistant } = await import('../desktop/src/main/assistant.js');

/** A learned task whose screen read waits to be let go. */
function rig() {
  sent.length = 0;
  const busy = [];
  const reads = [];
  const assistant = createAssistant({
    driver: { call: (cmd) => (cmd === 'snapshot' ? new Promise((resolve) => reads.push(resolve)) : Promise.resolve({})) },
    openApp: async () => ({ ok: true, text: '' }),
    activate: async () => undefined,
    openUrl: async () => undefined,
    dispatch: async () => ({ ok: true, detail: '' }),
    listen: () => undefined,
    prompt: { show: () => undefined, hide: () => undefined },
    onBusy: (on) => busy.push(on),
    platform: 'darwin'
  });
  const step = { action: { action: 'click' }, app: 'Notes', target: { role: 'button', label: 'Go' } };
  const start = () => assistant.replay({ steps: [step], key: 'go' }, 'go');
  const started = async () => {
    while (!reads.length) await new Promise((resolve) => setTimeout(resolve, 1));
  };
  const finish = () => reads.shift()({ ok: true, snapshot: 1, app: { name: 'Elsewhere', pid: 7 }, window: {}, elements: [] });
  return { assistant, busy, start, started, finish };
}

test('a task says when it begins and ends, for the × to come and go with it', async () => {
  const { assistant, busy, start, started, finish } = rig();
  assert.equal(assistant.running, false);
  const task = start();
  await started();
  assert.deepEqual(busy, [true]);
  assert.equal(assistant.running, true);
  finish();
  await task;
  assert.deepEqual(busy, [true, false]);
  assert.equal(assistant.running, false);
});

test('cancelling a task ends it, says so on the pill, and does nothing with none running', async () => {
  const { assistant, busy, start, started, finish } = rig();
  await assistant.cancel();
  assert.deepEqual(busy, []);
  assert.equal(sent.length, 0);
  const task = start();
  await started();
  const stopping = assistant.cancel();
  assert.equal(sent.at(-1).voice.step, 'Stopping…');
  finish();
  await stopping;
  assert.deepEqual(await task, { ok: false, step: 0, detail: 'cancelled', cancelled: true });
  assert.deepEqual(busy, [true, false]);
});

test('a new task replacing one leaves one task running', async () => {
  const { assistant, busy, start, started, finish } = rig();
  const first = start();
  await started();
  const second = start();
  finish();
  await first;
  await started();
  assert.deepEqual(busy, [true, false, true]);
  assert.equal(assistant.running, true);
  finish();
  await second;
  assert.equal(assistant.running, false);
});
