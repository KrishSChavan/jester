import test from 'node:test';
import assert from 'node:assert/strict';
import { costOf, createSpend, dollars, PRICES, SPEND_KEY, tokensOf } from '../desktop/src/main/spend.js';

function memoryStorage(initial = {}) {
  let data = structuredClone(initial);
  return {
    get: async (key) => ({ [key]: structuredClone(data[key]) }),
    set: async (values) => void Object.assign(data, structuredClone(values)),
    get data() {
      return data;
    }
  };
}

const haiku = { provider: 'anthropic', model: 'claude-haiku-5-5' };

test('a reply costs its tokens at its model’s price: cached ones a fraction, a cache write a quarter more', () => {
  // Claude counts what it read from the cache and what it wrote to it apart from the rest of the input.
  const usage = { input_tokens: 100, cache_creation_input_tokens: 2000, cache_read_input_tokens: 0, output_tokens: 50 };
  assert.deepEqual(tokensOf(usage), { input: 100, output: 50, cacheRead: 0, cacheWrite: 2000 });
  const [input, output, cacheRead] = PRICES.anthropic['claude-haiku-5-5'];
  assert.equal(costOf({ ...haiku, usage }), (100 * input + 2000 * input * 1.25 + 50 * output) / 1e6);
  const warm = { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 2000, output_tokens: 50 };
  assert.equal(costOf({ ...haiku, usage: warm }), (100 * input + 2000 * cacheRead + 50 * output) / 1e6);
  assert.ok(costOf({ ...haiku, usage: warm }) < costOf({ ...haiku, usage }), 'a cache read is cheaper than a write');
  // A stronger model, a million tokens each way: its listed price.
  assert.equal(costOf({ provider: 'anthropic', model: 'claude-sonnet-5-5', usage: { input_tokens: 1e6, output_tokens: 1e6 } }), 12);
  // No price known: no dollars, rather than a guess.
  assert.equal(costOf({ provider: 'groq', model: 'openai/gpt-oss-120b', usage: { prompt_tokens: 900, completion_tokens: 40 } }), null);
  assert.equal(costOf({ provider: 'anthropic', model: 'claude-some-new-one', usage }), null);
  assert.deepEqual(tokensOf(null), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(tokensOf({ promptTokenCount: 12, candidatesTokenCount: 3 }), { input: 12, output: 3, cacheRead: 0, cacheWrite: 0 });
});

test('what’s spent is kept by month and model, and read back after a restart', async () => {
  const storage = memoryStorage();
  let time = new Date('2026-11-14T12:00:00').getTime();
  const spend = createSpend({ storage, now: () => time, saveMs: -1 });
  assert.equal(await spend.of(haiku), null, 'nothing yet');
  const usage = { input_tokens: 1000, cache_read_input_tokens: 1000, output_tokens: 100 };
  await spend.record({ ...haiku, usage });
  await spend.record({ ...haiku, usage });
  await spend.record({ provider: 'groq', model: 'openai/gpt-oss-120b', usage: { prompt_tokens: 900, completion_tokens: 40 } });
  const told = await spend.of(haiku);
  assert.equal(told.requests, 2);
  assert.equal(told.usd, 2 * costOf({ ...haiku, usage }));
  assert.deepEqual([told.input, told.cached, told.output], [2000, 2000, 200]);
  // A free model: replies and tokens, no dollars.
  assert.deepEqual(await spend.of({ provider: 'groq', model: 'openai/gpt-oss-120b' }), { usd: null, requests: 1, input: 900, output: 40, cached: 0 });
  // Nothing written until asked to, with saving off; then it's there for the next run.
  assert.equal(storage.data[SPEND_KEY], undefined);
  const timed = createSpend({ storage, now: () => time, saveMs: 0 });
  await timed.record({ ...haiku, usage });
  await timed.flush();
  assert.equal(storage.data[SPEND_KEY]['2026-11']['anthropic claude-haiku-5-5'].requests, 1);
  const again = createSpend({ storage, now: () => time, saveMs: -1 });
  assert.equal((await again.of(haiku)).requests, 1);
  // A new month starts at nothing.
  time = new Date('2026-12-01T00:00:01').getTime();
  assert.equal(await again.of(haiku), null);
  // Nothing in it but names and counts.
  assert.deepEqual(Object.keys(storage.data[SPEND_KEY]['2026-11']['anthropic claude-haiku-5-5']).sort(), ['cached', 'input', 'output', 'priced', 'requests', 'usd']);
});

test('only this month and the last are kept, and storage that fails doesn’t stop the count', async () => {
  const storage = memoryStorage({ [SPEND_KEY]: { '2026-08': { x: { requests: 1 } }, '2026-09': { x: { requests: 1 } }, '2026-10': { x: { requests: 1 } } } });
  const spend = createSpend({ storage, now: () => new Date('2026-11-14T12:00:00').getTime(), saveMs: 0 });
  await spend.record({ ...haiku, usage: { input_tokens: 10, output_tokens: 1 } });
  await spend.flush();
  assert.deepEqual(Object.keys(storage.data[SPEND_KEY]).sort(), ['2026-10', '2026-11']);
  const logged = [];
  const broken = createSpend({ storage: { get: async () => { throw new Error('locked'); }, set: async () => { throw new Error('locked'); } }, log: (...parts) => logged.push(parts.join(' ')), saveMs: 0 });
  await broken.record({ ...haiku, usage: { input_tokens: 10, output_tokens: 1 } });
  await broken.flush();
  assert.equal((await broken.of(haiku)).requests, 1);
  assert.match(logged.join('\n'), /couldn’t read what was kept: locked/);
  assert.match(logged.join('\n'), /couldn’t keep it: locked/);
});

test('a figure for small print', () => {
  assert.equal(dollars(0), '$0.00');
  assert.equal(dollars(0.004), 'under 1¢');
  assert.equal(dollars(0.046), '$0.05');
  assert.equal(dollars(12.3), '$12.30');
});
