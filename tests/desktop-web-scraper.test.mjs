import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createWebScraper, scrapingPython } from '../desktop/src/main/web-scraper.js';

function workers() {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false,
      kill() { this.killed = true; }, answer(result) { this.stdout.write(JSON.stringify(result)); this.emit('close', 0); } });
    calls.push({ command, args, options, child });
    return child;
  };
  return { calls, spawn };
}

test('uses the isolated venv unless an explicit Python executable was configured', () => {
  assert.equal(scrapingPython({ root: '/app', env: {}, platform: 'darwin' }), '/app/.scrapling/bin/python');
  assert.equal(scrapingPython({ env: { JESTER_SCRAPLING_PYTHON: '/custom/python' } }), '/custom/python');
  assert.match(scrapingPython({ root: '/app', env: {}, platform: 'win32' }), /Scripts[/\\]python\.exe$/);
});

test('passes only structured web arguments over stdin and reads the worker result', async () => {
  const fake = workers();
  const scraper = createWebScraper({ spawn: fake.spawn, python: '/python', worker: '/worker.py' });
  const pending = scraper.request({ op: 'scrape', url: 'https://example.com/', exec: 'anything' });
  const call = fake.calls[0];
  assert.equal(call.command, '/python');
  assert.deepEqual(call.args, ['-u', '/worker.py']);
  assert.equal(call.options.shell, false);
  assert.deepEqual(JSON.parse(call.child.stdin.read().toString()), { op: 'scrape', url: 'https://example.com/', mode: 'auto' });
  call.child.answer({ ok: true, text: 'fresh data', fetchedAt: '2026-11-16T20:00:00Z' });
  assert.equal((await pending).text, 'fresh data');
  scraper.close();
});

test('missing Python yields setup instructions; malformed worker output is contained', async () => {
  const fake = workers();
  const scraper = createWebScraper({ spawn: fake.spawn });
  const missing = scraper.request({ op: 'search', query: 'news' });
  fake.calls[0].child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' }));
  assert.equal((await missing).code, 'setup_required');
  const malformed = scraper.request({ op: 'search', query: 'news' });
  fake.calls[1].child.stdout.write('library log\n{bad');
  fake.calls[1].child.emit('close', 1);
  assert.equal((await malformed).code, 'worker_failed');
  scraper.close();
});

test('abort and close stop workers, release concurrency slots, and reject future work', async () => {
  const fake = workers();
  const scraper = createWebScraper({ spawn: fake.spawn });
  const controller = new AbortController();
  const first = scraper.request({ op: 'search', query: 'one' }, { signal: controller.signal });
  const second = scraper.request({ op: 'search', query: 'two' });
  assert.equal((await scraper.request({ op: 'search', query: 'three' })).code, 'busy');
  controller.abort();
  assert.equal((await first).code, 'aborted');
  assert.equal(fake.calls[0].child.killed, true);
  const third = scraper.request({ op: 'search', query: 'three' });
  scraper.close();
  assert.equal((await second).code, 'aborted');
  assert.equal((await third).code, 'aborted');
  assert.equal(fake.calls[2].child.killed, true);
  assert.equal((await scraper.request({ op: 'search', query: 'four' })).code, 'aborted');
});

test('enforces worker output and wall time limits', async () => {
  const fake = workers();
  const scraper = createWebScraper({ spawn: fake.spawn, timeoutMs: 15, maxOutput: 20 });
  const large = scraper.request({ op: 'search', query: 'x' });
  fake.calls[0].child.stdout.write('x'.repeat(21));
  assert.equal((await large).code, 'too_large');
  assert.equal(fake.calls[0].child.killed, true);
  const slow = scraper.request({ op: 'search', query: 'x' });
  assert.equal((await slow).code, 'timeout');
  assert.equal(fake.calls[1].child.killed, true);
  scraper.close();
});

test('invalid requests and already-aborted work never launch a process', async () => {
  const fake = workers();
  const scraper = createWebScraper({ spawn: fake.spawn });
  assert.equal((await scraper.request({ op: 'run' })).code, 'invalid_request');
  assert.equal((await scraper.request({ op: 'search', query: 'x'.repeat(12001) })).code, 'invalid_request');
  const controller = new AbortController(); controller.abort();
  assert.equal((await scraper.request({ op: 'search', query: 'x' }, { signal: controller.signal })).code, 'aborted');
  assert.equal(fake.calls.length, 0);
  scraper.close();
});

test('Python worker rejects private addresses and unsafe redirect hops before a connection', (t) => {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const file = fileURLToPath(new URL('../desktop/scraping/test_worker.py', import.meta.url));
  const result = spawnSync(python, ['-B', file], { encoding: 'utf8', timeout: 15000 });
  if (result.error?.code === 'ENOENT') return t.skip('Python is optional for extension-only development.');
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
