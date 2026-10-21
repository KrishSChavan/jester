/** Optional live check of the real extension: node tests/voice-browser-live.mjs
 * Loads the unpacked extension into a throwaway headless Chrome over a debugging
 * pipe (branded Chrome ignores --load-extension since 137), turns Jester on, and
 * sends spoken commands the way the engine does, with no model connected: every
 * request here must be handled on the device. Visits live sites (YouTube,
 * Wikipedia, Amazon, GitHub).
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const extension = fileURLToPath(new URL('../jester-extension/', import.meta.url));
const chromeBinary = process.env.JESTER_SMOKE_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const started = Date.now();
const log = (...args) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s]`, ...args);

const profile = await mkdtemp(resolve(tmpdir(), 'jester-voice-live-'));
const chrome = spawn(chromeBinary, ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-pipe',
  '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check', '--disable-sync', '--lang=en-US',
  '--autoplay-policy=no-user-gesture-required', '--window-size=1400,900', 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
let nextId = 0;
const pending = new Map();
const exceptions = [];
let buffer = '';
chrome.stdio[4].on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  for (let end; (end = buffer.indexOf('\0')) >= 0; buffer = buffer.slice(end + 1)) {
    const message = JSON.parse(buffer.slice(0, end));
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.exception?.description);
    const entry = message.id && pending.get(message.id);
    if (!entry) continue;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error))); else entry.resolve(message.result);
  }
});
const command = (method, params = {}, sessionId) => new Promise((done, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve: done, reject });
  chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
});
async function attach(match) {
  for (let i = 0; i < 100; i++) {
    const info = (await command('Target.getTargets')).targetInfos.find(match);
    if (info) {
      const { sessionId } = await command('Target.attachToTarget', { targetId: info.targetId, flatten: true });
      await command('Runtime.enable', {}, sessionId);
      return async (expression) => {
        const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        return result.result.value;
      };
    }
    await pause(150);
  }
  throw new Error('Target not found');
}

try {
  const { id } = await command('Extensions.loadUnpacked', { path: extension });
  const worker = await attach((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${id}/`));
  const settings = (patch) => worker(`(async () => { const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, ...${JSON.stringify(patch)} } }); })()`);
  await settings({ enabled: true, voiceEnabled: true });
  const engine = await attach((t) => t.url === `chrome-extension://${id}/src/offscreen/offscreen.html`);
  const front = async () => (await worker('chrome.tabs.query({ active: true })'))[0];
  const history = () => worker(`chrome.storage.session.get('history').then((r) => r.history || [])`);
  const send = (text) => engine(`chrome.runtime.sendMessage({ type: 'jester/voice-command', text: ${JSON.stringify(text)} })`);
  async function answer(before, ms = 45000) {
    for (const until = Date.now() + ms; Date.now() < until; await pause(200)) {
      const all = await history();
      if (all.length > before && all[0].action === 'ASSISTANT') return all[0];
    }
    assert.fail('No answer');
  }
  async function say(text, check) {
    const before = (await history()).length;
    await send(text);
    const entry = await answer(before);
    const tab = await front();
    log(`“${text}” → ${entry.detail} (${tab.url.slice(0, 60)})`);
    assert.equal(entry.ok, true, entry.detail);
    if (check) await check(entry, tab);
    return entry;
  }
  await worker(`chrome.tabs.query({ active: true }).then(([tab]) => chrome.tabs.update(tab.id, { url: 'chrome://newtab/' }))`);
  await pause(800);
  await say("Open YouTube and play MrBeast's latest video.", (entry, tab) => {
    assert.match(entry.detail, /^Playing MrBeast’s latest video/);
    assert.match(tab.url, /youtube\.com\/watch\?v=/);
  });
  await say('open wikipedia', (_, tab) => assert.match(tab.url, /wikipedia\.org/));
  await say('pause', (entry) => assert.match(entry.detail, /^Paused “.+” in another tab\.$/));
  await say('new tab', (_, tab) => assert.match(tab.url, /^chrome:\/\/newtab/));
  await say('switch to Wikipedia', (_, tab) => assert.match(tab.url, /wikipedia\.org/));
  await say('close this tab');
  // Chrome keeps closed pages, not closed New Tab pages, for reopening.
  await say('reopen the closed tab', (_, tab) => assert.match(tab.url, /wikipedia\.org/));
  await say('switch to YouTube', (_, tab) => assert.match(tab.url, /youtube\.com/));
  await say('search for lofi beats', (_, tab) => assert.match(tab.url, /youtube\.com\/results\?search_query=lofi/));
  await say('search Amazon for usb c hub', (_, tab) => assert.match(tab.url, /amazon\.com\/s\?k=usb/));
  await say('previous tab');
  // Approval by voice: the step waits for an answer, and "yes" lets it run.
  await settings({ agentPermissionBoundary: 'ask' });
  const before = (await history()).length;
  await send('open github dot com');
  await pause(1500);
  assert.equal((await history()).length, before, 'The step waits for an answer');
  await send('yes');
  const approved = await answer(before);
  assert.equal(approved.detail, 'Opened github.com.');
  await settings({ agentPermissionBoundary: 'entertainment' });
  assert.deepEqual(exceptions, []);
  log('All spoken browser commands completed on the device, with no model connected.');
} finally {
  chrome.kill('SIGKILL');
}
