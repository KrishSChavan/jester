/** Optional live check against youtube.com: node tests/youtube-live.mjs ["go to MrBeast's latest video"] [start URL]
 * Throwaway headless Chrome profile (signed out, so ads play). The production
 * assistant, planner and page tools run against the live site through the same
 * trusted DevTools input the extension uses; the content script's own navigation
 * settle code is loaded from content.js. A model request fails the run. Fixtures
 * cannot follow YouTube's markup changes; this can.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { runAssistant } from '../jester-extension/src/background/assistant.js';

const extension = fileURLToPath(new URL('../jester-extension/', import.meta.url));
const chromeBinary = process.env.JESTER_SMOKE_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const goal = process.argv[2] || "go to MrBeast's latest video";
const startUrl = process.argv[3] || 'https://www.youtube.com/';
const [width, height] = (process.env.JESTER_VIEWPORT || '1280x900').split('x').map(Number);
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const content = await readFile(resolve(extension, 'src/content/content.js'), 'utf8');
const settle = content.slice(content.indexOf('  function navigationPending() {'), content.indexOf('  chrome.runtime.onMessage.addListener'));
assert.match(settle, /settleNavigation/, 'content.js navigation settle code moved');
const pageTools = await readFile(resolve(extension, 'src/content/agent-page.js'), 'utf8') +
  `\nglobalThis.__settle = (() => {\n${settle}\nreturn { navigationPending, settleNavigation };\n})();`;

const profile = await mkdtemp(resolve(tmpdir(), 'jester-youtube-live-'));
const chrome = spawn(chromeBinary, ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
  '--no-first-run', '--no-default-browser-check', '--disable-default-apps', '--disable-sync', '--lang=en-US',
  '--autoplay-policy=no-user-gesture-required', `--window-size=${width},${height}`, 'about:blank'], { stdio: 'ignore' });
let socket;
const started = Date.now();
const log = (...args) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s]`, ...args);
try {
  let portFile;
  for (let i = 0; i < 200 && !portFile; i++) {
    portFile = await readFile(resolve(profile, 'DevToolsActivePort'), 'utf8').catch(() => null);
    if (!portFile) await pause(50);
  }
  assert.ok(portFile, 'Chrome did not start');
  const [port, path] = portFile.trim().split('\n');
  socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise((done, reject) => { socket.onopen = done; socket.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error))); else entry.resolve(message.result);
  };
  let sessionId;
  const command = (method, params = {}) => new Promise((done, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve: done, reject });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const { targetId } = await command('Target.createTarget', { url: 'about:blank' });
  ({ sessionId } = await command('Target.attachToTarget', { targetId, flatten: true }));
  await command('Page.enable');
  await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

  // A content script's isolated world, made again for each new document.
  let world = null;
  async function evaluate(expression) {
    const { frameTree } = await command('Page.getFrameTree');
    if (world?.loaderId !== frameTree.frame.loaderId) {
      const { executionContextId } = await command('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'jester' });
      world = { loaderId: frameTree.frame.loaderId, contextId: executionContextId };
      await command('Runtime.evaluate', { expression: pageTools, contextId: world.contextId });
    }
    const result = await command('Runtime.evaluate', { expression, contextId: world.contextId, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  async function open(url) {
    await command('Page.navigate', { url });
    for (let i = 0; i < 150; i++) {
      await pause(100);
      const { result } = await command('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }).catch(() => ({ result: {} }));
      if (result.value === 'complete') return;
    }
  }
  const input = (step, action) => evaluate(`__jesterAgentPage.input(${JSON.stringify(step)}, ${JSON.stringify(action)}, {boundary:'entertainment'})`);
  const mouse = (params) => command('Input.dispatchMouseEvent', { button: 'none', buttons: 0, ...params });
  /** The worker's real-input path, as in executeReal: aim, move, land, press. */
  async function real(action) {
    if (action.action === 'type' || action.action === 'press_key') {
      const ready = await input('ready', action);
      if (!ready?.ok) return ready;
      if (action.action === 'type') await command('Input.insertText', { text: action.text });
      else for (const type of ['keyDown', 'keyUp']) {
        await command('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
          ...(type === 'keyDown' ? { text: '\r', unmodifiedText: '\r' } : {}) });
      }
      await input('done', action);
      return { ...ready, ok: true };
    }
    const aimed = await input('aim', action);
    if (!aimed?.ok) return aimed;
    let target = { x: aimed.x, y: aimed.y };
    let landed;
    for (let attempt = 0; attempt < 3; attempt++) {
      await mouse({ type: 'mouseMoved', ...target });
      await pause(100);
      landed = await input('land', action);
      if (!landed?.move) break;
      target = landed.move;
    }
    if (landed?.ok) {
      await mouse({ type: 'mousePressed', x: landed.x, y: landed.y, button: 'left', buttons: 1, clickCount: 1 });
      await mouse({ type: 'mouseReleased', x: landed.x, y: landed.y, button: 'left', clickCount: 1 });
    }
    await input('done', action);
    return landed?.ok ? { ...aimed, ok: true } : landed;
  }

  await open(startUrl);
  await pause(1500);
  let modelCalls = 0;
  const result = await runAssistant({ text: goal, env: { provider: 'groq', model: 'live-check', key: 'not-a-key' },
    modelClient: async (request) => {
      modelCalls++;
      log('Model requested on this page:\n' + JSON.parse(request.prompt).page.text);
      throw new Error('The live check expects no model request');
    },
    host: {
      async observe(options) {
        const page = await evaluate(`(async () => {
          const options = ${JSON.stringify(options)};
          const begun = performance.now();
          if ((typeof options.since === 'string' && options.since !== __jesterAgentPage.route()) || __settle.navigationPending()) await __settle.settleNavigation();
          else await new Promise(done => requestAnimationFrame(done));
          return { ...__jesterAgentPage.observe(options), settleMs: Math.round(performance.now() - begun) };
        })()`);
        log(`look ${new URL(page.url).pathname}${new URL(page.url).search} (${page.elements.length} of ${page.count}, after ${page.settleMs} ms)`);
        return page;
      },
      async execute(action) {
        let outcome;
        if (action.action === 'navigate') { await open(action.url); outcome = { ok: true, detail: 'Opened the page.' }; }
        else if (action.action === 'command') outcome = await evaluate(`(async () => { const v = document.querySelector('video'); await v?.play().catch(() => {}); return { ok: !!v && !v.paused }; })()`);
        else if (['click', 'type', 'press_key'].includes(action.action)) {
          outcome = await real(action);
          if (outcome?.native === false) outcome = await evaluate(`__jesterAgentPage.execute(${JSON.stringify(action)}, {boundary:'entertainment'})`);
        } else outcome = await evaluate(`__jesterAgentPage.execute(${JSON.stringify(action)}, {boundary:'entertainment'})`);
        log(`${action.action} ${action.text || action.key || action.url || action.actionId || action.elementId || ''} → ${outcome?.ok ? 'ok' : JSON.stringify(outcome).slice(0, 200)}`);
        return outcome;
      },
      checkpoint: async () => {},
      thinking: async () => {}
    } });
  const final = await evaluate(`({ url: location.href, playing: !!document.querySelector('video') && !document.querySelector('video').paused })`);
  log(JSON.stringify({ ok: result.ok, say: result.say, modelCalls, ...final }));
  assert.equal(result.ok, true, result.say);
  assert.equal(modelCalls, 0);
  assert.equal(final.playing, true);
} finally {
  socket?.close();
  chrome.kill('SIGKILL');
}
