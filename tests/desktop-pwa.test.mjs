// His website as an app on a phone's Home Screen (the user, 2026-11-18: "make the website so that I can download it
// as a PWA especially on my phone"): what's public, the manifest and its sign-in code, the sign-in page, and the
// worker that says when his server can't be reached.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import vm from 'node:vm';
import { createWebGateway, manifestFor, withShim } from '../desktop/src/main/web-gateway.js';
import { signInAddress } from '../desktop/src/web/sign-in.js';
import { installWords } from '../desktop/src/home/install.js';

const KEY = 'p'.repeat(24);
const NAVIGATE = { 'Sec-Fetch-Mode': 'navigate', Accept: 'text/html' };

function gateway() {
  const g = createWebGateway({ key: KEY, port: 0, onMessage: async () => null, onStorage: async () => null });
  return g;
}

/** A request as a browser makes it: plain http, since fetch() says it's a fetch (Sec-Fetch-Mode: cors) whatever it's told. */
function get(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: pathname, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const bytes = Buffer.concat(chunks);
        const type = String(response.headers['content-type'] || '');
        resolve({ status: response.statusCode, headers: new Headers(Object.entries(response.headers).map(([name, value]) => [name, [value].flat().join(', ')])), body: type.startsWith('image/') ? bytes : bytes.toString('utf8') });
      });
    });
    request.on('error', reject);
  });
}

test('what an app needs before signing in is anyone’s; nothing else is', async (t) => {
  const g = gateway();
  t.after(() => g.close());
  const port = await g.ready;
  const worker = await get(port, '/sw.js');
  assert.equal(worker.status, 200);
  assert.match(worker.headers.get('content-type'), /javascript/);
  for (const icon of ['apple-touch-icon', 'icon-192', 'icon-512', 'maskable-512']) {
    const got = await get(port, `/web/icons/${icon}.png`);
    assert.equal(got.status, 200, icon);
    assert.equal(got.headers.get('content-type'), 'image/png');
    assert.deepEqual([...got.body.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], `${icon} is a PNG`);
  }
  const offline = await get(port, '/web/offline.html');
  assert.equal(offline.status, 200);
  assert.match(offline.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal((await get(port, '/web/sign-in.js')).status, 200);
  // His page, its scripts and the rest of the website's files still need the key.
  for (const kept of ['/web/shim.js', '/web/web.css', '/app/home/home.js', '/web/icons/../shim.js']) assert.equal((await get(port, kept)).status, 401, kept);
});

test('a page opened without the key is asked to sign in; a script is just refused', async (t) => {
  const g = gateway();
  t.after(() => g.close());
  const port = await g.ready;
  for (const pathname of ['/', '/app/home/home.html', '/?key=wrong-wrong-wrong-wrong', '/?install=made-up-code']) {
    const page = await get(port, pathname, NAVIGATE);
    assert.equal(page.status, 401, pathname);
    assert.match(page.body, /Sign in to Jester/, pathname);
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  }
  const script = await get(port, '/app/home/home.js', { 'Sec-Fetch-Mode': 'cors' });
  assert.equal(script.status, 401);
  assert.doesNotMatch(script.body, /Sign in to Jester/);
});

test('his signed-in page links a manifest whose start signs the Home Screen app in, for a day', async (t) => {
  const g = gateway();
  t.after(() => g.close());
  const port = await g.ready;
  const cookie = `jester_key=${KEY}`;
  const page = await get(port, '/app/home/home.html', { Cookie: cookie });
  assert.equal(page.status, 200);
  for (const tag of ['apple-mobile-web-app-capable', 'apple-touch-icon', 'theme-color']) assert.match(page.body, new RegExp(tag), tag);
  const href = /<link rel="manifest" href="([^"]+)"/.exec(page.body)?.[1];
  assert.match(href, /^\/manifest\.webmanifest\?install=[\w-]{20,}$/);
  // Fetched as a browser does, without its cookie: the manifest is anyone's, and says where the app starts.
  const manifest = JSON.parse((await get(port, href)).body);
  const code = new URL(href, 'http://x').searchParams.get('install');
  assert.equal(manifest.start_url, `/?install=${code}`);
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.scope, '/');
  assert.ok(manifest.icons.some((icon) => icon.purpose === 'maskable'));
  // The Home Screen app's first opening, with a cookie jar of its own: the code is kept as the key's cookie.
  const opened = await get(port, manifest.start_url, NAVIGATE);
  assert.equal(opened.status, 303);
  assert.equal(opened.headers.get('location'), '/app/home/home.html');
  assert.match(opened.headers.get('set-cookie'), new RegExp(`^jester_key=${KEY};.*HttpOnly`));
  // A code it doesn't know: no start of its own, and opening with it is a sign-in; signed in already, it's ignored.
  assert.equal(JSON.parse((await get(port, '/manifest.webmanifest?install=nope')).body).start_url, '/');
  assert.equal((await get(port, '/?install=nope', { ...NAVIGATE, Cookie: cookie })).status, 302);
});

