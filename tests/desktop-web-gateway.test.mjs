import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from '../desktop/node_modules/ws/index.js';
import { ROOTS } from '../desktop/src/main/files.js';
import { createFileSealer } from '../desktop/src/main/file-sealer.js';
import { createRemoteVoicePage, createWebGateway, servedFile, withShim } from '../desktop/src/main/web-gateway.js';

const KEY = 'k'.repeat(24);

function gateway(overrides = {}) {
  const seen = { messages: [], audio: [], status: [], storage: [] };
  const g = createWebGateway({
    key: KEY,
    port: 0,
    onMessage: async (_client, message) => (seen.messages.push(message), { ok: true, echo: message.type }),
    onStorage: async (area, op, arg) => (seen.storage.push([area, op, arg]), { settings: { a: 1 } }),
    onAudio: (samples) => seen.audio.push(samples),
    onVoiceStatus: (report) => seen.status.push(report),
    ...overrides
  });
  return { g, seen };
}

async function get(port, pathname, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers, redirect: 'manual' });
  return { status: response.status, headers: response.headers, text: await response.text() };
}

function connect(port, headers = { Authorization: `Bearer ${KEY}` }) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/socket`, { headers });
  const frames = [];
  const waiters = [];
  ws.on('message', (data, binary) => {
    if (binary) return;
    const frame = JSON.parse(String(data));
    frames.push(frame);
    for (const waiter of waiters.splice(0)) waiter();
  });
  const next = async (match) => {
    for (;;) {
      const found = frames.find(match);
      if (found) {
        frames.splice(frames.indexOf(found), 1);
        return found;
      }
      await new Promise((resolve) => waiters.push(resolve));
    }
  };
  return { ws, next, opened: new Promise((resolve, reject) => (ws.once('open', resolve), ws.once('error', reject))) };
}

test('only his window\'s files are served, however the path is spelled', () => {
  assert.equal(servedFile('/app/home/home.html'), path.join(ROOTS.app, 'home/home.html'));
  assert.equal(servedFile('/app/ext/src/common/constants.js'), path.join(ROOTS.ext, 'src/common/constants.js'));
  assert.equal(servedFile('/app/main/os-actions.js'), path.join(ROOTS.app, 'main/os-actions.js'));
  assert.equal(servedFile('/app/worklets/speech-capture.js'), path.join(ROOTS.app, 'worklets/speech-capture.js'));
  assert.ok(servedFile('/web/shim.js').endsWith(path.join('web', 'shim.js')));
  for (const bad of ['/app/main/main.js', '/app/home/../main/main.js', '/app/home/%2e%2e/main/main.js', '/app/home/..%2Fmain%2Fmain.js', '/app/ext/src/background/model-client.js', '/web/../main/main.js', '/web/%2e%2e/main/main.js', '/etc/passwd', '/app/ext/../../package.json', '/app/home/%00x', '/app/preload/chrome-shim.cjs']) {
    assert.equal(servedFile(bad), null, bad);
  }
});

test('pages get the shim before their own scripts', () => {
  const html = withShim('<!doctype html><html><head><title>x</title></head><body><script type="module" src="home.js"></script></body></html>');
  assert.ok(html.indexOf('/web/shim.js') < html.indexOf('home.js'));
  assert.ok(html.indexOf('/web/shim.js') > html.indexOf('<head>'));
});

test('nothing without the key: the key once in the address becomes a cookie', async (t) => {
  const { g } = gateway();
  t.after(() => g.close());
  const port = await g.ready;
  assert.equal((await get(port, '/app/home/home.html')).status, 401);
  assert.equal((await get(port, '/?key=wrong-wrong-wrong-wrong')).status, 401);
  const opened = await get(port, `/?key=${KEY}`);
  assert.equal(opened.status, 303);
  assert.equal(opened.headers.get('location'), '/app/home/home.html');
  const cookie = opened.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const page = await get(port, '/app/home/home.html', { Cookie: cookie.split(';')[0] });
  assert.equal(page.status, 200);
  assert.match(page.text, /\/web\/shim\.js/);
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.equal((await get(port, '/app/main/main.js', { Cookie: cookie.split(';')[0] })).status, 404);
});

test('a socket without the key, or from another site, is refused', async (t) => {
  const { g } = gateway();
  t.after(() => g.close());
  const port = await g.ready;
  await assert.rejects(connect(port, {}).opened);
  await assert.rejects(connect(port, { Authorization: `Bearer ${KEY}`, Origin: 'https://evil.example' }).opened);
  await connect(port, { Cookie: `jester_key=${KEY}`, Origin: `http://127.0.0.1:${port}` }).opened;
});

test('messages and storage are answered; posts and storage changes reach the page', async (t) => {
  const { g, seen } = gateway();
  t.after(() => g.close());
  const port = await g.ready;
  const page = connect(port);
  await page.opened;
  page.ws.send(JSON.stringify({ t: 'hello', role: 'page' }));
  page.ws.send(JSON.stringify({ t: 'msg', id: 1, message: { type: 'jester/talk-type', text: 'hi' } }));
  assert.deepEqual((await page.next((f) => f.t === 'reply' && f.id === 1)).reply, { ok: true, echo: 'jester/talk-type' });
  page.ws.send(JSON.stringify({ t: 'storage', id: 2, area: 'local', op: 'get', arg: 'settings' }));
  assert.deepEqual((await page.next((f) => f.id === 2)).reply, { settings: { a: 1 } });
  assert.deepEqual(seen.storage, [['local', 'get', 'settings']]);
  const [client] = g.clients;
  client.message({ type: 'jester/chat' }, { url: 'x' });
  assert.equal((await page.next((f) => f.t === 'msg')).message.type, 'jester/chat');
  client.storageChanged({ settings: { newValue: 1 } }, 'local');
  assert.equal((await page.next((f) => f.t === 'storage-changed')).area, 'local');
});

