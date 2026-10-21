import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { DEFAULT_SETTINGS, MSG, ENGINE } from '../jester-extension/src/common/constants.js';

const extension = fileURLToPath(new URL('../jester-extension/', import.meta.url));
const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
const pages = ['src/options/options.html', 'src/popup/popup.html', 'src/calibration/calibration.html', 'src/offscreen/offscreen.html'];
const stripComments = (html) => html.replace(/<!--[\s\S]*?-->/g, '');

test('manifest and extension-page scripts, styles, images and tracking assets exist', async () => {
  const files = [manifest.background.service_worker, ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon),
    ...manifest.content_scripts.flatMap((entry) => entry.js || []),
    'models/face_landmarker.task', 'models/gesture_recognizer.task',
    'vendor/tasks-vision/vision_bundle.mjs'];
  for (const page of pages) {
    const html = stripComments(await readFile(resolve(extension, page), 'utf8'));
    for (const match of html.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)) {
      const value = match[1];
      if (!/^(?:https?:|data:|#)/.test(value)) files.push(resolve(dirname(resolve(extension, page)), value.split('#')[0]));
    }
  }
  for (const file of files) await assert.doesNotReject(access(resolve(extension, file)), `missing asset: ${file}`);
});

test('extension-page literal control IDs and setting bindings match their HTML', async () => {
  for (const page of pages) {
    const absolute = resolve(extension, page);
    const html = stripComments(await readFile(absolute, 'utf8'));
    const ids = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map((match) => match[1]);
    assert.equal(new Set(ids).size, ids.length, `duplicate HTML IDs in ${page}`);
    for (const match of html.matchAll(/\bdata-setting=["']([^"']+)["']/g)) {
      assert.ok(Object.hasOwn(DEFAULT_SETTINGS, match[1]), `${page} binds an unknown setting ${match[1]}`);
    }
    for (const match of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/g)) {
      const script = await readFile(resolve(dirname(absolute), match[1]), 'utf8');
      for (const reference of script.matchAll(/\b(?:getElementById|el)\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        assert.ok(ids.includes(reference[1]), `${page} is missing #${reference[1]}`);
      }
    }
  }
});

test('browser module graphs link without missing imports or named exports', () => {
  // Link without evaluating: browser-only globals, camera and microphone are
  // never touched, while the actual module loader checks every named import.
  const checker = String.raw`
    import vm from 'node:vm';
    import {readFile} from 'node:fs/promises';
    import {resolve,dirname} from 'node:path';
    const root=process.argv[1];
    const modules=new Map();
    async function getModule(file) {
      if (modules.has(file)) return modules.get(file);
      const module=new vm.SourceTextModule(await readFile(file,'utf8'),{identifier:file});
      modules.set(file,module);
      return module;
    }
    for (const entry of ['src/background/service-worker.js','src/options/options.js','src/popup/popup.js','src/calibration/calibration.js','src/offscreen/offscreen.js']) {
      const module=await getModule(resolve(root,entry));
      if (module.status==='unlinked') await module.link((specifier,parent) => {
        if (!specifier.startsWith('.')) throw new Error('Unexpected nonlocal dependency: '+specifier);
        return getModule(resolve(dirname(parent.identifier),specifier));
      });
    }
  `;
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', checker, extension], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('the engine page refuses MediaPipe usage logging and still loads its own files', async () => {
  const source = await readFile(resolve(extension, 'src/offscreen/boot.js'), 'utf8');
  const fetched = [];
  const window = { addEventListener() {}, fetch: (input) => { fetched.push(String(input)); return Promise.resolve('loaded'); } };
  vm.runInContext(source, vm.createContext({ window, URL, location: { href: 'chrome-extension://jester/src/offscreen/offscreen.html' } }));
  await assert.rejects(window.fetch('https://odml.pa.googleapis.com/v1/log', { method: 'POST' }), /MediaPipe usage logs/);
  await assert.rejects(window.fetch(new URL('https://odml.pa.googleapis.com/v1/log')), /MediaPipe usage logs/);
  assert.equal(await window.fetch('chrome-extension://jester/models/gesture_recognizer.task'), 'loaded');
  assert.equal(await window.fetch('../../vendor/tasks-vision/wasm/vision_wasm_internal.wasm'), 'loaded');
  assert.deepEqual(fetched, ['chrome-extension://jester/models/gesture_recognizer.task', '../../vendor/tasks-vision/wasm/vision_wasm_internal.wasm']);
});

test('engine message constants and state names used by its module are exported', async () => {
  const source = await readFile(resolve(extension, 'src/offscreen/offscreen.js'), 'utf8');
  for (const [, name] of source.matchAll(/\bMSG\.([A-Z][A-Z_]+)/g)) assert.ok(Object.hasOwn(MSG, name), `missing MSG.${name}`);
  for (const [, name] of source.matchAll(/\bENGINE\.([A-Z][A-Z_]+)/g)) assert.ok(Object.hasOwn(ENGINE, name), `missing ENGINE.${name}`);
});

