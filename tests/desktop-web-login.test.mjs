// Signing in to his website with a password (the user, 2026-11-19: a "public address with a login", "start with
// password"): only its hash is kept, guessing is made slow, and only a signed-in device can set or change it.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createWebLogin, passwordProblem } from '../desktop/src/main/web-login.js';
import { createWebGateway } from '../desktop/src/main/web-gateway.js';

function login() {
  const kept = {};
  let time = 1_800_000_000_000;
  const made = createWebLogin({ storage: { get: async (key) => ({ [key]: kept[key] }), set: async (items) => Object.assign(kept, structuredClone(items)), remove: async (key) => delete kept[key] }, now: () => time });
  return { login: made, kept, later: (ms) => (time += ms) };
}

test('a password has to be worth guessing at', () => {
  assert.match(passwordProblem('short'), /at least 10/);
  assert.match(passwordProblem('1234567890123'), /too easy/);
  assert.match(passwordProblem('aaaaaaaaaaaa'), /too easy/);
  assert.match(passwordProblem('Password123'), /too easy/);
  assert.equal(passwordProblem('correct horse battery'), '');
});

test('only its hash is kept; the right one signs in, and changing it needs the current one', async () => {
  const { login: l, kept } = login();
  await l.start();
  assert.deepEqual(l.state(), { set: false, at: 0 });
  assert.match((await l.check('anything at all', 'a')).error, /No password is set/);
  assert.equal((await l.set('short')).ok, false);
  assert.equal((await l.set('correct horse battery')).ok, true);
  assert.doesNotMatch(JSON.stringify(kept), /correct horse/);
  assert.ok(kept.webLogin.salt && kept.webLogin.hash);
  assert.equal((await l.check('correct horse battery', 'a')).ok, true);
  assert.equal((await l.check('correct horse batterx', 'a')).ok, false);
  assert.equal((await l.set('another good one here', { current: 'wrong' })).error, 'The current password isn’t right.');
  assert.equal((await l.set('another good one here', { current: 'correct horse battery' })).ok, true);
  assert.equal((await l.check('correct horse battery', 'b')).ok, false);
  assert.equal((await l.check('another good one here', 'b')).ok, true);
  // It outlasts a restart; and removed (with the current one), there's none.
  const again = createWebLogin({ storage: { get: async (key) => ({ [key]: kept[key] }) } });
  await again.start();
  assert.equal((await again.check('another good one here', 'c')).ok, true);
  assert.equal((await l.remove({ current: 'another good one here' })).ok, true);
  assert.equal(l.state().set, false);
});

test('wrong tries lock an address out, longer each time; a flood closes password sign-in for a while', async () => {
  const { login: l, later } = login();
  await l.set('correct horse battery');
  for (let i = 0; i < 4; i++) assert.equal((await l.check('nope', 'one')).wait, 0);
  const fifth = await l.check('nope', 'one');
  assert.equal(fifth.wait, 60_000);
  assert.match(fifth.error, /Try again in 1 minute/);
  // Locked, even the right one waits; another address isn't.
  assert.equal((await l.check('correct horse battery', 'one')).ok, false);
  assert.equal((await l.check('correct horse battery', 'two')).ok, true);
  later(61_000);
  assert.equal((await l.check('nope', 'one')).wait, 120_000, 'twice as long the next time');
  later(121_000);
  assert.equal((await l.check('correct horse battery', 'one')).ok, true);
  assert.equal((await l.check('nope', 'one')).wait, 0, 'right, its count starts again');
  // From everywhere at once: thirty in a quarter hour.
  for (let i = 0; i < 30; i++) await l.check('nope', `flood-${i}`);
  assert.ok(l.waitFor('someone-new') > 14 * 60_000);
  later(16 * 60_000);
  assert.equal((await l.check('correct horse battery', 'someone-new')).ok, true);
});

const KEY = 'w'.repeat(24);
function ask(port, method, pathname, { body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (response) => {
      let text = '';
      response.on('data', (chunk) => (text += chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text }));
    });
    request.on('error', reject);
    request.end(body ? JSON.stringify(body) : undefined);
  });
}