test('the mic is the browser last clicked in, and only while he listens', async (t) => {
  const { g, seen } = gateway();
  t.after(() => g.close());
  const port = await g.ready;
  const phone = connect(port);
  const laptop = connect(port);
  await Promise.all([phone.opened, laptop.opened]);
  const samples = new Float32Array([0.1, -0.2, 0.3]);
  phone.ws.send(JSON.stringify({ t: 'voice-claim' }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  // Not listening yet: nothing goes in.
  phone.ws.send(samples);
  await new Promise((resolve) => setTimeout(resolve, 50));
  g.openVoice();
  assert.equal((await phone.next((f) => f.t === 'voice')).op, 'open');
  phone.ws.send(samples);
  laptop.ws.send(samples);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(seen.audio.length, 1, 'only the claimed, listening browser\'s audio');
  assert.deepEqual([...seen.audio[0]].map((v) => Math.round(v * 10) / 10), [0.1, -0.2, 0.3]);
  // The laptop's clicked in: the phone's mic closes and the laptop's opens.
  laptop.ws.send(JSON.stringify({ t: 'voice-claim' }));
  assert.equal((await phone.next((f) => f.t === 'voice')).op, 'close');
  assert.equal((await laptop.next((f) => f.t === 'voice')).op, 'open');
});

test('his voice plays on the browser being talked to, and is over when it says so', async (t) => {
  let voice;
  const { g } = gateway({ onVoiceStatus: (report) => voice.status(report) });
  voice = createRemoteVoicePage(g);
  t.after(() => g.close());
  const port = await g.ready;
  await assert.rejects(voice.play(Buffer.from('RIFF'), 'audio/wav'), /Nobody/);
  const page = connect(port);
  await page.opened;
  page.ws.send(JSON.stringify({ t: 'voice-claim' }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const playing = voice.play(Buffer.from('RIFF'), 'audio/wav');
  const sound = await page.next((f) => f.t === 'play');
  assert.equal(Buffer.from(sound.bytes, 'base64').toString(), 'RIFF');
  page.ws.send(JSON.stringify({ t: 'voice-status', report: { ended: sound.id } }));
  await playing;
});

test('keys sealed on a server open again only with its own key file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jester-sealer-'));
  try {
    const file = path.join(dir, 'sealing.key');
    const sealer = createFileSealer(file);
    const sealed = sealer.seal('{"key":"sk-secret"}');
    assert.ok(!sealed.includes('sk-secret'));
    assert.equal(createFileSealer(file).unseal(sealed), '{"key":"sk-secret"}');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const other = createFileSealer(path.join(dir, 'other.key'));
    assert.throws(() => other.unseal(sealed));
    const parts = sealed.split('.');
    parts[3] = (parts[3][0] === 'A' ? 'B' : 'A') + parts[3].slice(1);
    assert.throws(() => sealer.unseal(parts.join('.')), 'changed on disk: refused');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a pasted sign-in address goes only to the port that sign-in opened, with its own state', async () => {
  const { landingAddress } = await import('../desktop/src/main/web-gateway.js');
  const page = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=http%3A%2F%2F127.0.0.1%3A51234&state=s123&code_challenge=c';
  assert.equal(landingAddress('http://127.0.0.1:51234/?state=s123&code=4%2Fabc&scope=x', page), 'http://127.0.0.1:51234/?state=s123&code=4%2Fabc&scope=x');
  assert.equal(landingAddress('  http://127.0.0.1:51234/?state=s123&error=access_denied  ', page), 'http://127.0.0.1:51234/?state=s123&error=access_denied');
  // Only the answer's own parameters are taken along.
  assert.equal(landingAddress('http://127.0.0.1:51234/?state=s123&code=c&evil=1', page), 'http://127.0.0.1:51234/?state=s123&code=c');
  for (const bad of [
    'http://127.0.0.1:11434/?state=s123&code=c', // another port: Ollama, say
    'http://127.0.0.1:51234/api/tags?state=s123&code=c', // another path
    'http://127.0.0.1:51234/?state=other&code=c', // another sign-in's
    'http://localhost:51234/?state=s123&code=c',
    'http://10.0.0.5:51234/?state=s123&code=c',
    'https://127.0.0.1:51234/?state=s123&code=c',
    'not a url',
    ''
  ]) {
    assert.equal(landingAddress(bad, page), null, bad);
  }
  assert.equal(landingAddress('http://127.0.0.1:51234/?state=s123&code=c', null), null, 'no sign-in going on');
});

test('behind tailscale serve, the browser\'s own host may come forwarded', async (t) => {
  const { g } = gateway();
  t.after(() => g.close());
  const port = await g.ready;
  await connect(port, { Cookie: `jester_key=${KEY}`, Origin: 'https://jester.tail1234.ts.net', 'X-Forwarded-Host': 'jester.tail1234.ts.net' }).opened;
  await assert.rejects(connect(port, { Cookie: `jester_key=${KEY}`, Origin: 'https://evil.example', 'X-Forwarded-Host': 'jester.tail1234.ts.net' }).opened);
});
