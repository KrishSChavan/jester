import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, sep } from 'node:path';
import { ROOTS, resolveFile } from '../desktop/src/main/files.js';

test('jester:// URLs map into the extension and app folders', () => {
  assert.equal(resolveFile('jester://ext/src/offscreen/offscreen.html'), resolve(ROOTS.ext, 'src/offscreen/offscreen.html'));
  assert.equal(resolveFile('jester://ext/models/gesture_recognizer.task'), resolve(ROOTS.ext, 'models/gesture_recognizer.task'));
  assert.equal(resolveFile('jester://app/preload/chrome-shim.cjs'), resolve(ROOTS.app, 'preload/chrome-shim.cjs'));
  assert.equal(resolveFile('jester://ext/vendor/tasks-vision/wasm/vision_wasm_internal.wasm?x=1#y'), resolve(ROOTS.ext, 'vendor/tasks-vision/wasm/vision_wasm_internal.wasm'));
});

test('app pages reach the extension\'s modules through their own origin', () => {
  assert.equal(resolveFile('jester://app/ext/src/common/constants.js'), resolve(ROOTS.ext, 'src/common/constants.js'));
  assert.equal(resolveFile('jester://app/settings/settings.js'), resolve(ROOTS.app, 'settings/settings.js'));
  // Only a whole "ext" segment switches roots.
  assert.equal(resolveFile('jester://app/extras/x.js'), resolve(ROOTS.app, 'extras/x.js'));
  assert.equal(resolveFile('jester://app/ext/..%2F..%2Fdesktop/package.json'), null);
  assert.equal(resolveFile('jester://app/ext/../main/main.js'), resolve(ROOTS.app, 'main/main.js'));
});

test('the engine page loads the app\'s audio worklets as its own, and nothing else of the app', () => {
  assert.equal(resolveFile('jester://ext/_desktop/worklets/speech-capture.js'), resolve(ROOTS.app, 'worklets/speech-capture.js'));
  assert.equal(resolveFile('jester://ext/_desktop/main/main.js'), resolve(ROOTS.ext, '_desktop/main/main.js'), 'only worklets are mapped');
  assert.equal(resolveFile('jester://ext/_desktop/worklets/..%2F..%2Fmain%2Fmain.js'), null);
  assert.equal(resolveFile('jester://ext/_desktop/worklets/..%2Fmain%2Fmain.js'), null);
});

test('nothing outside those folders can be named, however it is spelled', () => {
  for (const url of [
    'jester://ext/../desktop/package.json',
    'jester://ext/%2e%2e/%2e%2e/etc/passwd',
    'jester://ext/..%2F..%2F..%2Fetc%2Fpasswd',
    'jester://ext/src/..%2F..%2F..%2F.ssh/id_rsa',
    'jester://app/..%5C..%5Cwindows',
    'jester://other/file.txt',
    'jester://__proto__/x',
    'jester://constructor/x',
    'file:///etc/passwd',
    'https://ext/src/offscreen/offscreen.html',
    'not a url'
  ]) {
    const file = resolveFile(url);
    assert.ok(file === null || file.startsWith(ROOTS.ext + sep) || file.startsWith(ROOTS.app + sep), `${url} → ${file}`);
    if (!/^jester:\/\/(ext|app)\//.test(url)) assert.equal(file, null, url);
  }
  assert.equal(resolveFile('jester://ext/..%2F..%2F..%2Fetc%2Fpasswd'), null);
});
