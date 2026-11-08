/**
 * The link as it's built, end to end: the real extension in a throwaway
 * headless Chrome, the real relay, and the app's own half (chrome-link.js),
 * with nothing installed outside a temp folder and no camera, mic or input of
 * the user's touched (Chrome's camera is its fake one).
 *
 *   node spikes/link-live.mjs        (about half a minute)
 *
 * Checks: the extension links when the user's switch (the nativeMessaging
 * permission) is on; its own engine closes while linked and opens again after;
 * the app learns its gestures; a bookmark's name makes a command Chrome's, and
 * an unknown one doesn't; a command the app hands over is done, with its steps
 * on the app's pill; a gesture's action is done in Chrome; and a click aimed
 * near a link on a page snaps to it.
 */

import { spawn } from 'node:child_process';
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChromeLink } from '../src/main/chrome-link.js';
import { driverPath } from '../src/main/driver.js';
import { HOST_NAME, hostManifest, startLink } from '../src/main/link.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const chromeBinary = process.env.JESTER_SMOKE_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const started = Date.now();
const log = (...args) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s]`, ...args);
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass: !!pass });
  log(`${pass ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};
async function until(test, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await pause(50)) if (await test()) return true;
  return false;
}

// Unix socket paths are capped near 104 bytes, so this lives in the short system temp dir.
const dir = await mkdtemp(path.join(tmpdir(), 'jester-live-'));
const socketPath = path.join(dir, 'link.sock');
const profile = path.join(dir, 'profile');
const extension = path.join(dir, 'extension');
await cp(path.resolve(here, '../../jester-extension'), extension, { recursive: true });
// The user's switch, already on (no one to click Link here), and the test page's site added to where Jester runs.
const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
manifest.permissions.push('nativeMessaging');
manifest.content_scripts[0].matches.push('http://127.0.0.1/*');
await writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest, null, 2));
// A relay run from ~/Downloads never starts (README): from here it does.
const relay = path.join(dir, 'jester-link-relay');
await copyFile(driverPath(), relay);
await chmod(relay, 0o755);

// A page with one link, where the cursor will aim near it.
const page = http.createServer((_request, response) => {
  response.setHeader('content-type', 'text/html');
  response.end('<!doctype html><title>Aim</title><body style="margin:0"><a id="go" href="#go" style="position:absolute;left:100px;top:100px;width:120px;height:30px;display:block">Go</a></body>');
});
await new Promise((resolve) => page.listen(0, '127.0.0.1', resolve));
const pageUrl = `http://127.0.0.1:${page.address().port}/`;

const pills = [];
const link = createChromeLink({ send: (message) => !!transport.send(message), version: 'spike', onPill: (voice) => pills.push(voice), onAsk: async () => false, log });
const transport = startLink({ socketPath, onConnect: (origin, hello) => link.connected(origin, hello), onMessage: (message) => link.message(message), onDisconnect: () => link.disconnected() });
await transport.ready;

const chrome = spawn(
  chromeBinary,
  ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check', '--disable-sync', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', 'about:blank'],
  { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], env: { ...process.env, JESTER_LINK_SOCKET: socketPath } }
);

// Chrome DevTools Protocol over the pipe, as tests/voice-browser-live.mjs does.
let nextId = 0;
const pending = new Map();
let buffer = '';
chrome.stdio[4].on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  for (let end; (end = buffer.indexOf('\0')) >= 0; buffer = buffer.slice(end + 1)) {
    const message = JSON.parse(buffer.slice(0, end));
    const entry = message.id && pending.get(message.id);
    if (!entry) continue;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  }
});
const command = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
async function attach(match) {
  for (let i = 0; i < 100; i++) {
    const info = (await command('Target.getTargets')).targetInfos.find(match);
    if (info) {
      const { sessionId } = await command('Target.attachToTarget', { targetId: info.targetId, flatten: true });
      const evaluate = async (expression) => {
        const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        return result.result.value;
      };
      // Right after loading, an extension's worker can be attached before Chrome binds its APIs.
      if (info.url.startsWith('chrome-extension://')) for (let tries = 0; tries < 50 && !(await evaluate(`typeof chrome === 'object' && !!chrome.runtime?.id`).catch(() => false)); tries++) await pause(100);
      return evaluate;
    }
    await pause(150);
  }
  throw new Error('target not found');
}

