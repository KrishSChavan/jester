import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStorageArea } from '../desktop/src/main/storage.js';

test('get takes a key, a list of keys, defaults, or nothing, as chrome.storage does', async () => {
  const area = createStorageArea();
  await area.set({ settings: { enabled: true }, gazeCalibration: { kind: 'landmark-ridge' } });
  assert.deepEqual(await area.get('settings'), { settings: { enabled: true } });
  assert.deepEqual(await area.get(['settings', 'missing']), { settings: { enabled: true } });
  assert.deepEqual(await area.get({ missing: 7, settings: null }), { missing: 7, settings: { enabled: true } });
  assert.deepEqual(Object.keys(await area.get(null)).sort(), ['gazeCalibration', 'settings']);
});

test('changes are reported with old and new values, and reads are copies', async () => {
  const changes = [];
  const area = createStorageArea({ onChanged: (change) => changes.push(change) });
  await area.set({ settings: { enabled: false } });
  await area.set({ settings: { enabled: true } });
  await area.remove('settings');
  await area.remove('settings');
  assert.deepEqual(changes, [
    { settings: { oldValue: undefined, newValue: { enabled: false } } },
    { settings: { oldValue: { enabled: false }, newValue: { enabled: true } } },
    { settings: { oldValue: { enabled: true } } }
  ]);
  await area.set({ list: [1, 2] });
  const { list } = await area.get('list');
  list.push(3);
  assert.deepEqual((await area.get('list')).list, [1, 2]);
});

test('the local area survives a restart, and a corrupt file starts empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jester-storage-'));
  const file = join(dir, 'storage-local.json');
  const first = createStorageArea({ file });
  await first.set({ settings: { enabled: true, targetFps: 15 } });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { settings: { enabled: true, targetFps: 15 } });
  assert.deepEqual(await createStorageArea({ file }).get('settings'), { settings: { enabled: true, targetFps: 15 } });

  const broken = join(dir, 'broken.json');
  await writeFile(broken, '{ not json');
  const originalError = console.error;
  console.error = () => undefined;
  try {
    assert.deepEqual(await createStorageArea({ file: broken }).get(null), {});
  } finally {
    console.error = originalError;
  }
});

test('sealed keys are encrypted on disk and read back whole', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'jester-sealed-')), 'storage-local.json');
  // A stand-in for safeStorage: reversible, and visibly not the plain text.
  const sealed = { keys: ['modelConnections'], seal: (text) => Buffer.from(text).toString('base64'), unseal: (text) => Buffer.from(text, 'base64').toString() };
  const area = createStorageArea({ file, sealed });
  const connections = [{ id: 'a', provider: 'groq', key: 'gsk_secret' }];
  await area.set({ modelConnections: connections, settings: { enabled: true } });
  const onDisk = await readFile(file, 'utf8');
  assert.equal(onDisk.includes('gsk_secret'), false, 'the key never reaches the file in the clear');
  assert.match(onDisk, /"settings":\{"enabled":true\}/, 'other keys are written as they are');
  assert.deepEqual((await createStorageArea({ file, sealed }).get('modelConnections')).modelConnections, connections);
  // Unreadable here (another account's keychain): forgotten, not fatal.
  const broken = { ...sealed, unseal: () => { throw new Error('no key'); } };
  assert.deepEqual(await createStorageArea({ file, sealed: broken }).get(['modelConnections', 'settings']), { settings: { enabled: true } });
});
