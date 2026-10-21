import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRateLimits } from '../jester-extension/src/background/model-client.js';
import { createRateGovernor, estimateTokens, FREE_TIER_LIMITS } from '../jester-extension/src/background/rate-governor.js';
import { createPooledModelClient, AllModelsRateLimitedError } from '../jester-extension/src/background/model-pool.js';
import { normalizeModelConfig, RateLimitError } from '../jester-extension/src/background/model-client.js';
import { runAssistant } from '../jester-extension/src/background/assistant.js';

const headers = (values) => new Headers(values);
const memory = () => { const data = {}; return { data, get: async (key) => ({ [key]: data[key] }), set: async (values) => Object.assign(data, values) }; };
const connection = (id, provider = 'groq', plan) => ({ id, ...normalizeModelConfig({ provider, model: `model-${id}`, key: `key-${id}` }),
  ...(plan ? { plan } : {}), cooldownUntil: 0 });

test('providers\' own limit reports are read from headers and Gemini quota errors', () => {
  const now = 1_000_000;
  const groq = readRateLimits(headers({ 'x-ratelimit-limit-tokens': '8000', 'x-ratelimit-remaining-tokens': '1200',
    'x-ratelimit-reset-tokens': '7.5s', 'x-ratelimit-remaining-requests': '998', 'x-ratelimit-reset-requests': '2m59.5s' }), '', now);
  assert.deepEqual(groq.tokens, { remaining: 1200, limit: 8000, resetAt: now + 7500 });
  assert.deepEqual(groq.requests, { remaining: 998, resetAt: now + 179500 });
  const anthropic = readRateLimits(headers({ 'anthropic-ratelimit-input-tokens-remaining': '0',
    'anthropic-ratelimit-input-tokens-reset': new Date(now + 20000).toISOString() }), '', now);
  assert.deepEqual(anthropic.tokens, { remaining: 0, resetAt: now + 20000 });
  const gemini = readRateLimits(headers({}), JSON.stringify({ error: { code: 429, details: [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [
      { quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', quotaValue: '15' },
      { quotaId: 'GenerateContentInputTokensPerModelPerMinute-FreeTier', quotaValue: '250000' },
      { quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaValue: '500' }] },
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '34s' }] } }));
  assert.deepEqual(gemini.quotas, [{ window: 'minute', unit: 'requests', limit: 15 },
    { window: 'minute', unit: 'tokens', limit: 250000 }, { window: 'day', unit: 'requests', limit: 500 }]);
  assert.deepEqual(readRateLimits(headers({}), 'not json'), {}, 'Nothing reported means nothing assumed');
});

test('free-tier windows pace by requests and tokens; a paid plan waits only on what its provider reports', async () => {
  let now = 5_000_000;
  const governor = createRateGovernor({ storage: () => memory(), now: () => now });
  const gemini = connection('g', 'google');
  for (let i = 0; i < FREE_TIER_LIMITS.google.rpm; i++) { await governor.record(gemini, { inputTokens: 1000 }); now += 1000; }
  assert.equal(await governor.waitMs(gemini, 1000), 60000 - 15000, 'The 16th request waits for the first to leave the minute');
  now += 45000;
  assert.equal(await governor.waitMs(gemini, 1000), 0);

  const groq = connection('q');
  await governor.record(groq, { inputTokens: 5000 });
  now += 10000;
  assert.equal(await governor.waitMs(groq, 2000), 50000, '6,000 free-tier tokens a minute: this request waits for the first to age out');
  assert.equal(await governor.waitMs(groq, 900), 0);

  const paid = connection('p', 'google', 'paid');
  for (let i = 0; i < 40; i++) await governor.record(paid, { inputTokens: 1000 });
  assert.equal(await governor.waitMs(paid, 1000), 0, 'No assumed ceiling on a paid plan');
  assert.equal(await governor.tokensPerMinute(paid), null);
});

test('a reported bucket refills toward its limit, and learned Gemini quotas replace the defaults', async () => {
  let now = 9_000_000;
  const governor = createRateGovernor({ storage: () => memory(), now: () => now });
  const groq = connection('q');
  await governor.record(groq, { inputTokens: 1500, rateLimits: { tokens: { remaining: 500, limit: 8000, resetAt: now + 60000 } } });
  // Needs 2,000 of the 7,500 tokens still to refill over 60 s: 1,500/7,500 of the span.
  assert.equal(await governor.waitMs(groq, 2000), 12000);
  assert.equal(await governor.tokensPerMinute(groq), 8000, 'The reported ceiling replaces the 6,000 default');

  const gemini = connection('g', 'google');
  await governor.record(gemini, { inputTokens: 0, rateLimits: { quotas: [{ window: 'minute', unit: 'requests', limit: 2 }] } });
  await governor.record(gemini, { inputTokens: 100 });
  assert.ok(await governor.waitMs(gemini, 100) > 0, 'The quota Gemini named is the one paced to');
});

