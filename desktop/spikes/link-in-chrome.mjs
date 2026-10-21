/**
 * Phase 0 spike: the extension and the app talking through Chrome's native
 * messaging, end to end, with nothing installed outside a throwaway folder.
 *
 *   node spikes/link-in-chrome.mjs        (about a minute)
 *
 * A copy of the extension with the nativeMessaging permission added loads
 * into a headless Chrome with a fresh profile. The host manifest goes in that
 * profile's own NativeMessagingHosts folder, so the Chrome you use is never
 * touched. Checks: round trips, the app pushing to the extension, what the
 * extension hears when the app isn't running, and whether an open port keeps
 * the service worker alive with no debugger attached.
 */

import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

// Unix socket paths are capped near 104 bytes, so this lives in the short system temp dir.
const dir = await mkdtemp(path.join(tmpdir(), 'jester-link-'));
const socketPath = path.join(dir, 'link.sock');
const profile = path.join(dir, 'profile');
const extension = path.join(dir, 'extension');
await cp(path.resolve(here, '../../jester-extension'), extension, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
manifest.permissions.push('nativeMessaging');
await writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest, null, 2));

let link = null;
let connects = 0;
let disconnects = 0;
function listen() {
  link = startLink({
    socketPath,
    onConnect: (origin) => {
      connects += 1;
      log('app: extension connected from', origin);
    },
    onDisconnect: () => (disconnects += 1),
    onMessage: (message) => {
      if (message.type === 'jester/ping') link.send({ type: 'jester/pong', n: message.n });
    }
  });
  return link.ready;
}
await listen();

const chrome = spawn(
  chromeBinary,
  ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check', '--disable-sync', 'about:blank'],
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
      // Right after loading, the worker can be attached before Chrome binds its APIs.
      for (let tries = 0; tries < 50 && !(await evaluate(`typeof chrome === 'object' && !!chrome.runtime?.id`)); tries++) await pause(100);
      evaluate.detach = () => command('Target.detachFromTarget', { sessionId });
      return evaluate;
    }
    await pause(150);
  }
  throw new Error('target not found');
}

try {
  const { id } = await command('Extensions.loadUnpacked', { path: extension });
  await mkdir(path.join(profile, 'NativeMessagingHosts'), { recursive: true });
  await writeFile(
    path.join(profile, 'NativeMessagingHosts', `${HOST_NAME}.json`),
    JSON.stringify(hostManifest({ relayPath: driverPath(), origins: [`chrome-extension://${id}/`] }), null, 2)
  );
  const workerTarget = (t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${id}/`);
  let worker = await attach(workerTarget);

  const trip = await worker(`(async () => {
    const port = chrome.runtime.connectNative(${JSON.stringify(HOST_NAME)});
    const inbox = [];
    let closed = null;
    port.onMessage.addListener((message) => inbox.push(message));
    port.onDisconnect.addListener(() => { closed = chrome.runtime.lastError?.message || 'disconnected'; });
    const rtts = [];
    for (let n = 0; n < 50 && !closed; n++) {
      const sent = performance.now();
      port.postMessage({ type: 'jester/ping', n });
      // Three seconds per ping: a host Chrome never starts neither answers nor closes quickly.
      while (!closed && !inbox.some((m) => m.type === 'jester/pong' && m.n === n) && performance.now() - sent < 3000) await new Promise((r) => setTimeout(r, 1));
      if (closed || performance.now() - sent >= 3000) break;
      rtts.push(performance.now() - sent);
    }
    globalThis.__jester = { port, inbox, closed: () => closed };
    return { rtts, closed, inbox: inbox.slice(0, 3) };
  })()`);
  log('round trip result:', JSON.stringify({ count: trip.rtts.length, closed: trip.closed, inbox: trip.inbox }));
  const rtts = trip.rtts.slice(5).sort((a, b) => a - b);
  check('extension ⇄ app round trips', trip.rtts.length === 50, trip.closed || `median ${rtts[rtts.length >> 1]?.toFixed(1)} ms, max ${rtts.at(-1)?.toFixed(1)} ms over 45`);

  link.send({ type: 'jester/trigger', action: 'PLAY_PAUSE' });
  await pause(300);
  const pushed = await worker(`globalThis.__jester.inbox.filter((m) => m.type === 'jester/trigger')`);
  check('app pushes to the extension', pushed.length === 1 && pushed[0].action === 'PLAY_PAUSE', JSON.stringify(pushed));

  // No debugger attached for 40 s: only the open port can keep the worker up.
  await worker.detach();
  log('waiting 40 s with no debugger attached…');
  await pause(40_000);
  worker = await attach(workerTarget);
  const alive = await worker(`!!globalThis.__jester && !globalThis.__jester.closed()`);
  check('open port keeps the service worker alive', alive && link.connected && disconnects === 0, `worker state kept: ${alive}, link connected: ${link.connected}`);

  // The app goes away: what does the extension hear?
  link.close();
  await pause(300);
  const after = await worker(`(async () => {
    const port = chrome.runtime.connectNative(${JSON.stringify(HOST_NAME)});
    const inbox = [];
    let closed = null;
    port.onMessage.addListener((message) => inbox.push(message));
    port.onDisconnect.addListener(() => { closed = chrome.runtime.lastError?.message || 'disconnected'; });
    for (let i = 0; i < 300 && !closed; i++) await new Promise((r) => setTimeout(r, 10));
    return { inbox, closed };
  })()`);
  check('"app not running" reaches the extension', after.inbox[0]?.type === 'jester/link-error', JSON.stringify(after));
} catch (err) {
  check('spike ran', false, err.message);
} finally {
  chrome.kill();
  link?.close();
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  log(`${results.filter((r) => r.pass).length}/${results.length} passed`);
  process.exit(results.every((r) => r.pass) ? 0 : 1);
}
