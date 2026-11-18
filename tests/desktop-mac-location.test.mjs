import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { buildLocation, clangArgs } from '../desktop/scripts/build-location.mjs';
import { createMacLocate, loadMacLocation } from '../desktop/src/main/mac-location.js';

/**
 * A stand-in for the native module: status() reads `status`, then once asked, each of `afterAsk` in turn; latest()
 * gives each of `answers` in turn, one per poll (a function is given the last request's number).
 */
function fakeNative({ status = 'allowed', afterAsk = [], answers = [] } = {}) {
  const calls = { ask: 0, locate: 0 };
  let now = status;
  const later = [...afterAsk];
  const replies = [...answers];
  let request = 0;
  return {
    calls,
    status: () => {
      if (calls.ask && later.length) now = later.shift();
      return now;
    },
    ask: () => {
      calls.ask += 1;
      return now;
    },
    locate: () => {
      calls.locate += 1;
      return ++request;
    },
    latest: () => {
      const reply = replies.length ? replies.shift() : null;
      return typeof reply === 'function' ? reply(request) : reply;
    }
  };
}

/** A clock that moves only when it's waited on. */
function fakeClock() {
  let t = 0;
  return { now: () => t, wait: async (ms) => void (t += ms) };
}

test('never asked: macOS is asked for "Jester", the answer waited on, then a position read', async () => {
  const native = fakeNative({
    status: 'not-determined',
    afterAsk: ['not-determined', 'not-determined', 'allowed'],
    answers: [null, (request) => ({ request, lat: 40.79, lon: -77.86, accuracy: 35, at: 1 })]
  });
  const got = await createMacLocate({ native, ...fakeClock() })({ timeoutMs: 90000 });
  assert.deepEqual(got, { ok: true, lat: 40.79, lon: -77.86, accuracy: 35 });
  assert.equal(native.calls.ask, 1);
  assert.equal(native.calls.locate, 1);
});

test('already allowed: no question, straight to a position', async () => {
  const native = fakeNative({ answers: [(request) => ({ request, lat: 1, lon: 2, accuracy: 10, at: 1 })] });
  const got = await createMacLocate({ native, ...fakeClock() })({ timeoutMs: 25000 });
  assert.equal(got.ok, true);
  assert.equal(native.calls.ask, 0);
});

test('turned down, restricted, or Location Services off: not allowed, and no position asked for', async () => {
  for (const [status, message] of [['denied', 'Location Services: denied'], ['restricted', 'Location Services: restricted'], ['off', 'Location Services are off']]) {
    const native = fakeNative({ status });
    const got = await createMacLocate({ native, ...fakeClock() })({ timeoutMs: 25000 });
    assert.deepEqual(got, { ok: false, code: 1, message }, status);
    assert.equal(native.calls.ask, 0, status);
    assert.equal(native.calls.locate, 0, status);
  }
});

test('the question left unanswered: a timeout, asked once, no position asked for', async () => {
  const native = fakeNative({ status: 'not-determined' });
  const got = await createMacLocate({ native, ...fakeClock() })({ timeoutMs: 1000 });
  assert.equal(got.ok, false);
  assert.equal(got.code, 3);
  assert.equal(native.calls.ask, 1);
  assert.equal(native.calls.locate, 0);
});

test('turned down while asking: not allowed', async () => {
  const native = fakeNative({ status: 'not-determined', afterAsk: ['denied'] });
  const got = await createMacLocate({ native, ...fakeClock() })({ timeoutMs: 90000 });
  assert.equal(got.code, 1);
  assert.equal(native.calls.locate, 0);
});

test('Core Location\'s errors: denied is not allowed, anything else no position', async () => {
  const denied = fakeNative({ answers: [(request) => ({ request, error: 'denied', code: 1 })] });
  assert.deepEqual(await createMacLocate({ native: denied, ...fakeClock() })({ timeoutMs: 5000 }), { ok: false, code: 1, message: 'denied' });
  const unknown = fakeNative({ answers: [(request) => ({ request, error: 'The operation couldn’t be completed.', code: 0 })] });
  assert.equal((await createMacLocate({ native: unknown, ...fakeClock() })({ timeoutMs: 5000 })).code, 2);
});

test('an answer to an earlier request is not this one\'s; nothing in time is a timeout', async () => {
  const native = fakeNative({ answers: [(request) => ({ request: request - 1, lat: 9, lon: 9, accuracy: 9, at: 1 })] });
  const got = await createMacLocate({ native, ...fakeClock() })({ timeoutMs: 1000 });
  assert.deepEqual(got, { ok: false, code: 3, message: 'no position in time' });
});

test('no module off a Mac, or when it isn\'t built: the page asks instead', () => {
  assert.equal(loadMacLocation({ platform: 'win32' }), null);
  const said = [];
  assert.equal(loadMacLocation({ platform: 'darwin', file: path.join(os.tmpdir(), 'no-such-jester-location.node'), log: (...parts) => said.push(parts.join(' ')) }), null);
  assert.match(said[0], /no Location Services module/);
});

test('it\'s built for both kinds of Mac, taking Node-API from whatever loads it', () => {
  const args = clangArgs('in.m', 'out.node');
  assert.deepEqual(args.slice(0, 2), ['clang', '-bundle']);
  assert.ok(args.includes('-fobjc-arc'));
  assert.deepEqual(args.filter((_, i) => args[i - 1] === '-arch'), ['arm64', 'x86_64']);
  assert.ok(args.includes('-Wl,-undefined,dynamic_lookup'));
  assert.ok(args.includes('CoreLocation'));
  assert.deepEqual(args.slice(-3), ['-o', 'out.node', 'in.m']);
});

const clang = process.platform === 'darwin' && spawnSync('xcrun', ['--find', 'clang']).status === 0;

test('the module builds, is remade only when its source changes, and loads with its four functions', { skip: !clang && 'needs macOS and the Xcode command line tools' }, () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'jester-location-'));
  try {
    const out = path.join(folder, 'build/jester-location.node');
    const said = [];
    const log = (line) => said.push(line);
    assert.equal(buildLocation({ out, log }), out);
    assert.equal(said.length, 1);
    buildLocation({ out, log });
    assert.equal(said.length, 1, 'unchanged source, not rebuilt');
    const native = createRequire(import.meta.url)(out);
    // Only what's there: reading the status would ask locationd about this test's process.
    assert.deepEqual(Object.keys(native).sort(), ['ask', 'latest', 'locate', 'status']);
    for (const name of Object.keys(native)) assert.equal(typeof native[name], 'function');
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