test('gesture voice action sends one toggle and does not start a second capture', async () => {
  const source = await readFile(resolve(extension, 'src/background/service-worker.js'), 'utf8');
  const start = source.indexOf('async function dispatchAction(');
  const end = source.indexOf('\n}\n', start) + 2;
  assert.ok(start >= 0 && end > start);
  const sent = [];
  const notices = [];
  const { ACTIONS } = await import('../jester-extension/src/common/constants.js');
  let front = { id: 7, url: 'https://www.youtube.com/' };
  let settings = { enabled: true, voiceEnabled: true };
  const sandbox = vm.createContext({ ACTIONS, MSG, visibleTab: async () => front, getSettings: async () => settings,
    notify: (text) => notices.push(text), post: (message) => sent.push(message) });
  const dispatch = vm.runInContext(`(${source.slice(start, end)})`, sandbox);
  const result = await dispatch('VOICE_CAPTURE_TOGGLE', { source: 'pose', gesture: 'Pointing_Up' });
  assert.equal(result.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, MSG.VOICE_CONTROL);
  assert.equal(sent[0].action, 'toggle');
  // Chrome's own pages take voice too: tab commands work there.
  front = { id: 8, url: 'chrome://newtab/' };
  assert.equal((await dispatch('VOICE_CAPTURE_TOGGLE', { source: 'keyboard' })).ok, true);
  assert.equal(sent.length, 2);
  // With voice off, the shortcut says so instead of doing nothing.
  settings = { enabled: true, voiceEnabled: false };
  assert.equal((await dispatch('VOICE_CAPTURE_TOGGLE', { source: 'keyboard' })).ok, false);
  assert.equal(sent.length, 2);
  assert.match(notices[0], /Voice commands are off/);
  front = null;
  assert.equal((await dispatch('VOICE_CAPTURE_TOGGLE', { source: 'keyboard' })).ok, false);
});

async function voiceBridge() {
  const source = await readFile(resolve(extension, 'src/offscreen/offscreen.js'), 'utf8');
  const start = source.indexOf('let micStatus = ');
  const end = source.indexOf('// Settings + messaging', start);
  assert.ok(start >= 0 && end > start);
  const messages = [];
  let callbacks;
  const controls = [];
  const microphone = { active: false, start: () => controls.push('start'), stop: () => controls.push('cancel'), finish: () => controls.push('finish') };
  const { MIC } = await import('../jester-extension/src/offscreen/voice.js');
  const sandbox = vm.createContext({
    MSG, MIC, settings: { enabled: true, voiceEnabled: true, voiceLanguage: 'en-US' }, standby: false,
    lastStatus: { state: ENGINE.RUNNING, mic: { state: MIC.IDLE } },
    post: (message) => messages.push(message),
    createVoice(options) {
      callbacks = options;
      // A synchronous initial status is legal: the bridge cannot rely on the
      // voice factory having returned before it handles microphone status.
      options.onStatus({ state: MIC.IDLE, detail: '' });
      return microphone;
    }
  });
  vm.runInContext(source.slice(start, end) + '\nglobalThis.bridge = { controlVoice };', sandbox);
  messages.length = 0;
  return { sandbox, messages, callbacks, controls, MIC };
}

test('microphone status survives engine queries and the voice bridge initializes safely', async () => {
  const { sandbox, messages, callbacks, MIC } = await voiceBridge();
  callbacks.onStatus({ state: MIC.ERROR, detail: 'Local language pack is unavailable.' });
  assert.equal(sandbox.lastStatus.mic.state, MIC.ERROR);
  assert.equal(messages.at(-1).type, MSG.ENGINE_STATUS);
  assert.equal(messages.at(-1).mic.detail, 'Local language pack is unavailable.');
});

test('voice completion preserves error and no-speech feedback, while cancel and command handoff stay distinct', async () => {
  const { messages, callbacks, MIC } = await voiceBridge();
  for (const completion of [
    { state: MIC.ERROR, detail: 'Local speech is unavailable.' },
    { state: MIC.NO_PERMISSION, detail: 'Allow the microphone in Settings.' },
    { state: MIC.IDLE, detail: 'No command heard.' },
    { state: MIC.IDLE, detail: 'Voice command timed out.' }
  ]) {
    callbacks.onComplete({ submitted: false, ...completion });
    assert.equal(messages.at(-1).voice.phase, 'answer');
    assert.equal(messages.at(-1).voice.text, completion.detail);
  }
  callbacks.onComplete({ submitted: false, state: MIC.IDLE, detail: '' });
  assert.equal(messages.at(-1).voice.active, false);
  const before = messages.length;
  callbacks.onComplete({ submitted: true, state: MIC.IDLE, detail: '' });
  assert.equal(messages.length, before);
});

test('voice control cannot emit a direct cursor click around the worker permission boundary', async () => {
  const { sandbox, messages, controls } = await voiceBridge();
  sandbox.bridge.controlVoice('click');
  assert.deepEqual(controls, []);
  assert.deepEqual(messages, []);
});
