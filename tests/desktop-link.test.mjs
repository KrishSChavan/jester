import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { driverPath } from '../desktop/src/main/driver.js';
import { hostManifest, HOST_NAME, startLink } from '../desktop/src/main/link.js';

const ORIGIN = 'chrome-extension://jfogbgfnpimbidpfclgnekbigadopeoe/';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let pipes = 0;

async function socketPath() {
  if (process.platform === 'win32') return `\\\\.\\pipe\\jester-test-${process.pid}-${++pipes}`;
  // Unix socket paths are capped near 104 bytes: the system temp dir is short enough.
  return join(await mkdtemp(join(tmpdir(), 'jl-')), 'link.sock');
}

/** What the relay does: say hello with the origin, then JSON lines. */
function fakeRelay(path, origin) {
  const socket = net.connect(path);
  const lines = [];
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk;
    for (let end; (end = buffer.indexOf('\n')) >= 0; buffer = buffer.slice(end + 1)) lines.push(JSON.parse(buffer.slice(0, end)));
  });
  socket.write(`${JSON.stringify({ type: 'jester/relay-hello', origin })}\n`);
  return { socket, lines, send: (message) => socket.write(`${JSON.stringify(message)}\n`) };
}

async function until(check, ms = 2000) {
  for (const end = Date.now() + ms; Date.now() < end; await pause(10)) if (check()) return;
  assert.fail('timed out');
}

test('the extension Chrome names in the manifest is the only one let in', async () => {
  const path = await socketPath();
  const heard = [];
  const connected = [];
  const link = startLink({ socketPath: path, allowedOrigins: [ORIGIN], onConnect: (origin) => connected.push(origin), onMessage: (message) => heard.push(message) });
  await link.ready;
  try {
    const stranger = fakeRelay(path, 'chrome-extension://someoneelse/');
    await new Promise((resolve) => stranger.socket.on('close', resolve));
    assert.deepEqual(connected, []);
    assert.equal(link.connected, false);

    const relay = fakeRelay(path, ORIGIN);
    await until(() => link.connected);
    relay.send({ type: 'jester/ping', n: 1 });
    await until(() => heard.length === 1);
    assert.deepEqual(heard, [{ type: 'jester/ping', n: 1 }]);
    assert.equal(link.send({ type: 'jester/trigger', action: 'PLAY_PAUSE' }), true);
    await until(() => relay.lines.length === 1);
    assert.deepEqual(relay.lines, [{ type: 'jester/trigger', action: 'PLAY_PAUSE' }]);
    assert.deepEqual(connected, [ORIGIN]);
    relay.socket.destroy();
  } finally {
    link.close();
  }
});

test('a newer connection replaces the old one, and nothing is sent once both are gone', async () => {
  const path = await socketPath();
  let disconnects = 0;
  const link = startLink({ socketPath: path, onDisconnect: () => (disconnects += 1) });
  await link.ready;
  try {
    const first = fakeRelay(path, ORIGIN);
    await until(() => link.connected);
    const closed = new Promise((resolve) => first.socket.on('close', resolve));
    const second = fakeRelay(path, ORIGIN);
    await closed;
    link.send({ type: 'hello' });
    await until(() => second.lines.length === 1);
    assert.equal(first.lines.length, 0);
    second.socket.destroy();
    await until(() => !link.connected);
    assert.equal(disconnects, 1);
    assert.equal(link.send({ type: 'late' }), false);
  } finally {
    link.close();
  }
});

test('the host manifest points Chrome at the relay for named extensions only', () => {
  assert.deepEqual(hostManifest({ relayPath: '/Applications/Jester.app/Contents/Resources/jester-driver', origins: [ORIGIN] }), {
    name: HOST_NAME,
    description: 'Jester Desktop link',
    path: '/Applications/Jester.app/Contents/Resources/jester-driver',
    type: 'stdio',
    allowed_origins: [ORIGIN]
  });
});

let relayBinary = null;
try {
  relayBinary = process.platform === 'win32' ? null : driverPath();
} catch {
  relayBinary = null;
}

test('the relay carries Chrome\'s framed messages to the app and back', { skip: !relayBinary && 'jester-driver is not built (npm run driver in desktop/)' }, async () => {
  const path = await socketPath();
  const heard = [];
  const link = startLink({ socketPath: path, allowedOrigins: [ORIGIN], onMessage: (message) => heard.push(message) });
  await link.ready;
  // Started the way Chrome starts a host: the caller's origin as the argument.
  const relay = spawn(relayBinary, [ORIGIN], { env: { ...process.env, JESTER_LINK_SOCKET: path } });
  const frames = [];
  let pending = Buffer.alloc(0);
  relay.stdout.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32LE(0)) {
      const length = pending.readUInt32LE(0);
      frames.push(JSON.parse(pending.subarray(4, 4 + length).toString('utf8')));
      pending = pending.subarray(4 + length);
    }
  });
  const frame = (message) => {
    const body = Buffer.from(JSON.stringify(message));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    return Buffer.concat([header, body]);
  };
  try {
    await until(() => link.connected);
    relay.stdin.write(frame({ type: 'jester/ping', text: 'héllo ✓' }));
    await until(() => heard.length === 1);
    assert.deepEqual(heard, [{ type: 'jester/ping', text: 'héllo ✓' }]);
    link.send({ type: 'jester/voice-command', text: 'next song' });
    await until(() => frames.length === 1);
    assert.deepEqual(frames, [{ type: 'jester/voice-command', text: 'next song' }]);
  } finally {
    relay.kill();
    link.close();
  }
});

test('with the app closed, the relay tells the extension and exits', { skip: !relayBinary && 'jester-driver is not built (npm run driver in desktop/)' }, async () => {
  const relay = spawn(relayBinary, [ORIGIN], { env: { ...process.env, JESTER_LINK_SOCKET: join(tmpdir(), `jester-nobody-${process.pid}.sock`) } });
  const chunks = [];
  relay.stdout.on('data', (chunk) => chunks.push(chunk));
  const code = await new Promise((resolve) => relay.on('exit', resolve));
  const output = Buffer.concat(chunks);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(output.subarray(4, 4 + output.readUInt32LE(0)).toString('utf8')), { type: 'jester/link-error', detail: "Jester Desktop isn't running." });
});