test('the pool waits briefly for a window, prefers a connection with room, and pauses past the limit', async () => {
  let now = 1_000_000;
  const store = memory();
  const governor = createRateGovernor({ storage: () => store, now: () => now });
  const entries = [connection('a'), connection('b')];
  const waits = [], used = [];
  const client = createPooledModelClient({ load: async () => structuredClone(entries), now: () => now, governor,
    markLimited: async () => {}, delay: async (ms) => { waits.push(ms); now += ms; },
    onPacing: async (cooldown) => waits.push(`pacing ${cooldown.model}`),
    request: async ({ config }) => { used.push(config.model); return { json: { action: { action: 'finish', success: true, say: 'Done.' } },
      usage: { prompt_tokens: 5000 } }; } });
  const options = { system: 'x'.repeat(3500), prompt: 'y'.repeat(3500) };
  assert.equal(estimateTokens(options), 2000);
  await client(options);
  await client(options);
  assert.deepEqual(used, ['model-a', 'model-b'], 'A full window on the first model moves the request to the second');
  assert.deepEqual(waits, []);
  now += 50000;
  await client(options);
  assert.deepEqual(waits, ['pacing model-a', 10000], 'Ten seconds for model-a\'s window beats a rate-limit error');
  assert.equal(used.at(-1), 'model-a');

  const late = createPooledModelClient({ load: async () => [connection('c')], now: () => now, governor, maxPaceMs: 20000,
    delay: async () => assert.fail('A long wait is never slept through'), markLimited: async () => {},
    request: async () => ({ json: {}, usage: { prompt_tokens: 5800 } }) });
  await late(options);
  await assert.rejects(late(options), (error) => error instanceof AllModelsRateLimitedError && error.retryAfterMs > 20000);
  assert.equal(await late.promptBudget(), 1500, 'A quarter of the 6,000-token free-tier minute per request');
});

test('a Gemini 429 teaches the pool its real quota for the next request', async () => {
  let now = 2_000_000;
  const governor = createRateGovernor({ storage: () => memory(), now: () => now });
  const entries = [connection('g', 'google')];
  const quota = { quotas: [{ window: 'minute', unit: 'requests', limit: 1 }] };
  const client = createPooledModelClient({ load: async () => structuredClone(entries), now: () => now, governor,
    markLimited: async (id, until) => { entries[0].cooldownUntil = until; }, delay: async () => {},
    request: async () => { throw Object.assign(new RateLimitError({ provider: 'google', retryAfterMs: 1000 }), { rateLimits: quota }); } });
  await assert.rejects(client({ system: 's', prompt: 'p' }));
  now += 2000;
  entries[0].cooldownUntil = 0;
  assert.ok(await governor.waitMs(entries[0], 10) > 50000, 'One request a minute, as Gemini said');
});

test('a tight token ceiling sends a smaller page, never below the floor', async () => {
  const prompts = [];
  const text = Array.from({ length: 300 }, (_, i) => `[e${i}] button "Episode ${i} of a long season list"`).join('\n');
  const page = { ok: true, pageId: 'p', revision: 1, url: 'https://watch.example/', title: 'Watch', text, elements: [] };
  const modelClient = async ({ prompt }) => { prompts.push(JSON.parse(prompt)); return { json: { action: { action: 'finish', success: true, say: 'Done.' } } }; };
  modelClient.promptBudget = async () => 1500;
  const result = await runAssistant({ text: 'open the settings menu', env: { provider: 'groq', model: 'm', key: 'k' },
    host: { observe: async () => page, execute: async () => ({ ok: true }) }, modelClient });
  assert.equal(result.ok, true);
  const sent = JSON.stringify(prompts[0].page).length;
  assert.ok(sent < 6000 && sent >= 1500, `page sent: ${sent} characters`);
  modelClient.promptBudget = async () => 10;
  prompts.length = 0;
  await runAssistant({ text: 'open the settings menu', env: { provider: 'groq', model: 'm', key: 'k' },
    host: { observe: async () => page, execute: async () => ({ ok: true }) }, modelClient });
  assert.ok(JSON.stringify(prompts[0].page).length >= 1400, 'The floor keeps a usable page');
});