test('his sign-in page posts the password; right, the browser is signed in; wrong, told why; from another site, refused', async (t) => {
  const { login: l } = login();
  await l.set('correct horse battery');
  const gateway = createWebGateway({ key: KEY, port: 0, login: l, onMessage: async () => null, onStorage: async () => null });
  t.after(() => gateway.close());
  const port = await gateway.ready;
  assert.deepEqual(JSON.parse((await ask(port, 'GET', '/sign-in.json')).text), { password: true });
  const wrong = await ask(port, 'POST', '/sign-in', { body: { password: 'nope' } });
  assert.equal(wrong.status, 401);
  assert.equal(JSON.parse(wrong.text).error, 'That’s not the password.');
  assert.equal(wrong.headers['set-cookie'], undefined);
  const elsewhere = await ask(port, 'POST', '/sign-in', { body: { password: 'correct horse battery' }, headers: { Origin: 'https://evil.example' } });
  assert.equal(elsewhere.status, 403);
  const right = await ask(port, 'POST', '/sign-in', { body: { password: 'correct horse battery' }, headers: { Origin: `http://127.0.0.1:${port}`, Host: `127.0.0.1:${port}` } });
  assert.equal(right.status, 200);
  const cookie = right.headers['set-cookie'][0];
  assert.match(cookie, /^jester_key=.*HttpOnly; Secure; SameSite=Strict$/);
  assert.equal((await ask(port, 'GET', '/app/home/home.html', { headers: { Cookie: cookie.split(';')[0] } })).status, 200);
  // Too long to be one, or not one at all.
  assert.equal((await ask(port, 'POST', '/sign-in', { body: { password: 'x'.repeat(4000) } })).status, 413);
  assert.equal((await ask(port, 'POST', '/app/home/home.html', { body: {} })).status, 405);
  // Five wrong from one address: told to wait.
  for (let i = 0; i < 4; i++) await ask(port, 'POST', '/sign-in', { body: { password: 'nope' }, headers: { 'X-Forwarded-For': '203.0.113.9' } });
  const locked = await ask(port, 'POST', '/sign-in', { body: { password: 'nope' }, headers: { 'X-Forwarded-For': '203.0.113.9' } });
  assert.equal(locked.status, 429);
  assert.equal(locked.headers['retry-after'], '60');
  // An address the sender wrote in front of the proxy's own doesn't make it someone else.
  const dodging = await ask(port, 'POST', '/sign-in', { body: { password: 'nope' }, headers: { 'X-Forwarded-For': '198.51.100.1, 203.0.113.9' } });
  assert.equal(dodging.status, 429);
});

test('signed out, a browser’s cookie is taken back; search engines are asked to stay out', async (t) => {
  const gateway = createWebGateway({ key: KEY, port: 0, onMessage: async () => null, onStorage: async () => null });
  t.after(() => gateway.close());
  const port = await gateway.ready;
  const out = await ask(port, 'GET', '/sign-out', { headers: { Cookie: `jester_key=${KEY}` } });
  assert.equal(out.status, 303);
  assert.match(out.headers['set-cookie'][0], /^jester_key=; .*Max-Age=0/);
  assert.match((await ask(port, 'GET', '/robots.txt')).text, /Disallow: \//);
  assert.deepEqual(JSON.parse((await ask(port, 'GET', '/sign-in.json')).text), { password: false });
  assert.equal((await ask(port, 'POST', '/sign-in', { body: { password: 'x' } })).status, 404, 'no password sign-in without one configured');
  assert.match((await ask(port, 'GET', '/app/home/home.html', { headers: { Cookie: `jester_key=${KEY}` } })).headers['x-robots-tag'], /noindex/);
});

test('a Mac signs in with the password, no link: turned away with an old key, it takes the new one and connects', async (t) => {
  const { cloudKeyFor, createCloudLink, parseCloudLink, serverOrigin } = await import('../desktop/src/main/cloud-link.js');
  assert.equal(serverOrigin('jester.tail1234.ts.net'), 'https://jester.tail1234.ts.net');
  assert.equal(serverOrigin(' https://jester.tail1234.ts.net/app/home '), 'https://jester.tail1234.ts.net');
  assert.throws(() => serverOrigin('http://jester.tail1234.ts.net'), /starts with https/);
  assert.throws(() => serverOrigin(''), /Type his server’s address/);

  const { login: l } = login();
  await l.set('correct horse battery');
  const joined = [];
  const gateway = createWebGateway({ key: KEY, port: 0, login: l, onMessage: async () => null, onStorage: async () => null, onConnect: (client) => joined.push(client.role) });
  t.after(() => gateway.close());
  const port = await gateway.ready;
  const origin = `http://127.0.0.1:${port}`;
  await assert.rejects(cloudKeyFor(origin, 'not it'), /That’s not the password/);
  await assert.rejects(cloudKeyFor(origin, ''), /Type the password/);
  await assert.rejects(cloudKeyFor('http://127.0.0.1:9', 'x'), /couldn’t be reached/);
  const key = await cloudKeyFor(origin, 'correct horse battery');
  assert.equal(key, KEY);

  // Linked with a key the server no longer takes: told so once, and mended by the new key, with no restart.
  let refusals = 0;
  const states = [];
  const link = createCloudLink({
    link: parseCloudLink(`${origin}/?key=${'old'.repeat(8)}`),
    device: { id: 'mac-device-00001', name: 'Test Mac' },
    onVoice: () => undefined, onPlay: () => undefined, onHands: async () => null,
    handsState: () => ({ running: false, asking: false, abilities: {} }), idleSeconds: () => 0,
    onRefused: () => (refusals += 1),
    onChange: (connected) => states.push(connected)
  });
  t.after(() => link.close());
  const until = async (check) => { const end = Date.now() + 5000; while (!check()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); } };
  await until(() => refusals === 1);
  assert.equal(link.refused, true);
  assert.equal(link.connected, false);
  link.use(parseCloudLink(`${origin}/?key=${key}`));
  await until(() => link.connected);
  assert.equal(link.refused, false);
  assert.deepEqual(joined, ['mac']);
  assert.equal(refusals, 1);
});
