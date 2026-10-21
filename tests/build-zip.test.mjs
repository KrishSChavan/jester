import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { inflateRawSync, crc32 } from 'node:zlib';
import { build, storeProblems, keyShapes, SOURCE } from '../build-zip.mjs';

const manifest = JSON.parse(await readFile(resolve(SOURCE, 'manifest.json'), 'utf8'));

/** Every entry of a zip by name, inflated and checked against its CRC. */
function unzip(archive) {
  const end = archive.length - 22;
  assert.equal(archive.readUInt32LE(end), 0x06054b50, 'end of central directory');
  const entries = new Map();
  for (let i = 0, at = archive.readUInt32LE(end + 16); i < archive.readUInt16LE(end + 10); i++) {
    assert.equal(archive.readUInt32LE(at), 0x02014b50, 'central directory entry');
    const nameLength = archive.readUInt16LE(at + 28);
    const name = archive.toString('utf8', at + 46, at + 46 + nameLength);
    const local = archive.readUInt32LE(at + 42);
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const body = archive.subarray(start, start + archive.readUInt32LE(at + 20));
    const data = archive.readUInt16LE(at + 10) === 8 ? inflateRawSync(body) : body;
    assert.equal(crc32(data), archive.readUInt32LE(at + 16), `${name} CRC`);
    entries.set(name, data);
    at += 46 + nameLength + archive.readUInt16LE(at + 30) + archive.readUInt16LE(at + 32);
  }
  return entries;
}

test('the manifest is within the Web Store limits, which catch the description that failed upload', () => {
  assert.deepEqual(storeProblems(manifest), []);
  const failed = 'Control video playback with hand gestures on YouTube, Netflix, Disney+, Hulu and more. All hand tracking runs on-device via MediaPipe.';
  assert.deepEqual(storeProblems({ ...manifest, description: failed }), ['description is 134 characters; the Web Store allows 132']);
  assert.match(storeProblems({ ...manifest, version: '0.01' }).join(), /version "0\.01"/);
  assert.match(storeProblems({ ...manifest, version: '1.65536' }).join(), /version/);
  assert.match(storeProblems({ ...manifest, manifest_version: 2 }).join(), /only accepts 3/);
  assert.match(storeProblems({ ...manifest, name: 'J'.repeat(76) }).join(), /name is 76 characters/);
  assert.deepEqual(storeProblems({ ...manifest, description: '__MSG_description__' }), [], 'measured in _locales instead');
});

test('the store zip has manifest.json at its root, every shipped file byte for byte, and nothing private', async () => {
  const out = resolve(await mkdtemp(resolve(tmpdir(), 'jester-zip-')), 'jester.zip');
  const report = await build({ out });
  const entries = unzip(await readFile(out));
  assert.deepEqual([...entries.keys()], report.files);
  assert.ok(entries.has('manifest.json'));
  const packed = JSON.parse(entries.get('manifest.json'));
  for (const path of [packed.background.service_worker, packed.action.default_popup, packed.options_ui.page,
    ...Object.values(packed.icons), ...packed.content_scripts.flatMap((script) => script.js),
    'models/gesture_recognizer.task', 'models/face_landmarker.task', 'vendor/tasks-vision/wasm/vision_wasm_internal.wasm']) {
    assert.ok(entries.has(path), `missing ${path}`);
  }
  for (const [name, data] of entries) {
    assert.doesNotMatch(name, /(?:^|\/)\.|env\.txt$|README\.md$|\.map$|\.d\.ts$|legacy-finger-pointer/, `${name} should not ship`);
    assert.ok(data.equals(await readFile(resolve(SOURCE, name))), `${name} differs from its source`);
  }
  assert.ok(report.leftOut.includes('.env.example') && report.leftOut.includes('src/offscreen/legacy-finger-pointer.js'));
});

test('anything shaped like a provider key stops the build, and the key itself is never repeated', () => {
  const fakes = { Groq: `gsk_${'Q7'.repeat(26)}`, OpenAI: `sk-proj-${'a1B2'.repeat(12)}`, Google: `AIza${'x'.repeat(35)}` };
  for (const [provider, key] of Object.entries(fakes)) {
    const found = keyShapes(`const key = '${key}';`);
    assert.equal(found.length, 1, provider);
    assert.ok(!found[0].includes(key.slice(4)), 'only the kind of key is named');
  }
  assert.deepEqual(keyShapes("placeholder 'sk-...' in a hint; task-runner-identifier-long-enough; mask-image-gradient-value"), []);
});
