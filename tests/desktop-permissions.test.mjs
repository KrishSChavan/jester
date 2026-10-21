import test from 'node:test';
import assert from 'node:assert/strict';
import { missingNeeded, permissionItems } from '../desktop/src/main/permission-list.js';

const pick = (items) => items.map(({ id, status, granted, action }) => ({ id, status, granted, action }));

test('a Mac asks for camera, Accessibility, microphone and screen recording, in that order', () => {
  const items = permissionItems('darwin', { camera: 'not-determined', accessibility: 'not-determined', microphone: 'denied', screen: 'granted' });
  assert.deepEqual(pick(items), [
    { id: 'camera', status: 'not-determined', granted: false, action: 'request' },
    { id: 'accessibility', status: 'not-determined', granted: false, action: 'request' },
    { id: 'microphone', status: 'denied', granted: false, action: 'open-settings' },
    { id: 'screen', status: 'granted', granted: true, action: null }
  ]);
  assert.deepEqual(items.map((item) => item.tier), ['needed', 'needed', 'recommended', 'later']);
  assert.ok(items.every((item) => item.label && item.why));
});

test('once macOS has been answered "no", only System Settings can change it', () => {
  for (const status of ['denied', 'restricted', 'unknown']) {
    assert.equal(permissionItems('darwin', { camera: status })[0].action, 'open-settings', status);
  }
  // Screen recording has no prompt of its own to show.
  assert.equal(permissionItems('darwin', { screen: 'not-determined' }).find((item) => item.id === 'screen').action, 'open-settings');
});

test('Windows has only the camera and microphone switches', () => {
  const items = permissionItems('win32', { camera: 'granted', microphone: 'denied' });
  assert.deepEqual(pick(items), [
    { id: 'camera', status: 'granted', granted: true, action: null },
    { id: 'microphone', status: 'denied', granted: false, action: 'open-settings' }
  ]);
  assert.deepEqual(permissionItems('linux', {}), []);
});

test('Settings opens by itself only while a needed permission is missing', () => {
  const missing = (statuses) => missingNeeded(permissionItems('darwin', statuses)).map((item) => item.id);
  assert.deepEqual(missing({ camera: 'granted', accessibility: 'granted', microphone: 'denied', screen: 'denied' }), []);
  assert.deepEqual(missing({ camera: 'granted', accessibility: 'not-determined' }), ['accessibility']);
  assert.deepEqual(missing({}), ['camera', 'accessibility']);
});
