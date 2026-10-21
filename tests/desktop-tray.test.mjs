import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSettings } from '../jester-extension/src/common/constants.js';
import { trayModel } from '../desktop/src/main/tray-menu.js';

const on = mergeSettings({ enabled: true, pointerEnabled: true, voiceEnabled: true });
const byId = (model) => Object.fromEntries(model.items.filter((item) => item.id).map((item) => [item.id, item]));

test('the menu says what the engine is doing and offers the switches', () => {
  const model = trayModel({ engine: { state: 'running' }, settings: on });
  const items = byId(model);
  assert.equal(items.status.label, 'Watching for gestures');
  assert.equal(items.status.enabled, false);
  assert.equal(items.enabled.checked, true);
  assert.equal(items.pointer.checked, true);
  assert.equal(items.pointer.enabled, true);
  assert.equal(model.tooltip, 'Jester — Watching for gestures');
  assert.deepEqual(model.items.at(-1), { id: 'quit', label: 'Quit Jester' });
  assert.equal(items.permissions, undefined);
});

test('switched off, it says so and the switches that depend on it are greyed', () => {
  const model = trayModel({ engine: { state: 'off' }, settings: { ...on, enabled: false } });
  const items = byId(model);
  assert.equal(items.status.label, 'Jester is off');
  assert.equal(items.enabled.checked, false);
  assert.equal(items.pointer.enabled, false);
  assert.equal(model.tooltip, 'Jester — off');
});

test('missing permissions get their own item and show in the tooltip', () => {
  const model = trayModel({ engine: { state: 'no-permission' }, settings: on, missing: [{ id: 'camera', label: 'Camera' }, { id: 'accessibility', label: 'Accessibility' }] });
  assert.equal(byId(model).permissions.label, 'Allow Camera and Accessibility…');
  assert.equal(byId(model).status.label, 'Camera access needed');
  assert.equal(model.tooltip, 'Jester — needs Camera and Accessibility');
});

test('voice stays a promise until the app can hear', () => {
  assert.deepEqual(byId(trayModel({ engine: { state: 'running' }, settings: on })).voice, { id: 'voice', label: 'Voice commands — coming soon', enabled: false });
  const ready = byId(trayModel({ engine: { state: 'running' }, settings: on, voiceReady: true })).voice;
  assert.equal(ready.type, 'checkbox');
  assert.equal(ready.checked, true);
});
