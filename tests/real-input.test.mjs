import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRealInput, keyEvents } from '../jester-extension/src/background/real-input.js';

function fakeDebugger({ attachError = null } = {}) {
  const calls = [], detachListeners = [];
  return {
    calls, detachListeners,
    api: {
      attach: async (target, version) => { calls.push(['attach', target.tabId, version]); if (attachError) throw new Error(attachError); },
      detach: async (target) => { calls.push(['detach', target.tabId]); },
      sendCommand: async (target, method, params) => { calls.push([method, target.tabId, params]); },
      onDetach: { addListener: (fn) => detachListeners.push(fn) }
    }
  };
}

test('keys carry the codes and text a page expects from a real keyboard', () => {
  const [enterDown, enterUp] = keyEvents('Enter');
  assert.deepEqual([enterDown.type, enterDown.key, enterDown.windowsVirtualKeyCode, enterDown.text], ['keyDown', 'Enter', 13, '\r']);
  assert.equal(enterUp.type, 'keyUp');
  assert.equal(keyEvents('Escape')[0].type, 'rawKeyDown', 'A key without text sends no input');
  assert.deepEqual([keyEvents('Space')[0].code, keyEvents('Space')[0].text], ['Space', ' ']);
  assert.deepEqual([keyEvents('k')[0].code, keyEvents('k')[0].windowsVirtualKeyCode, keyEvents('k')[0].text], ['KeyK', 75, 'k']);
  assert.equal(keyEvents('7')[0].code, 'Digit7');
  assert.throws(() => keyEvents('F12'));
});

test('one attach per task: real moves, presses and text, then release takes the debugger away', async () => {
  const fake = fakeDebugger();
  const input = createRealInput({ api: () => fake.api });
  assert.equal(input.supported(), true);
  assert.equal(await input.attach(7), true);
  assert.equal(await input.attach(7), true);
  await input.move(7, 40, 50);
  await input.move(7, 40, 50);
  await input.press(7, 40, 50);
  await input.insertText(7, 'rick and morty');
  await input.key(7, 'Enter');
  await input.release(7);
  const mouse = fake.calls.filter(([method]) => method === 'Input.dispatchMouseEvent').map(([, , p]) => [p.type, p.x, p.y]);
  assert.deepEqual(mouse, [['mouseMoved', 40, 50], ['mouseMoved', 42, 52], ['mouseMoved', 40, 50],
    ['mousePressed', 40, 50], ['mouseReleased', 40, 50]], 'A repeat move nudges first so the page sees it');
  assert.deepEqual(fake.calls.filter(([method]) => method === 'attach' || method === 'detach').map(([m, tab]) => [m, tab]),
    [['attach', 7], ['detach', 7]]);
  assert.deepEqual(fake.calls.find(([method]) => method === 'Input.insertText')[2], { text: 'rick and morty' });
  assert.equal(input.attached(7), false);
});

test('calibration corrects debugger units from where the page saw the pointer, within sane bounds', async () => {
  const fake = fakeDebugger();
  const input = createRealInput({ api: () => fake.api });
  await input.attach(3);
  assert.equal(input.calibrate(3, { x: 100, y: 80 }, { x: 125, y: 100 }), true);
  await input.press(3, 100, 80);
  const pressed = fake.calls.find(([, , p]) => p?.type === 'mousePressed')[2];
  assert.deepEqual([pressed.x, pressed.y], [80, 64]);
  assert.equal(input.calibrate(3, { x: 100, y: 80 }, { x: 0, y: 0 }), false);
});

test('a refused attach, a dismissed debugging bar and a missing API all leave real input off', async () => {
  const refused = fakeDebugger({ attachError: 'Cannot attach to this target.' });
  const input = createRealInput({ api: () => refused.api });
  assert.equal(await input.attach(5), false);
  assert.equal(input.attached(5), false);

  const fake = fakeDebugger();
  const cancelled = [];
  const watched = createRealInput({ api: () => fake.api, onUserCancel: (tabId) => cancelled.push(tabId) });
  await watched.attach(9);
  for (const listener of fake.detachListeners) listener({ tabId: 9 }, 'canceled_by_user');
  assert.deepEqual(cancelled, [9]);
  assert.equal(watched.attached(9), false);

  const none = createRealInput({ api: () => undefined });
  assert.equal(none.supported(), false);
  assert.equal(await none.attach(1), false);
});

test('a new task waits for the previous task\'s detach before attaching to the same tab', async () => {
  const order = [];
  let finishDetach;
  const api = {
    attach: async (target) => { order.push(`attach ${target.tabId}`); },
    detach: (target) => new Promise((resolve) => { order.push(`detach ${target.tabId} started`); finishDetach = () => { order.push(`detach ${target.tabId} done`); resolve(); }; }),
    sendCommand: async () => {},
    onDetach: { addListener() {} }
  };
  const input = createRealInput({ api: () => api });
  await input.attach(4);
  const releasing = input.release(4);
  const attaching = input.attach(4);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['attach 4', 'detach 4 started']);
  finishDetach();
  await releasing;
  assert.equal(await attaching, true);
  assert.deepEqual(order, ['attach 4', 'detach 4 started', 'detach 4 done', 'attach 4']);
});