test('a sign-in link from Settings is a code, not the key, and works once copied', async (t) => {
  const g = gateway();
  t.after(() => g.close());
  const port = await g.ready;
  const code = g.installToken();
  assert.notEqual(code, KEY);
  assert.doesNotMatch(code, new RegExp(KEY));
  const opened = await get(port, `/?install=${code}`, NAVIGATE);
  assert.equal(opened.status, 303);
  assert.match(opened.headers.get('set-cookie'), /^jester_key=/);
});

test('the manifest and the page’s tags, as made', () => {
  assert.deepEqual(manifestFor().start_url, '/');
  assert.equal(manifestFor('abc').start_url, '/?install=abc');
  assert.equal(manifestFor().background_color, '#08060c');
  const html = withShim('<!doctype html><html><head><title>x</title></head><body></body></html>', { install: 'abc' });
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest\?install=abc" \/>/);
  assert.match(html, /apple-mobile-web-app-status-bar-style" content="black"/);
  assert.match(withShim('<html><head></head></html>'), /href="\/manifest\.webmanifest" \/>/);
});

test('what’s pasted to sign in: his link, a sign-in link, or the key alone', () => {
  assert.equal(signInAddress(` https://jester.tail1.ts.net/?key=${KEY} `), `/?key=${KEY}`);
  assert.equal(signInAddress('https://jester.tail1.ts.net/?install=abc_DEF-123'), '/?install=abc_DEF-123');
  assert.equal(signInAddress(KEY), `/?key=${KEY}`);
  assert.equal(signInAddress('https://example.com/'), '');
  assert.equal(signInAddress('hello there'), '');
});

test('Settings says how to put him on the Home Screen, for the browser it’s in', () => {
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  assert.match(installWords({ agent: iphone })[1], /Share, then Add to Home Screen/);
  assert.match(installWords({ agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', touch: 5 })[1], /Add to Home Screen/, 'an iPad says it’s a Mac');
  assert.match(installWords({ agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15' })[1], /Add to Dock/);
  assert.match(installWords({ agent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/140.0 Mobile Safari/537.36' })[1], /Add to Home screen/);
  assert.equal(installWords({ agent: 'Mozilla/5.0 (Linux; Android 15)', prompt: true })[0], 'Install Jester');
  assert.match(installWords({ agent: iphone, standalone: true })[0], /on your Home Screen/);
});

test('the worker answers a page only when his server can’t be reached, and keeps nothing of his', async () => {
  const handlers = {};
  const stored = [];
  const context = {
    self: { addEventListener: (type, fn) => (handlers[type] = fn), skipWaiting: async () => undefined, clients: { claim: async () => undefined } },
    caches: {
      open: async () => ({ addAll: async (list) => stored.push(...list) }),
      keys: async () => ['jester-offline-0', 'jester-offline-1'],
      delete: async () => true,
      match: async (what) => `cached ${what}`
    },
    fetch: async () => 'from the server'
  };
  vm.runInNewContext(fs.readFileSync(new URL('../desktop/src/web/sw.js', import.meta.url), 'utf8'), context);
  const waits = [];
  handlers.install({ waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  assert.deepEqual(stored, ['/web/offline.html', '/web/icons/apple-touch-icon.png']);
  const respond = async (mode, fetch) => {
    context.fetch = fetch;
    let answer = null;
    handlers.fetch({ request: { mode }, respondWith: (p) => (answer = p) });
    return answer && (await answer);
  };
  assert.equal(await respond('cors', async () => 'x'), null, 'a script or a message is the server’s');
  assert.equal(await respond('navigate', async () => 'from the server'), 'from the server');
  assert.equal(await respond('navigate', async () => Promise.reject(new TypeError('Load failed'))), 'cached /web/offline.html');
});