try {
  const { id } = await command('Extensions.loadUnpacked', { path: extension });
  const worker = await attach((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${id}/`));
  const engineOpen = () => worker(`chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }).then((found) => found.length > 0)`);
  // Jester on, as a user would have it: its engine opens (on Chrome's fake camera).
  await worker(`chrome.storage.local.get('settings').then(({ settings }) => chrome.storage.local.set({ settings: { ...(settings || {}), enabled: true } }))`);
  check('unlinked, the extension’s own engine runs', await until(engineOpen), '');

  // Jester Desktop "installed": its manifest names this extension. Settings' Link button says connect.
  await mkdir(path.join(profile, 'NativeMessagingHosts'), { recursive: true });
  await writeFile(path.join(profile, 'NativeMessagingHosts', `${HOST_NAME}.json`), JSON.stringify(hostManifest({ relayPath: relay, origins: [`chrome-extension://${id}/`] })));
  const { targetId } = await command('Target.createTarget', { url: `chrome-extension://${id}/src/options/options.html` });
  const options = await attach((t) => t.targetId === targetId);
  await options(`chrome.runtime.sendMessage({ type: 'jester/desktop-link', op: 'connect' })`);
  check('the extension links to the app', await until(() => link.linked), `extension ${link.version}`);
  check('the app learns what gestures do in Chrome', !!link.bindings()?.bindings, Object.keys(link.bindings() || {}).join(', '));
  check('linked, the extension’s engine closes: one camera and mic', await until(async () => !(await engineOpen())), '');
  const badge = await worker(`chrome.action.getBadgeText({})`);
  const linkText = await options(`new Promise((resolve) => setTimeout(() => resolve(document.getElementById('desktopText').textContent), 300))`);
  check('Chrome says it’s linked', badge === '●' && /Linked: Jester Desktop is watching/.test(linkText), `badge ${JSON.stringify(badge)}, Settings: ${JSON.stringify(linkText)}`);

  // A bookmark's name makes a command Chrome's.
  await worker(`chrome.bookmarks.create({ title: 'Canvas Course', url: 'https://example.edu/courses' })`);
  const mine = await link.claims('open my canvas course');
  const notMine = await link.claims('open my grocery list');
  check('a bookmark’s name makes a command Chrome’s, an unknown name doesn’t', mine === true && notMine === false, `canvas course: ${mine}, grocery list: ${notMine}`);

  // A command the app hands over, done in Chrome, its steps on the app's pill.
  const tabs = () => worker(`chrome.tabs.query({}).then((tabs) => tabs.length)`);
  const before = await tabs();
  const done = await link.task('open a new tab');
  check('a command the app hands over is done in Chrome', done?.ok === true && (await tabs()) === before + 1, `${JSON.stringify(done)}, tabs ${before} → ${await tabs()}; pill frames: ${JSON.stringify(pills.slice(0, 2))}`);

  // A gesture's action, with Chrome in front.
  await worker(`chrome.tabs.create({ url: ${JSON.stringify(pageUrl)}, active: true })`);
  const pageTab = await attach((t) => t.type === 'page' && t.url.startsWith(pageUrl));
  await until(() => pageTab(`!!document.getElementById('go')`));
  const activeUrl = () => worker(`chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([tab]) => tab?.url || '')`);
  const acted = await link.act('TAB_PREV', { source: 'swipe', gesture: 'left' });
  const movedTo = await activeUrl();
  check('a gesture’s action is done in Chrome', acted?.ok === true && movedTo !== pageUrl, `${JSON.stringify(acted)}, now on ${movedTo || 'a new tab'}`);
  await worker(`chrome.tabs.query({ url: ${JSON.stringify(`${pageUrl}*`)} }).then(([tab]) => chrome.tabs.update(tab.id, { active: true }))`);
  await until(async () => (await activeUrl()) === pageUrl);

  // A click aimed 15 px left of the link snaps onto it. Where the page starts on the screen: below the window's toolbar.
  const origin = await pageTab(`({ x: window.screenX + (outerWidth - innerWidth) / 2, y: window.screenY + outerHeight - innerHeight })`);
  // The content script's first look at a page may still be loading it.
  let frame = null;
  await until(async () => (frame = await link.aim({ x: origin.x + 85, y: origin.y + 115, radius: 40 })));
  if (!frame) log('the page itself answers:', JSON.stringify(await worker(`chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([tab]) => chrome.tabs.sendMessage(tab.id, { type: 'jester/link-aim', x: ${origin.x + 85}, y: ${origin.y + 115}, radius: 40, zoom: 1 }, { frameId: 0 })).catch((err) => err.message)`)), 'origin', JSON.stringify(origin), 'window', JSON.stringify(await pageTab(`[outerWidth, innerWidth, outerHeight, innerHeight]`)));
  const right = frame && Math.round(frame.x - origin.x) === 100 && Math.round(frame.y - origin.y) === 100 && Math.round(frame.w) === 120 && Math.round(frame.h) === 30;
  const missed = await link.aim({ x: origin.x + 400, y: origin.y + 400, radius: 40 });
  check('a click aimed near a link snaps to it, and one aimed at nothing doesn’t', right && missed === null, `found ${JSON.stringify(frame)}, far away: ${JSON.stringify(missed)}`);

  // The app goes: Chrome's engine comes back.
  transport.close();
  check('unlinked again, the extension’s engine reopens', await until(engineOpen, 8000), '');
} catch (err) {
  check('spike ran', false, err.stack || err.message);
} finally {
  chrome.kill();
  try {
    transport.close();
  } catch {
    /* closed above */
  }
  page.close();
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  log(`${results.filter((r) => r.pass).length}/${results.length} passed`);
  process.exit(results.every((r) => r.pass) ? 0 : 1);
}
